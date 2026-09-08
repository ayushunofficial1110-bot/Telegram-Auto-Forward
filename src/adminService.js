const User = require('../models/User');
const ForwardRule = require('../models/ForwardRule');
const ProcessedMessage = require('../models/ProcessedMessage');
const PromotionHistory = require('../models/PromotionHistory');
const Referral = require('../models/Referral');
const { isChannelAdFree } = require('./referralEngine');

/**
 * Checks if a user is an authorized administrator.
 */
function isUserAdmin(userId, userDoc) {
  const envAdmin = (process.env.ADMIN_TELEGRAM_ID || process.env.ADMIN_ID || '').trim();
  if (envAdmin) {
    const adminIds = envAdmin.split(',').map(s => s.trim()).filter(Boolean);
    if (adminIds.includes(String(userId))) {
      return true;
    }
  }
  if (userDoc && userDoc.isAdmin) {
    return true;
  }
  return false;
}

/**
 * Gathers system statistics for the Admin Statistics dashboard.
 */
async function getSystemStatistics() {
  const now = new Date();
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [
    totalUsers,
    newUsers24h,
    totalRules,
    activeRules,
    totalProcessed,
    totalReferrals,
    completedReferrals,
    lifetimeAdFreeCount,
    activeAdFreeCount
  ] = await Promise.all([
    User.countDocuments().catch(() => 0),
    User.countDocuments({ createdAt: { $gte: dayAgo } }).catch(() => 0),
    ForwardRule.countDocuments().catch(() => 0),
    ForwardRule.countDocuments({ active: true }).catch(() => 0),
    ProcessedMessage.countDocuments().catch(() => 0),
    Referral.countDocuments().catch(() => 0),
    Referral.countDocuments({ status: { $in: ['successful', 'completed'] } }).catch(() => 0),
    User.countDocuments({ isLifetimeAdFree: true }).catch(() => 0),
    User.countDocuments({
      isLifetimeAdFree: false,
      adFreeUntil: { $gt: now }
    }).catch(() => 0)
  ]);

  const channelAudit = await getChannelAuditList();
  const eligibleChannels = channelAudit.filter(c => c.isEligible).length;
  const skippedChannels = channelAudit.filter(c => !c.isEligible).length;

  return {
    users: {
      total: totalUsers,
      new24h: newUsers24h,
      lifetimeAdFree: lifetimeAdFreeCount,
      activeAdFree: activeAdFreeCount
    },
    rules: {
      total: totalRules,
      active: activeRules
    },
    channels: {
      total: channelAudit.length,
      eligibleForPromo: eligibleChannels,
      skippedPromo: skippedChannels
    },
    referrals: {
      total: totalReferrals,
      completed: completedReferrals,
      pending: totalReferrals - completedReferrals
    },
    processedMessages: totalProcessed
  };
}

/**
 * Audits all unique destination channels and determines eligibility for promotions.
 */
async function getChannelAuditList() {
  const rules = await ForwardRule.find().sort({ createdAt: -1 });
  const uniqueChannelsMap = new Map();

  for (const rule of rules) {
    const key = rule.destinationChannelId || rule.destinationChannelUsername;
    if (!key) continue;

    if (!uniqueChannelsMap.has(key)) {
      uniqueChannelsMap.set(key, rule);
    }
  }

  const channelList = [];

  for (const [channelKey, rule] of uniqueChannelsMap.entries()) {
    const owner = await User.findOne({ telegramUserId: rule.userId });
    const adFreeCheck = isChannelAdFree(owner, rule);

    channelList.push({
      channelKey,
      channelId: rule.destinationChannelId,
      channelUsername: rule.destinationChannelUsername,
      ownerId: rule.userId,
      ownerUsername: owner ? owner.username : null,
      isRuleActive: rule.active,
      platformPromotionsEnabled: rule.platformPromotionsEnabled,
      isEligible: !adFreeCheck.adFree && rule.active,
      skipReason: adFreeCheck.adFree ? adFreeCheck.reason : (!rule.active ? 'Rule is paused' : null)
    });
  }

  return channelList;
}

/**
 * Helper to pause execution.
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Sends a message payload (text, photo, video, document) with safe error handling and flood wait recovery.
 */
async function sendPayloadSafely(bot, targetChatId, payload) {
  const type = payload.type || 'text';
  const options = payload.options || {};

  try {
    if (type === 'text') {
      return await bot.sendMessage(targetChatId, payload.text, {
        parse_mode: 'HTML',
        ...options
      });
    } else if (type === 'photo') {
      return await bot.sendPhoto(targetChatId, payload.fileId, {
        caption: payload.caption || undefined,
        parse_mode: 'HTML',
        ...options
      });
    } else if (type === 'video') {
      return await bot.sendVideo(targetChatId, payload.fileId, {
        caption: payload.caption || undefined,
        parse_mode: 'HTML',
        ...options
      });
    } else if (type === 'document') {
      return await bot.sendDocument(targetChatId, payload.fileId, {
        caption: payload.caption || undefined,
        parse_mode: 'HTML',
        ...options
      });
    }
    return null;
  } catch (err) {
    const errMsg = err.message || '';
    // Handle Telegram 429 Flood Wait
    if (errMsg.includes('FLOOD_WAIT') || errMsg.includes('429')) {
      const waitMatch = errMsg.match(/retry after (\d+)/i) || errMsg.match(/FLOOD_WAIT_(\d+)/i);
      const waitSeconds = waitMatch ? parseInt(waitMatch[1], 10) : 5;
      console.warn(`[BROADCAST] Flood wait encountered. Pausing for ${waitSeconds}s...`);
      await sleep((waitSeconds + 1) * 1000);

      // Retry once after flood wait
      if (type === 'text') {
        return await bot.sendMessage(targetChatId, payload.text, { parse_mode: 'HTML', ...options });
      } else if (type === 'photo') {
        return await bot.sendPhoto(targetChatId, payload.fileId, { caption: payload.caption, parse_mode: 'HTML', ...options });
      } else if (type === 'video') {
        return await bot.sendVideo(targetChatId, payload.fileId, { caption: payload.caption, parse_mode: 'HTML', ...options });
      } else if (type === 'document') {
        return await bot.sendDocument(targetChatId, payload.fileId, { caption: payload.caption, parse_mode: 'HTML', ...options });
      }
    }
    throw err;
  }
}

/**
 * Executes a Broadcast to all bot users with rate limit pacing.
 */
async function executeBroadcast(bot, adminId, payload) {
  const users = await User.find({}, 'telegramUserId').lean();
  let sentCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  for (const user of users) {
    const targetChatId = user.telegramUserId;
    if (!targetChatId) {
      skippedCount++;
      continue;
    }

    try {
      await sendPayloadSafely(bot, targetChatId, payload);
      sentCount++;
    } catch (err) {
      const msg = err.message || '';
      if (msg.includes('blocked') || msg.includes('not found') || msg.includes('deactivated')) {
        skippedCount++;
      } else {
        failedCount++;
      }
      console.warn(`[BROADCAST] Could not send to user ${targetChatId}:`, msg);
    }

    // Paced safe rate-limiting: 40ms interval (~25 requests/second)
    await sleep(40);
  }

  // Record broadcast history
  await PromotionHistory.create({
    type: 'broadcast_users',
    adminId: String(adminId),
    messageType: payload.type || 'text',
    content: {
      text: payload.text || '',
      caption: payload.caption || '',
      fileId: payload.fileId || null
    },
    targetCount: users.length,
    sentCount,
    failedCount,
    skippedCount
  }).catch(() => {});

  return {
    sentCount,
    failedCount,
    skippedCount,
    targetCount: users.length
  };
}

/**
 * Executes an Admin Promotion to participating destination channels.
 * Automatically skips channels that are Ad-Free or have Platform Promotions turned OFF.
 * Sends owner notification when successfully sent.
 */
async function executeChannelPromotion(bot, adminId, payload, targetChannelIds = null) {
  const channels = await getChannelAuditList();

  // Filter channels based on target selection if specified
  const filteredChannels = targetChannelIds && Array.isArray(targetChannelIds) && targetChannelIds.length > 0
    ? channels.filter(c => targetChannelIds.includes(c.channelKey) || targetChannelIds.includes(c.channelId))
    : channels;

  let sentCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  const skippedReasons = [];

  for (const item of filteredChannels) {
    // Check eligibility: ad-free, promo OFF, or paused
    if (!item.isEligible) {
      skippedCount++;
      skippedReasons.push({
        target: item.channelUsername || item.channelId,
        reason: item.skipReason || 'Ineligible'
      });
      console.log(`[PROMOTION] Skipped channel ${item.channelUsername || item.channelId}: ${item.skipReason}`);
      continue;
    }

    const targetChat = item.channelId || item.channelUsername;

    try {
      await sendPayloadSafely(bot, targetChat, payload);
      sentCount++;
      console.log(`[PROMOTION] Successfully published to ${item.channelUsername || item.channelId}`);

      // Owner Notification: Notify channel owner through bot as required by Rule 8
      if (item.ownerId) {
        const channelDisplay = item.channelUsername || item.channelId;
        const ownerNotify =
          `📢 <b>Platform Promotion Sent</b>\n\n` +
          `A promotional message has been published on your channel.\n\n` +
          `<b>Channel:</b>\n${channelDisplay}`;

        bot.sendMessage(item.ownerId, ownerNotify, { parse_mode: 'HTML' }).catch((err) => {
          console.warn(`[PROMOTION] Could not notify channel owner ${item.ownerId}:`, err.message);
        });
      }
    } catch (err) {
      failedCount++;
      console.error(`[PROMOTION] Error publishing to ${targetChat}:`, err.message);
    }

    // Rate limiting pacing for channels: 100ms interval
    await sleep(100);
  }

  // Record promotion history
  await PromotionHistory.create({
    type: 'promotion_channels',
    adminId: String(adminId),
    messageType: payload.type || 'text',
    content: {
      text: payload.text || '',
      caption: payload.caption || '',
      fileId: payload.fileId || null
    },
    targetCount: filteredChannels.length,
    sentCount,
    failedCount,
    skippedCount,
    skippedReasons
  }).catch(() => {});

  return {
    sentCount,
    failedCount,
    skippedCount,
    targetCount: filteredChannels.length,
    skippedReasons
  };
}

module.exports = {
  isUserAdmin,
  getSystemStatistics,
  getChannelAuditList,
  executeBroadcast,
  executeChannelPromotion,
  sendPayloadSafely
};
