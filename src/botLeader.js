const BotLock = require('../models/BotLock');
const { isDatabaseConnected } = require('./database');

const INSTANCE_ID = `${process.env.K_REVISION || 'inst'}_${process.pid}_${Math.random().toString(36).substring(2, 8)}`;
const LOCK_ID = 'telegram_bot_polling';
const HEARTBEAT_INTERVAL_MS = 10000;
const STALE_THRESHOLD_MS = 25000;
const CONFLICT_BACKOFF_MS = 30000;

let botInstance = null;
let electionTimer = null;
let isCurrentlyLeader = false;
let backoffUntil = 0;

/**
 * Attempts to acquire or renew the polling leader lock in MongoDB.
 */
async function tryAcquireOrRenew() {
  if (Date.now() < backoffUntil) {
    return false;
  }

  if (!isDatabaseConnected()) {
    // If DB is not connected, assume standalone leader to allow polling
    return true;
  }

  const now = new Date();
  const staleDate = new Date(Date.now() - STALE_THRESHOLD_MS);

  try {
    // 1. Try to renew if already owned by this instance
    const renewed = await BotLock.findOneAndUpdate(
      { _id: LOCK_ID, instanceId: INSTANCE_ID },
      { lastHeartbeat: now },
      { returnDocument: 'after' }
    );

    if (renewed) {
      return true;
    }

    // 2. Try to acquire if previous lock is stale
    const acquiredStale = await BotLock.findOneAndUpdate(
      { _id: LOCK_ID, lastHeartbeat: { $lt: staleDate } },
      {
        instanceId: INSTANCE_ID,
        host: process.env.APP_URL || '',
        acquiredAt: now,
        lastHeartbeat: now
      },
      { returnDocument: 'after' }
    );

    if (acquiredStale) {
      console.log(`[BOT-LEADER] Stale lock claimed by instance ${INSTANCE_ID}`);
      return true;
    }

    // 3. Try to create new lock if none exists
    try {
      await BotLock.create({
        _id: LOCK_ID,
        instanceId: INSTANCE_ID,
        host: process.env.APP_URL || '',
        acquiredAt: now,
        lastHeartbeat: now
      });
      console.log(`[BOT-LEADER] Primary lock registered for instance ${INSTANCE_ID}`);
      return true;
    } catch (createErr) {
      if (createErr.code === 11000) {
        // Another instance acquired the lock first; this instance remains standby
        return false;
      }
      throw createErr;
    }
  } catch (err) {
    console.warn('[BOT-LEADER] Lock coordination notice:', err.message);
    return false;
  }
}

/**
 * Safely stops polling without triggering node-telegram-bot-api's lastRequest.cancel error.
 */
function safeStopPolling(bot) {
  if (!bot) return;
  if (bot._polling) {
    bot._polling._abort = true;
    if (bot._polling._pollingTimeout) {
      clearTimeout(bot._polling._pollingTimeout);
      bot._polling._pollingTimeout = null;
    }
  }
  try {
    bot.stopPolling().catch(() => {});
  } catch (_) {}
}

/**
 * Periodic leadership check.
 */
async function checkLeadership() {
  if (!botInstance) return;

  const shouldBeLeader = await tryAcquireOrRenew();

  if (shouldBeLeader && !isCurrentlyLeader) {
    isCurrentlyLeader = true;
    console.log(`[BOT-LEADER] Instance ${INSTANCE_ID} elected active polling leader. Starting bot polling...`);
    try {
      if (!botInstance.isPolling()) {
        await botInstance.startPolling({ restart: true });
        console.log('[BOT] Connected and polling...');
      }
    } catch (err) {
      console.warn('[BOT-LEADER] Polling start notice:', err.message);
    }
  } else if (!shouldBeLeader && isCurrentlyLeader) {
    isCurrentlyLeader = false;
    console.log(`[BOT-LEADER] Another instance is active leader. Instance ${INSTANCE_ID} standing by...`);
    safeStopPolling(botInstance);
  }
}

/**
 * Cedes leadership when 409 Conflict is received, pausing polling to prevent conflict loops.
 */
function cedeLeadership(reason = '409 Conflict') {
  console.warn(`[BOT-LEADER] Ceding polling leadership (${reason}). Backing off for ${CONFLICT_BACKOFF_MS / 1000}s...`);
  backoffUntil = Date.now() + CONFLICT_BACKOFF_MS;
  isCurrentlyLeader = false;

  safeStopPolling(botInstance);

  if (isDatabaseConnected()) {
    BotLock.updateOne(
      { _id: LOCK_ID, instanceId: INSTANCE_ID },
      { lastHeartbeat: new Date(0) }
    ).catch(() => {});
  }
}

/**
 * Starts the distributed leader election loop and installs the polling safeguard.
 */
function startLeaderElection(bot) {
  botInstance = bot;

  // Intercept getUpdates to prevent multiple instances from sending concurrent requests to Telegram
  if (typeof bot.getUpdates === 'function') {
    const origGetUpdates = bot.getUpdates.bind(bot);

    bot.getUpdates = async function (form) {
      // If this instance is standing by or in 409 backoff, yield immediately without hitting Telegram
      if (!isCurrentlyLeader || Date.now() < backoffUntil) {
        return [];
      }

      try {
        return await origGetUpdates(form);
      } catch (err) {
        const errMsg = err.message || '';
        const statusCode = err.response && err.response.statusCode;

        if (statusCode === 409 || errMsg.includes('409 Conflict')) {
          cedeLeadership('409 Conflict in getUpdates');
          return [];
        }
        throw err;
      }
    };
  }

  // Delay initial check slightly to let database connection initialize
  setTimeout(checkLeadership, 1000);
  if (electionTimer) clearInterval(electionTimer);
  electionTimer = setInterval(checkLeadership, HEARTBEAT_INTERVAL_MS);
}

/**
 * Cleans up lock on graceful shutdown.
 */
function stopLeaderElection() {
  if (electionTimer) clearInterval(electionTimer);
  if (isCurrentlyLeader && isDatabaseConnected()) {
    BotLock.deleteOne({ _id: LOCK_ID, instanceId: INSTANCE_ID }).catch(() => {});
  }
}

process.on('SIGTERM', stopLeaderElection);
process.on('SIGINT', stopLeaderElection);

module.exports = {
  startLeaderElection,
  stopLeaderElection,
  cedeLeadership,
  isLeader: () => isCurrentlyLeader,
  getInstanceId: () => INSTANCE_ID
};
