const User = require('../models/User');
const Referral = require('../models/Referral');
const { getMilestoneReward, notifyAdmins } = require('./referralEngine');

const REFERRAL_AD_FREE_THRESHOLD = parseInt(process.env.REFERRAL_AD_FREE_THRESHOLD || '2', 10);
let cronIntervalHandle = null;
let changeStreamActive = false;
let botRef = null;

function setBotForWatcher(botInstance) {
  if (botInstance) {
    botRef = botInstance;
  }
}

/**
 * Checks a specific user's referral counts and automatically sets 'adsFree' flag to true in MongoDB
 * when the threshold is met, updating user's interface status.
 *
 * @param {string} userId - Telegram User ID
 * @param {object} botInstance - Optional Telegram bot instance for dispatching UI notifications
 * @returns {Promise<object|null>} Updated user document or null
 */
async function checkUserReferralAndSetAdsFree(userId, botInstance = botRef) {
  if (!userId) return null;
  const strUserId = String(userId);

  try {
    const user = await User.findOne({ telegramUserId: strUserId });
    if (!user) return null;

    // 1. Calculate actual completed/successful referrals from MongoDB Referral collection
    const completedCount = await Referral.countDocuments({
      $or: [
        { referrerUserId: strUserId },
        { referrerId: strUserId }
      ],
      status: { $in: ['successful', 'completed'] }
    });

    const previousCount = user.referralCount || 0;
    const effectiveCount = Math.max(previousCount, completedCount);
    let isChanged = false;

    if (user.referralCount !== effectiveCount) {
      user.referralCount = effectiveCount;
      isChanged = true;
    }

    // 2. Evaluate threshold and ad-free eligibility
    const thresholdMet = effectiveCount >= REFERRAL_AD_FREE_THRESHOLD;
    const now = new Date();
    const hasActiveTime = user.adFreeUntil && new Date(user.adFreeUntil) > now;
    const isLifetime = !!user.isLifetimeAdFree;
    const shouldBeAdsFree = thresholdMet || isLifetime || hasActiveTime;

    const wasAdsFree = !!user.adsFree;

    if (shouldBeAdsFree) {
      if (!user.adsFree) {
        user.adsFree = true;
        isChanged = true;
      }

      // If threshold is met and user doesn't have active ad-free time or lifetime, apply milestone reward
      if (thresholdMet && !isLifetime && !hasActiveTime) {
        const reward = getMilestoneReward(0, effectiveCount);
        if (reward.isLifetime) {
          user.isLifetimeAdFree = true;
          isChanged = true;
        } else if (reward.daysToAdd > 0) {
          user.adFreeUntil = new Date(Date.now() + reward.daysToAdd * 24 * 60 * 60 * 1000);
          isChanged = true;
        } else {
          // Default at least 7 days for threshold
          user.adFreeUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
          isChanged = true;
        }
      }
    } else {
      // Threshold not met, not lifetime, and time expired
      if (user.adsFree) {
        user.adsFree = false;
        isChanged = true;
      }
    }

    if (isChanged) {
      user.updatedAt = new Date();
      await user.save();
      console.log(`[REFERRAL WATCHER] User ${strUserId}: referralCount=${effectiveCount}, adsFree=${user.adsFree}, thresholdMet=${thresholdMet}`);

      // If user transitioned from adsFree: false to adsFree: true, send UI notification
      if (!wasAdsFree && user.adsFree && botInstance) {
        const d = user.adFreeUntil ? new Date(user.adFreeUntil).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : null;
        const durationInfo = user.isLifetimeAdFree ? 'Lifetime Ad-Free' : (d ? `Active until ${d}` : 'Active');

        const notifyMsg =
          `🎉 <b>Ad-Free Status Activated!</b>\n\n` +
          `Aapke referrals threshold (<b>${effectiveCount} referrals</b>) reach ho chuka hai!\n\n` +
          `🛡 <b>adsFree: true</b> flag MongoDB me automatically activate kar diya gaya hai.\n` +
          `Duration: <b>${durationInfo}</b>\n\n` +
          `Aapke destination channels par platform promotional advertisements block ho gaye hain! 🚀\n\n` +
          `Check your updated status in /menu ➔ 🎁 Refer & Get Ad-Free.`;

        botInstance.sendMessage(strUserId, notifyMsg, {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🎁 View Referral Status', callback_data: 'menu_referrals' }]
            ]
          }
        }).catch((err) => {
          console.warn(`[REFERRAL WATCHER] Could not send activation alert to ${strUserId}:`, err.message);
        });

        // Notify Admin
        const adminMsg =
          `🎯 <b>Ad-Free Threshold Reached</b>\n\n` +
          `User: ${user.username ? '@' + user.username : user.firstName || 'User'} (<code>${strUserId}</code>)\n` +
          `Referral Count: <b>${effectiveCount}</b> (Threshold: ${REFERRAL_AD_FREE_THRESHOLD})\n` +
          `adsFree flag: <b>true</b> in MongoDB\n` +
          `Status: <b>${durationInfo}</b>`;

        notifyAdmins(botInstance, adminMsg).catch(() => {});
      }
    }

    return user;
  } catch (err) {
    console.error(`[REFERRAL WATCHER] Error checking user ${strUserId}:`, err.message);
    return null;
  }
}

/**
 * Bulk runner that checks all referrers and users against the threshold,
 * synchronizing referral counts and setting adsFree flag in MongoDB.
 */
async function runReferralCheck(botInstance = botRef) {
  try {
    // 1. Group all completed referrals by referrer ID
    const referralGroups = await Referral.aggregate([
      { $match: { status: { $in: ['successful', 'completed'] } } },
      {
        $group: {
          _id: { $ifNull: ['$referrerUserId', '$referrerId'] },
          count: { $sum: 1 }
        }
      }
    ]);

    const checkedIds = new Set();

    for (const group of referralGroups) {
      const referrerId = group._id;
      if (!referrerId || referrerId.startsWith('test_')) continue;
      checkedIds.add(String(referrerId));
      await checkUserReferralAndSetAdsFree(referrerId, botInstance);
    }

    // 2. Also check any users who have adsFree=true, high referral counts, or adFreeUntil to handle expirations/updates
    const usersWithFlags = await User.find({
      $or: [
        { adsFree: true },
        { referralCount: { $gte: REFERRAL_AD_FREE_THRESHOLD } },
        { isLifetimeAdFree: true },
        { adFreeUntil: { $ne: null } }
      ]
    }).select('telegramUserId');

    for (const u of usersWithFlags) {
      if (!checkedIds.has(String(u.telegramUserId))) {
        await checkUserReferralAndSetAdsFree(u.telegramUserId, botInstance);
      }
    }

    return { success: true, processedGroups: referralGroups.length };
  } catch (err) {
    console.error('[REFERRAL WATCHER] Error in runReferralCheck:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Starts the periodic cron job checking user referral counts.
 * Runs every intervalMs (default: 60 seconds).
 */
function startReferralCron(botInstance = botRef, intervalMs = 60000) {
  if (cronIntervalHandle) {
    clearInterval(cronIntervalHandle);
    cronIntervalHandle = null;
  }

  setBotForWatcher(botInstance);

  // Run immediate sync on start
  runReferralCheck(botInstance).then((res) => {
    console.log(`[REFERRAL CRON] Initial referral counts & adsFree check completed (${res.processedGroups || 0} referrers evaluated).`);
  }).catch((err) => {
    console.warn('[REFERRAL CRON] Initial referral check error:', err.message);
  });

  cronIntervalHandle = setInterval(() => {
    runReferralCheck(botInstance).catch((err) => {
      console.warn('[REFERRAL CRON] Periodic check error:', err.message);
    });
  }, intervalMs);

  if (cronIntervalHandle.unref) {
    cronIntervalHandle.unref();
  }

  console.log(`[REFERRAL CRON] Cron job started (interval: ${intervalMs / 1000}s, threshold: ${REFERRAL_AD_FREE_THRESHOLD})`);
}

/**
 * Starts database listener using MongoDB Change Streams (if supported by MongoDB deployment).
 * Gracefully falls back to the cron job if ChangeStreams are not supported on the MongoDB topology.
 */
function startDatabaseListener(botInstance = botRef) {
  setBotForWatcher(botInstance);

  if (changeStreamActive) return;

  try {
    // 1. Watch Referral collection for changes
    const referralStream = Referral.watch([], { fullDocument: 'updateLookup' });
    referralStream.on('change', async (change) => {
      try {
        const doc = change.fullDocument;
        const referrerId = doc ? (doc.referrerUserId || doc.referrerId) : null;
        if (referrerId) {
          await checkUserReferralAndSetAdsFree(referrerId, botInstance);
        }
      } catch (err) {
        console.warn('[REFERRAL LISTENER] Error handling referral change event:', err.message);
      }
    });

    referralStream.on('error', (streamErr) => {
      console.log(`[REFERRAL LISTENER] Referral change stream notice (${streamErr.message}). Continuing with cron job.`);
    });

    // 2. Watch User collection for referralCount changes
    const userStream = User.watch([], { fullDocument: 'updateLookup' });
    userStream.on('change', async (change) => {
      try {
        const doc = change.fullDocument;
        if (doc && doc.telegramUserId) {
          await checkUserReferralAndSetAdsFree(doc.telegramUserId, botInstance);
        }
      } catch (err) {
        console.warn('[REFERRAL LISTENER] Error handling user change event:', err.message);
      }
    });

    userStream.on('error', (streamErr) => {
      console.log(`[REFERRAL LISTENER] User change stream notice (${streamErr.message}). Continuing with cron job.`);
    });

    changeStreamActive = true;
    console.log('[REFERRAL LISTENER] MongoDB ChangeStream listener active on Referral & User collections.');
  } catch (err) {
    console.log(`[REFERRAL LISTENER] MongoDB ChangeStreams not available on this connection (${err.message}). Scheduled cron job handles updates.`);
  }
}

/**
 * Initializes both the database listener and the periodic cron job.
 */
function initReferralWatcher(botInstance = null) {
  setBotForWatcher(botInstance);
  startReferralCron(botInstance);
  startDatabaseListener(botInstance);
}

module.exports = {
  REFERRAL_AD_FREE_THRESHOLD,
  checkUserReferralAndSetAdsFree,
  runReferralCheck,
  startReferralCron,
  startDatabaseListener,
  initReferralWatcher,
  setBotForWatcher
};
