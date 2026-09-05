const User = require('../models/User');
const Referral = require('../models/Referral');

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Parses and processes a referral link when a user sends /start ref_XXXX or /start XXXX
 * Immediately credits the referrer, updates milestone rewards, and notifies the referrer via Telegram bot message.
 */
async function recordReferralStart(referredUserId, startParam, botInstance = null, referredUserInfo = {}) {
  if (!startParam) return null;

  // Expected format: "ref_123456789", "ref123456789", or "123456789"
  const rawParam = String(startParam).trim();
  let cleanReferrerId = rawParam.replace(/^ref_?/i, '').trim();

  if (!cleanReferrerId) {
    return null;
  }

  // Prevent self-referrals
  if (cleanReferrerId === String(referredUserId)) {
    return { error: 'self_referral' };
  }

  try {
    // If cleanReferrerId is not numeric, try looking up user by username
    let referrerUser = null;
    if (/^\d+$/.test(cleanReferrerId)) {
      referrerUser = await User.findOne({ telegramUserId: cleanReferrerId });
    } else {
      referrerUser = await User.findOne({
        username: new RegExp(`^@?${cleanReferrerId}$`, 'i')
      });
      if (referrerUser) {
        cleanReferrerId = referrerUser.telegramUserId;
      } else {
        console.warn(`[REFERRAL] Referrer not found for param: ${cleanReferrerId}`);
        return { error: 'referrer_not_found' };
      }
    }

    // Double-check self-referral after username resolution
    if (cleanReferrerId === String(referredUserId)) {
      return { error: 'self_referral' };
    }

    // Check if referred user already has an assigned referrer
    const existingUser = await User.findOne({ telegramUserId: String(referredUserId) });
    if (existingUser && existingUser.referredBy) {
      return { error: 'already_referred', referrerId: existingUser.referredBy };
    }

    // Check if a referral record already exists for this referred user and was rewarded
    const existingReferral = await Referral.findOne({ referredId: String(referredUserId) });
    if (existingReferral && existingReferral.rewardApplied) {
      return { error: 'already_referred', referrerId: existingReferral.referrerId };
    }

    // 1. Create or update the completed referral record
    await Referral.findOneAndUpdate(
      { referredId: String(referredUserId) },
      {
        referrerId: cleanReferrerId,
        referredId: String(referredUserId),
        status: 'completed',
        rewardApplied: true,
        completedAt: new Date(),
        createdAt: new Date()
      },
      { upsert: true }
    );

    // 2. Update referred user's record with referredBy
    await User.findOneAndUpdate(
      { telegramUserId: String(referredUserId) },
      { referredBy: cleanReferrerId, updatedAt: new Date() },
      { upsert: true }
    );

    // 3. Increment referrer's count & calculate rewards
    if (!referrerUser) {
      referrerUser = await User.findOne({ telegramUserId: cleanReferrerId });
    }

    if (!referrerUser) {
      referrerUser = new User({
        telegramUserId: cleanReferrerId,
        referralCount: 0,
        createdAt: new Date()
      });
    }

    const prevCount = referrerUser.referralCount || 0;
    const newCount = prevCount + 1;
    referrerUser.referralCount = newCount;

    const reward = getMilestoneReward(prevCount, newCount);

    if (reward.isLifetime) {
      referrerUser.isLifetimeAdFree = true;
    } else if (reward.daysToAdd > 0) {
      const now = Date.now();
      const currentExpiry = referrerUser.adFreeUntil ? new Date(referrerUser.adFreeUntil).getTime() : now;
      const baseTime = currentExpiry > now ? currentExpiry : now;
      referrerUser.adFreeUntil = new Date(baseTime + reward.daysToAdd * 24 * 60 * 60 * 1000);
    }

    referrerUser.updatedAt = new Date();
    await referrerUser.save();

    console.log(`[REFERRAL] Successfully credited referral: Referrer ${cleanReferrerId} <- Referred ${referredUserId}. New Total: ${newCount}`);

    // 4. Send Instant Telegram Notification Message to Referrer
    if (botInstance) {
      try {
        const referredDisplayName = referredUserInfo.firstName ||
          (referredUserInfo.username ? `@${referredUserInfo.username}` : `User ${referredUserId}`);
        const statusLabel = getAdFreeStatusLabel(referrerUser);

        let milestoneText = '';
        if (reward.tierLabel) {
          milestoneText = `\n\n🎁 <b>New Milestone Unlocked:</b> ${reward.tierLabel}!`;
        }

        const notifyMsg =
          `🎉 <b>New Referral Alert!</b>\n\n` +
          `User <b>${escapeHtml(referredDisplayName)}</b> has joined using your referral link!${milestoneText}\n\n` +
          `👥 <b>Your Total Referrals:</b> <b>${newCount}</b>\n` +
          `🛡 <b>Ad-Free Status:</b> ${escapeHtml(statusLabel)}\n\n` +
          `<i>Keep sharing your referral link to unlock more Ad-Free rewards!</i>`;

        botInstance.sendMessage(cleanReferrerId, notifyMsg, {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '👥 View Referrals', callback_data: 'menu_referrals' }]
            ]
          }
        }).then(() => {
          console.log(`[REFERRAL] Notification message sent to referrer ${cleanReferrerId}`);
        }).catch((sendErr) => {
          console.warn(`[REFERRAL] Could not send message to referrer ${cleanReferrerId}:`, sendErr.message);
        });
      } catch (notifyErr) {
        console.error('[REFERRAL] Error building notification message:', notifyErr.message);
      }
    }

    return {
      success: true,
      referrerId: cleanReferrerId,
      referrerName: referrerUser.firstName || (referrerUser.username ? `@${referrerUser.username}` : null),
      newCount
    };
  } catch (err) {
    console.error('[REFERRAL] Error recording referral start:', err.message);
    return { error: err.message };
  }
}

/**
 * Calculates milestone reward additions based on referral count.
 * Milestones:
 *   2  referrals -> 1 week (7 days)
 *   5  referrals -> 3 weeks (21 days)
 *   10 referrals -> 2 months (60 days)
 *   20 referrals -> 5 months (150 days)
 *   50 referrals -> Lifetime
 */
function getMilestoneReward(previousCount, newCount) {
  if (newCount >= 50) {
    return { isLifetime: true, daysToAdd: 0, tierLabel: 'Lifetime Ad-Free' };
  }
  if (newCount >= 20 && previousCount < 20) {
    return { isLifetime: false, daysToAdd: 150, tierLabel: '5 Months Ad-Free' };
  }
  if (newCount >= 10 && previousCount < 10) {
    return { isLifetime: false, daysToAdd: 60, tierLabel: '2 Months Ad-Free' };
  }
  if (newCount >= 5 && previousCount < 5) {
    return { isLifetime: false, daysToAdd: 21, tierLabel: '3 Weeks Ad-Free' };
  }
  if (newCount >= 2 && previousCount < 2) {
    return { isLifetime: false, daysToAdd: 7, tierLabel: '1 Week Ad-Free' };
  }
  return { isLifetime: false, daysToAdd: 0, tierLabel: null };
}

/**
 * Marks a referral as successful when the referred user completes basic setup (activates their first rule).
 */
async function completeReferralIfPending(referredUserId, botInstance) {
  try {
    const referral = await Referral.findOne({
      referredId: String(referredUserId),
      status: 'pending',
      rewardApplied: false
    });

    if (!referral) {
      return null;
    }

    // Mark referral completed to prevent duplicate rewards
    referral.status = 'completed';
    referral.rewardApplied = true;
    referral.completedAt = new Date();
    await referral.save();

    // Mark referred user's setup as completed
    await User.findOneAndUpdate(
      { telegramUserId: String(referredUserId) },
      { setupCompleted: true }
    );

    // Increment referrer's count and calculate rewards
    const referrer = await User.findOne({ telegramUserId: referral.referrerId });
    if (!referrer) {
      return referral;
    }

    const prevCount = referrer.referralCount || 0;
    const newCount = prevCount + 1;
    referrer.referralCount = newCount;

    const reward = getMilestoneReward(prevCount, newCount);

    if (reward.isLifetime) {
      referrer.isLifetimeAdFree = true;
    } else if (reward.daysToAdd > 0) {
      const now = Date.now();
      const currentExpiry = referrer.adFreeUntil ? new Date(referrer.adFreeUntil).getTime() : now;
      const baseTime = currentExpiry > now ? currentExpiry : now;
      referrer.adFreeUntil = new Date(baseTime + reward.daysToAdd * 24 * 60 * 60 * 1000);
    }

    referrer.updatedAt = new Date();
    await referrer.save();

    console.log(`[REFERRAL] Completed referral: ${referral.referrerId} <- ${referredUserId}. Total referrals: ${newCount}`);

    // Notify referrer through bot if botInstance is available
    if (botInstance) {
      const statusLabel = getAdFreeStatusLabel(referrer);
      let rewardText = '';
      if (reward.tierLabel) {
        rewardText = `\n🎁 <b>New Milestone Unlocked:</b> ${reward.tierLabel}!`;
      }

      const notifyMsg =
        `🎉 <b>Successful Referral!</b>\n\n` +
        `A user you invited has completed their bot setup and created their first auto-forward rule.${rewardText}\n\n` +
        `👥 <b>Total Referrals:</b> ${newCount}\n` +
        `🛡 <b>Ad-Free Status:</b> ${statusLabel}\n\n` +
        `Thank you for helping grow Auto Reposter!`;

      botInstance.sendMessage(referral.referrerId, notifyMsg, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '👥 View Referrals', callback_data: 'menu_referrals' }]
          ]
        }
      }).catch((sendErr) => {
        console.warn(`[REFERRAL] Could not send reward notification to ${referral.referrerId}:`, sendErr.message);
      });
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

  // 3. User ad-free reward status
  if (userDoc) {
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

module.exports = {
  recordReferralStart,
  completeReferralIfPending,
  getAdFreeStatusLabel,
  isChannelAdFree,
  getMilestoneReward
};
