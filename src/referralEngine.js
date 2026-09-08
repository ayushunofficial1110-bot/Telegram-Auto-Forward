const User = require('../models/User');
const Referral = require('../models/Referral');
const ForwardRule = require('../models/ForwardRule');

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Returns all configured admin Telegram user IDs from env and DB.
 */
async function getAdminTelegramUserIds() {
  const adminIds = new Set();
  const envAdmin = (process.env.ADMIN_TELEGRAM_ID || process.env.ADMIN_ID || '').trim();
  if (envAdmin) {
    envAdmin.split(',').map(s => s.trim()).filter(Boolean).forEach(id => adminIds.add(id));
  }
  try {
    const adminUsers = await User.find({ isAdmin: true }).select('telegramUserId').lean();
    for (const u of adminUsers) {
      if (u.telegramUserId) adminIds.add(String(u.telegramUserId));
    }
  } catch (_) {}
  return Array.from(adminIds);
}

/**
 * Dispatches an HTML message to all authorized administrators.
 */
async function notifyAdmins(botInstance, messageHtml) {
  if (!botInstance) return;
  try {
    const adminIds = await getAdminTelegramUserIds();
    if (adminIds.length === 0) {
      console.log('[REFERRAL] No admin telegram IDs configured to receive notification.');
      return;
    }
    for (const adminId of adminIds) {
      await botInstance.sendMessage(adminId, messageHtml, {
        parse_mode: 'HTML'
      }).catch((sendErr) => {
        console.warn(`[REFERRAL] Failed to send admin notification to ${adminId}:`, sendErr.message);
      });
    }
  } catch (err) {
    console.error('[REFERRAL] Error notifying admins:', err.message);
  }
}

/**
 * Processes a referral when a user sends /start REF_XXXX or /start ref_XXXX
 * 
 * Rules:
 * - Counts referral IMMEDIATELY (no pending state).
 * - Prevents self-referral (referrer === referred).
 * - Prevents duplicate counting (a referred user is only counted once).
 * - Immediately increments referrer's referralCount by 1.
 * - Automatically applies milestone ad-free rewards in MongoDB (2 -> 1 week, 5 -> 3 weeks, 10 -> 2 months, 20 -> 5 months, 50 -> Lifetime).
 * - Dispatches instant notifications to Referrer and Admin.
 * - If milestone reached, notifies Referrer with clear confirmation: "Ab se 1 week tak ads nahi aayenge".
 */
async function recordReferralStart(referredUserId, startParam, botInstance = null, referredUserInfo = {}) {
  if (!startParam) return null;

  const rawParam = String(startParam).trim();
  const cleanReferrerId = rawParam.replace(/^ref_?/i, '').trim();

  if (!cleanReferrerId) {
    return null;
  }

  const strReferredId = String(referredUserId);

  // 1. Self-referral protection
  if (cleanReferrerId === strReferredId) {
    return { error: 'self_referral' };
  }

  try {
    // 2. Identify referrer by ID, username, or referral code
    let referrerUser = null;
    if (/^\d+$/.test(cleanReferrerId)) {
      referrerUser = await User.findOne({ telegramUserId: cleanReferrerId });
    }

    if (!referrerUser) {
      referrerUser = await User.findOne({
        $or: [
          { referralCode: new RegExp(`^${escapeRegex(rawParam)}$`, 'i') },
          { referralCode: new RegExp(`^REF_${escapeRegex(cleanReferrerId)}$`, 'i') },
          { username: new RegExp(`^@?${escapeRegex(cleanReferrerId)}$`, 'i') },
          { telegramUserId: cleanReferrerId }
        ]
      });
    }

    if (!referrerUser) {
      console.warn(`[REFERRAL] Referrer not found for param: ${cleanReferrerId}`);
      return { error: 'referrer_not_found' };
    }

    const resolvedReferrerId = String(referrerUser.telegramUserId);

    // Double-check self-referral after resolving user
    if (resolvedReferrerId === strReferredId) {
      return { error: 'self_referral' };
    }

    // 3. Duplicate referral protection: each user can only be referred once
    const existingReferral = await Referral.findOne({
      $or: [
        { referredUserId: strReferredId },
        { referredId: strReferredId }
      ]
    });

    if (existingReferral) {
      const existingRefId = existingReferral.referrerUserId || existingReferral.referrerId;
      console.log(`[REFERRAL] User ${strReferredId} was already referred previously by ${existingRefId}`);
      return { error: 'already_referred', referrerId: existingRefId };
    }

    // 4. Create COMPLETED referral record immediately in MongoDB
    const normalizedCode = rawParam.toUpperCase().startsWith('REF_')
      ? rawParam.toUpperCase()
      : `REF_${resolvedReferrerId}`;

    await Referral.create({
      referrerId: resolvedReferrerId,
      referrerUserId: resolvedReferrerId,
      referredId: strReferredId,
      referredUserId: strReferredId,
      referralCode: normalizedCode,
      status: 'completed',
      rewardApplied: true,
      completedAt: new Date(),
      createdAt: new Date()
    });

    // Update referred user's record with referredBy
    await User.findOneAndUpdate(
      { telegramUserId: strReferredId },
      { referredBy: resolvedReferrerId, updatedAt: new Date() },
      { upsert: true }
    );

    // 5. Immediately increment referrer's referralCount
    const prevCount = referrerUser.referralCount || 0;
    const newCount = prevCount + 1;
    referrerUser.referralCount = newCount;

    // 6. Check milestone rewards and automatically apply Ad-Free
    const reward = getMilestoneReward(prevCount, newCount);

    if (reward.milestoneReached) {
      if (reward.isLifetime) {
        referrerUser.isLifetimeAdFree = true;
      } else if (reward.daysToAdd > 0) {
        const now = Date.now();
        const currentExpiry = referrerUser.adFreeUntil ? new Date(referrerUser.adFreeUntil).getTime() : now;
        const baseTime = currentExpiry > now ? currentExpiry : now;
        referrerUser.adFreeUntil = new Date(baseTime + reward.daysToAdd * 24 * 60 * 60 * 1000);
      }
    }

    if (newCount >= 2 || referrerUser.isLifetimeAdFree || (referrerUser.adFreeUntil && new Date(referrerUser.adFreeUntil) > new Date())) {
      referrerUser.adsFree = true;
    }

    referrerUser.updatedAt = new Date();
    await referrerUser.save();

    console.log(`[REFERRAL] Successful referral registered immediately: ${resolvedReferrerId} <- ${strReferredId}, total: ${newCount}, milestone: ${reward.tierLabel || 'None'}`);

    // Prepare profile info for messages
    const referredName = (referredUserInfo && referredUserInfo.firstName) || 'User';
    const referredUsername = (referredUserInfo && referredUserInfo.username) || null;
    const referredDisplayName = referredUsername ? `@${referredUsername}` : (referredName || `User ${strReferredId}`);

    const referrerName = referrerUser.firstName || 'User';
    const referrerUsername = referrerUser.username || null;
    const currentRewardStatus = getCurrentRewardText(referrerUser, reward);
    const nextMilestone = getNextMilestoneText(newCount);

    // 7. Send Immediate Telegram Notifications
    if (botInstance) {
      // --- NOTIFY REFERRER ---
      const referrerNotifyMsg =
        `🎉 <b>New Referral!</b>\n\n` +
        `<b>${escapeHtml(referredDisplayName)}</b> has joined Auto Reposter using your referral link!\n\n` +
        `👥 <b>Successful Referrals:</b> <b>${newCount}</b>\n\n` +
        `🎁 <b>Current Reward:</b>\n` +
        `${escapeHtml(currentRewardStatus)}\n\n` +
        `<b>Next milestone:</b>\n` +
        `${escapeHtml(nextMilestone)}\n\n` +
        `Keep sharing! 🚀`;

      await botInstance.sendMessage(resolvedReferrerId, referrerNotifyMsg, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🎁 Refer & Get Ad-Free', callback_data: 'menu_referrals' }]
          ]
        }
      }).catch((sendErr) => {
        console.warn(`[REFERRAL] Could not send message to referrer ${resolvedReferrerId}:`, sendErr.message);
      });

      // --- IF MILESTONE REACHED, NOTIFY REFERRER WITH SPECIAL UNLOCK MESSAGE ---
      if (reward.milestoneReached) {
        let hindiNotice = '';
        if (newCount >= 50) {
          hindiNotice = '⚡ <b>Aapko Lifetime Ad-Free status mil chuka hai! Aapke channels par kabhi promotional ads nahi aayenge!</b>';
        } else if (newCount >= 20) {
          hindiNotice = '⚡ <b>Ab se 5 months tak aapke channels par koi promotional ads nahi aayenge!</b>';
        } else if (newCount >= 10) {
          hindiNotice = '⚡ <b>Ab se 2 months tak aapke channels par koi promotional ads nahi aayenge!</b>';
        } else if (newCount >= 5) {
          hindiNotice = '⚡ <b>Ab se 3 weeks tak aapke channels par koi promotional ads nahi aayenge!</b>';
        } else if (newCount >= 2) {
          hindiNotice = '⚡ <b>Ab se 1 week (7 days) tak aapke channels par koi ads / promotions nahi aayenge!</b>';
        }

        const milestoneUserMsg =
          `🎉 <b>Referral Reward Unlocked!</b>\n\n` +
          `Aapne <b>${newCount} successful referrals</b> complete kar liye hain!\n\n` +
          `🎁 <b>Reward:</b> <b>${reward.tierLabel}</b>\n\n` +
          `${hindiNotice}\n\n` +
          `🛡 Ad-Free status automatically activate ho gaya hai.\n\n` +
          `<b>Next milestone:</b>\n` +
          `${escapeHtml(nextMilestone)}`;

        await botInstance.sendMessage(resolvedReferrerId, milestoneUserMsg, {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🎁 Refer & Get Ad-Free', callback_data: 'menu_referrals' }]
            ]
          }
        }).catch((sendErr) => {
          console.warn(`[REFERRAL] Could not send milestone message to referrer ${resolvedReferrerId}:`, sendErr.message);
        });
      }

      // --- NOTIFY ADMIN ---
      const adminNotifyMsg =
        `🎯 <b>New Referral Alert</b>\n\n` +
        `👤 <b>Referrer:</b>\n` +
        `Name: ${escapeHtml(referrerName)}\n` +
        `Username: ${referrerUsername ? '@' + escapeHtml(referrerUsername) : 'None'}\n` +
        `Telegram ID: <code>${resolvedReferrerId}</code>\n\n` +
        `👥 <b>Referred User:</b>\n` +
        `Name: ${escapeHtml(referredName)}\n` +
        `Username: ${referredUsername ? '@' + escapeHtml(referredUsername) : 'None'}\n` +
        `Telegram ID: <code>${strReferredId}</code>\n\n` +
        `🔗 <b>Referral Code:</b>\n` +
        `<code>${escapeHtml(normalizedCode)}</code>\n\n` +
        `📊 <b>Referrer's Total Referrals:</b> <b>${newCount}</b>\n\n` +
        `🎁 <b>Current Reward:</b>\n` +
        `${escapeHtml(currentRewardStatus)}`;

      await notifyAdmins(botInstance, adminNotifyMsg);

      if (reward.milestoneReached) {
        const milestoneAdminMsg =
          `🎁 <b>Referral Reward Unlocked</b>\n\n` +
          `👤 <b>User:</b> ${referrerUsername ? '@' + escapeHtml(referrerUsername) : escapeHtml(referrerName)}\n` +
          `Telegram ID: <code>${resolvedReferrerId}</code>\n` +
          `Successful Referrals: <b>${newCount}</b>\n` +
          `Reward: <b>${reward.tierLabel}</b> (Automatically Activated)`;

        await notifyAdmins(botInstance, milestoneAdminMsg);
      }
    }

    return {
      success: true,
      status: 'completed',
      referrerId: resolvedReferrerId,
      referrerName: referrerName,
      newCount,
      milestoneReward: reward.milestoneReached ? reward : null
    };
  } catch (err) {
    if (err.code === 11000) {
      console.log(`[REFERRAL] Duplicate referral registration prevented by unique index for user ${strReferredId}`);
      return { error: 'already_referred' };
    }
    console.error('[REFERRAL] Error recording referral start:', err.message);
    return { error: err.message };
  }
}

/**
 * Calculates milestone reward additions based on referral count.
 * Exact rewards structure:
 *   2  successful referrals = 1 week (7 days) ad-free
 *   5  successful referrals = 3 weeks (21 days) ad-free
 *   10 successful referrals = 2 months (60 days) ad-free
 *   20 successful referrals = 5 months (150 days) ad-free
 *   50 successful referrals = Lifetime ad-free
 */
function getMilestoneReward(previousCount, newCount) {
  if (newCount >= 50 && previousCount < 50) {
    return { milestoneReached: true, targetCount: 50, isLifetime: true, daysToAdd: 0, tierLabel: 'Lifetime Ad-Free' };
  }
  if (newCount >= 20 && previousCount < 20) {
    return { milestoneReached: true, targetCount: 20, isLifetime: false, daysToAdd: 150, tierLabel: '5 Months Ad-Free' };
  }
  if (newCount >= 10 && previousCount < 10) {
    return { milestoneReached: true, targetCount: 10, isLifetime: false, daysToAdd: 60, tierLabel: '2 Months Ad-Free' };
  }
  if (newCount >= 5 && previousCount < 5) {
    return { milestoneReached: true, targetCount: 5, isLifetime: false, daysToAdd: 21, tierLabel: '3 Weeks Ad-Free' };
  }
  if (newCount >= 2 && previousCount < 2) {
    return { milestoneReached: true, targetCount: 2, isLifetime: false, daysToAdd: 7, tierLabel: '7 Days Ad-Free' };
  }
  return { milestoneReached: false, targetCount: 0, isLifetime: false, daysToAdd: 0, tierLabel: null };
}

/**
 * Returns text describing the next upcoming reward milestone.
 */
function getNextMilestoneText(count) {
  if (count < 2) return '2 referrals → 7 Days Ad-Free';
  if (count < 5) return '5 referrals → 3 Weeks Ad-Free';
  if (count < 10) return '10 referrals → 2 Months Ad-Free';
  if (count < 20) return '20 referrals → 5 Months Ad-Free';
  if (count < 50) return '50 referrals → Lifetime Ad-Free';
  return 'All milestones unlocked! (Lifetime Ad-Free active)';
}

/**
 * Formats a description of the current reward status for a referrer.
 */
function getCurrentRewardText(userDoc, justUnlockedReward = null) {
  if (!userDoc) return 'Keep referring to unlock more ad-free time!';
  if (userDoc.isLifetimeAdFree) {
    return 'Lifetime Ad-Free';
  }
  if (justUnlockedReward && justUnlockedReward.milestoneReached && justUnlockedReward.tierLabel) {
    return justUnlockedReward.tierLabel;
  }
  if (userDoc.adFreeUntil && new Date(userDoc.adFreeUntil) > new Date()) {
    const d = new Date(userDoc.adFreeUntil);
    const dateStr = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    if (userDoc.referralCount >= 20) return `5 Months Ad-Free (Active until ${dateStr})`;
    if (userDoc.referralCount >= 10) return `2 Months Ad-Free (Active until ${dateStr})`;
    if (userDoc.referralCount >= 5) return `3 Weeks Ad-Free (Active until ${dateStr})`;
    if (userDoc.referralCount >= 2) return `7 Days Ad-Free (Active until ${dateStr})`;
    return `Ad-Free Active (Until ${dateStr})`;
  }
  if (userDoc.referralCount >= 50) return 'Lifetime Ad-Free';
  if (userDoc.referralCount >= 20) return '5 Months Ad-Free';
  if (userDoc.referralCount >= 10) return '2 Months Ad-Free';
  if (userDoc.referralCount >= 5) return '3 Weeks Ad-Free';
  if (userDoc.referralCount >= 2) return '7 Days Ad-Free';
  return 'Keep referring to unlock more ad-free time!';
}

/**
 * Marks a referral as successful when the referred user completes the bot setup (creates first forward rule).
 * 
 * Flow:
 * 1. Finds pending referral record for referredUserId.
 * 2. Marks status = 'successful' and rewardApplied = true (ensuring no duplicate completions).
 * 3. Increments referrer's referralCount by 1.
 * 4. Calculates milestone reward and applies ad-free extension if milestone reached.
 * 5. Sends instant Telegram notification to REFERRER.
 * 6. Sends instant Telegram notification to ADMIN.
 * 7. If milestone reached, sends reward unlock notification to REFERRER and to ADMIN.
 */
async function completeReferralIfPending(referredUserId, botInstance) {
  const strReferredId = String(referredUserId);

  try {
    // 1. Find pending referral
    const referral = await Referral.findOne({
      $or: [
        { referredUserId: strReferredId },
        { referredId: strReferredId }
      ],
      status: 'pending',
      rewardApplied: false
    });

    if (!referral) {
      // Either user wasn't referred, or setup was already completed in an earlier rule
      return null;
    }

    // 2. Mark referral as successful to prevent any duplicate counts
    referral.status = 'successful';
    referral.rewardApplied = true;
    referral.completedAt = new Date();
    await referral.save();

    // Mark referred user's setupCompleted flag
    await User.findOneAndUpdate(
      { telegramUserId: strReferredId },
      { setupCompleted: true, updatedAt: new Date() }
    );

    const referrerId = referral.referrerUserId || referral.referrerId;
    let referrer = await User.findOne({ telegramUserId: referrerId });
    if (!referrer) {
      referrer = new User({
        telegramUserId: referrerId,
        referralCount: 0,
        createdAt: new Date()
      });
    }

    // 3. Increment referrer's count
    const prevCount = referrer.referralCount || 0;
    const newCount = prevCount + 1;
    referrer.referralCount = newCount;

    // 4. Milestone Reward Calculation
    const reward = getMilestoneReward(prevCount, newCount);

    if (reward.milestoneReached) {
      if (reward.isLifetime) {
        referrer.isLifetimeAdFree = true;
      } else if (reward.daysToAdd > 0) {
        const now = Date.now();
        const currentExpiry = referrer.adFreeUntil ? new Date(referrer.adFreeUntil).getTime() : now;
        const baseTime = currentExpiry > now ? currentExpiry : now;
        referrer.adFreeUntil = new Date(baseTime + reward.daysToAdd * 24 * 60 * 60 * 1000);
      }
    }

    referrer.updatedAt = new Date();
    await referrer.save();

    console.log(`[REFERRAL] SUCCESSFUL! Referrer: ${referrerId}, Referred: ${strReferredId}, Total: ${newCount}, Milestone: ${reward.tierLabel || 'None'}`);

    // Fetch user profiles for clean notifications
    const referredUser = await User.findOne({ telegramUserId: strReferredId });
    const referredName = (referredUser && referredUser.firstName) ? referredUser.firstName : 'User';
    const referredUsername = (referredUser && referredUser.username) ? referredUser.username : null;
    const referredDisplayName = referredUsername ? `@${referredUsername}` : (referredName || `User ${strReferredId}`);

    const referrerName = referrer.firstName || 'User';
    const referrerUsername = referrer.username || null;
    const currentRewardStatus = getCurrentRewardText(referrer, reward);
    const nextMilestone = getNextMilestoneText(newCount);
    const referralCode = referral.referralCode || `REF_${referrerId}`;

    if (botInstance) {
      // ==================================================
      // 3. REFERRER USER NOTIFICATION
      // ==================================================
      const referrerNotifyMsg =
        `🎉 <b>New Successful Referral!</b>\n\n` +
        `<b>${escapeHtml(referredDisplayName)}</b> has successfully joined and completed the Auto Reposter setup through your referral link.\n\n` +
        `👥 <b>Successful Referrals:</b> <b>${newCount}</b>\n\n` +
        `🎁 <b>Current Reward:</b>\n` +
        `${escapeHtml(currentRewardStatus)}\n\n` +
        `<b>Next milestone:</b>\n` +
        `${escapeHtml(nextMilestone)}\n\n` +
        `Keep sharing! 🚀`;

      await botInstance.sendMessage(referrerId, referrerNotifyMsg, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🎁 Refer & Get Ad-Free', callback_data: 'menu_referrals' }]
          ]
        }
      }).catch((sendErr) => {
        console.warn(`[REFERRAL] Could not send message to referrer ${referrerId}:`, sendErr.message);
      });

      // ==================================================
      // 4. ADMIN NOTIFICATION (Section 4)
      // ==================================================
      const adminNotifyMsg =
        `🎯 <b>New Successful Referral</b>\n\n` +
        `👤 <b>Referrer:</b>\n` +
        `Name: ${escapeHtml(referrerName)}\n` +
        `Username: ${referrerUsername ? '@' + escapeHtml(referrerUsername) : 'None'}\n` +
        `Telegram ID: <code>${referrerId}</code>\n\n` +
        `👥 <b>Referred User:</b>\n` +
        `Name: ${escapeHtml(referredName)}\n` +
        `Username: ${referredUsername ? '@' + escapeHtml(referredUsername) : 'None'}\n` +
        `Telegram ID: <code>${strReferredId}</code>\n\n` +
        `🔗 <b>Referral Code:</b>\n` +
        `<code>${escapeHtml(referralCode)}</code>\n\n` +
        `📊 <b>Referrer's Total Successful Referrals:</b>\n` +
        `<b>${newCount}</b>\n\n` +
        `🎁 <b>Current Reward:</b>\n` +
        `${escapeHtml(currentRewardStatus)}`;

      await notifyAdmins(botInstance, adminNotifyMsg);

      // ==================================================
      // 5. REWARD MILESTONE NOTIFICATIONS (Section 5)
      // ==================================================
      if (reward.milestoneReached) {
        // Send milestone notification to Referrer
        const milestoneUserMsg =
          `🎉 <b>Referral Reward Unlocked!</b>\n\n` +
          `You reached <b>${newCount}</b> successful referrals.\n\n` +
          `🎁 <b>Reward:</b>\n` +
          `<b>${reward.tierLabel}</b>\n\n` +
          `Your ad-free period has been automatically added.\n\n` +
          `<b>Next milestone:</b>\n` +
          `${escapeHtml(nextMilestone)}`;

        await botInstance.sendMessage(referrerId, milestoneUserMsg, {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🎁 Refer & Get Ad-Free', callback_data: 'menu_referrals' }]
            ]
          }
        }).catch((sendErr) => {
          console.warn(`[REFERRAL] Could not send milestone message to referrer ${referrerId}:`, sendErr.message);
        });

        // Send milestone notification to Admin
        const milestoneAdminMsg =
          `🎁 <b>Referral Reward Unlocked</b>\n\n` +
          `User: ${referrerUsername ? '@' + escapeHtml(referrerUsername) : escapeHtml(referrerName)}\n` +
          `Successful Referrals: <b>${newCount}</b>\n` +
          `Reward: <b>${reward.tierLabel}</b>`;

        await notifyAdmins(botInstance, milestoneAdminMsg);
      }
    }

    return referral;
  } catch (err) {
    console.error('[REFERRAL] Error completing referral:', err.message);
    return null;
  }
}

/**
 * Formats a user-friendly label for a user's ad-free status.
 */
function getAdFreeStatusLabel(userDoc) {
  if (!userDoc) return 'Standard (Promotions Active)';
  if (userDoc.isLifetimeAdFree) {
    return '👑 Lifetime Ad-Free';
  }
  if (userDoc.adFreeUntil && new Date(userDoc.adFreeUntil) > new Date()) {
    const d = new Date(userDoc.adFreeUntil);
    const dateStr = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    return `🟢 Ad-Free Active (Until ${dateStr})`;
  }
  if (userDoc.adsFree) {
    return '🟢 Ad-Free Active (Threshold Met)';
  }
  return 'Standard (Promotions Active)';
}

/**
 * Checks whether a destination channel is eligible for promotional messages or skipped due to ad-free status / promo OFF.
 */
function isChannelAdFree(userDoc, ruleDoc) {
  // 1. Channel-level manual toggle
  if (ruleDoc && ruleDoc.platformPromotionsEnabled === false) {
    return { adFree: true, reason: 'Platform promotions toggled OFF for this channel' };
  }

  // 2. User-level manual toggle
  if (userDoc && userDoc.platformPromotionsEnabled === false) {
    return { adFree: true, reason: 'Platform promotions toggled OFF by channel owner' };
  }

  // 3. User ad-free flag in MongoDB / reward status
  if (userDoc) {
    if (userDoc.adsFree === true) {
      return { adFree: true, reason: 'Channel owner has adsFree status enabled in MongoDB' };
    }
    if (userDoc.isLifetimeAdFree) {
      return { adFree: true, reason: 'Channel owner has Lifetime Ad-Free status' };
    }
    if (userDoc.adFreeUntil && new Date(userDoc.adFreeUntil) > new Date()) {
      const d = new Date(userDoc.adFreeUntil);
      const dateStr = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
      return { adFree: true, reason: `Channel owner has active Ad-Free reward (until ${dateStr})` };
    }
  }

  return { adFree: false, reason: 'Eligible for promotions' };
}

function escapeRegex(string) {
  return String(string).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Automatically converts any legacy pending referral records to completed.
 */
async function migrateLegacyPendingReferrals() {
  try {
    const pending = await Referral.find({ status: 'pending' });
    if (pending && pending.length > 0) {
      console.log(`[REFERRAL] Migrating ${pending.length} pending referrals to completed status...`);
      for (const ref of pending) {
        ref.status = 'completed';
        ref.rewardApplied = true;
        ref.completedAt = new Date();
        await ref.save();
      }
    }
  } catch (err) {
    console.warn('[REFERRAL] Migration warning:', err.message);
  }
}

module.exports = {
  recordReferralStart,
  completeReferralIfPending,
  migrateLegacyPendingReferrals,
  getAdFreeStatusLabel,
  isChannelAdFree,
  getMilestoneReward,
  getNextMilestoneText,
  getCurrentRewardText,
  getAdminTelegramUserIds,
  notifyAdmins
};
