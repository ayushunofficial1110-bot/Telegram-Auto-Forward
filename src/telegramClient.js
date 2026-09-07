const { TelegramClient, sessions, events, Api } = require('teleproto');
const { StringSession } = sessions;
const { NewMessage } = events;

// Single shared client instance for the entire application process
let clientInstance = null;
let isInitializing = false;
let isConnected = false;
let isListenerStarted = false;
let initPromise = null;
let activeWatchDisposer = null;
let currentWatchedList = [];
let periodicSyncInterval = null;

/**
 * Normalizes a channel username or link to a clean identifier.
 */
function normalizeChannelIdentifier(input) {
  if (!input) return '';
  return String(input)
    .trim()
    .replace(/^https?:\/\/t\.me\//i, '')
    .replace(/^@/, '')
    .trim();
}

/**
 * Synchronizes active source channels with teleproto's watch mechanism so that
 * Telegram servers continuously stream live channel updates via getChannelDifference polling.
 *
 * @param {string[]} channelIdentifiers List of channel usernames or IDs
 */
async function syncWatchedChannels(channelIdentifiers) {
  if (!clientInstance || !isConnected) return;
  if (!Array.isArray(channelIdentifiers) || channelIdentifiers.length === 0) return;

  const cleanChannels = [];
  for (const item of channelIdentifiers) {
    const clean = normalizeChannelIdentifier(item);
    if (clean && !cleanChannels.includes(clean)) {
      cleanChannels.push(clean);
    }
  }

  if (cleanChannels.length === 0) return;

  // Check if identical to currently watched channels
  const isIdentical = cleanChannels.length === currentWatchedList.length &&
    cleanChannels.every(c => currentWatchedList.includes(c));
  if (isIdentical && activeWatchDisposer) {
    return;
  }

  // Pre-resolve and warm entity cache in client memory for each channel
  for (const ch of cleanChannels) {
    try {
      const entity = await clientInstance.getEntity(ch).catch(() => null);
      if (entity && entity.id && clientInstance.updateManager) {
        const channelIdStr = entity.id.toString();
        const input = await clientInstance.getInputEntity(entity).catch(() => null);
        if (input && input.channelId && input.accessHash) {
          await clientInstance.updateManager.watchChannel(channelIdStr, new Api.InputChannel({
            channelId: input.channelId,
            accessHash: input.accessHash
          })).catch(() => {});
        }
      }
    } catch (_) {
      // Individual channel pre-resolution failure should not halt the watch pipeline
    }
  }

  try {
    if (activeWatchDisposer) {
      try {
        activeWatchDisposer();
      } catch (_) {}
      activeWatchDisposer = null;
    }

    activeWatchDisposer = clientInstance.updates.watch(cleanChannels);
    currentWatchedList = cleanChannels;
    console.log(`[MTProto] Actively watching source channels for live posts: ${cleanChannels.map(c => `@${c}`).join(', ')}`);
  } catch (watchErr) {
    console.error('[ERROR] Failed to arm channel watches:', watchErr.message);
  }
}

/**
 * Initializes and connects the Telegram MTProto client.
 * Strictly enforces a singleton instance to prevent duplicate connections
 * sharing the same TELEGRAM_SESSION.
 *
 * @param {Function} onNewMessageCallback Handler for incoming channel messages
 */
async function initTelegramClient(onNewMessageCallback) {
  // If client is already initialized or currently initializing, skip duplicate startup
  if (clientInstance || isInitializing) {
    console.log('[MTProto] Already initialized - skipping duplicate startup');
    if (initPromise) {
      return initPromise;
    }
    return clientInstance;
  }

  // Prevent AI Studio dev sandbox from running a duplicate MTProto client that
  // invalidates the Render production session with AuthKeyDuplicatedError.
  const isAIStudioSandbox = Boolean(process.env.APPLET_ID || process.env.CONTROL_PLANE_PORT);
  if (isAIStudioSandbox && process.env.ENABLE_MTPROTO_IN_SANDBOX !== 'true') {
    console.log('[MTProto] Running in AI Studio sandbox container. MTProto client is disabled here to ensure Render deployment remains the sole active connection using TELEGRAM_SESSION.');
    return null;
  }

  if (process.env.DISABLE_MTPROTO === 'true') {
    console.log('[MTProto] MTProto client explicitly disabled via DISABLE_MTPROTO.');
    return null;
  }

  isInitializing = true;

  initPromise = (async () => {
    console.log('[MTProto] Initializing client...');

    const apiId = process.env.TELEGRAM_API_ID;
    const apiHash = process.env.TELEGRAM_API_HASH;
    const sessionString = process.env.TELEGRAM_SESSION;

    if (!apiId || !apiHash || !sessionString) {
      const missing = [];
      if (!apiId) missing.push('TELEGRAM_API_ID');
      if (!apiHash) missing.push('TELEGRAM_API_HASH');
      if (!sessionString) missing.push('TELEGRAM_SESSION');
      console.error(`[MTProto] Connection error: Missing required environment variable(s): ${missing.join(', ')}`);
      isInitializing = false;
      initPromise = null;
      return null;
    }

    try {
      const stringSession = new StringSession(sessionString.trim());
      const numericApiId = parseInt(apiId, 10);

      if (isNaN(numericApiId)) {
        throw new Error('TELEGRAM_API_ID must be a valid integer.');
      }

      // Instantiate exactly ONE TelegramClient instance
      clientInstance = new TelegramClient(stringSession, numericApiId, apiHash.trim(), {
        connectionRetries: 10,
        retryDelay: 3000,
        autoReconnect: true,
        useWSS: false,
        deviceModel: 'AutoReposter Server',
        systemVersion: 'NodeJS',
        appVersion: '1.0.0'
      });

      console.log('[MTProto] Connecting...');
      await clientInstance.connect();
      isConnected = true;
      console.log('[MTProto] Connected successfully');

      // Verify authorization and prime session with Telegram servers
      try {
        const me = await clientInstance.getMe();
        if (me) {
          const usernameStr = me.username ? `@${me.username}` : `ID ${me.id}`;
          console.log(`[MTProto] Session verified: ${me.firstName || ''} ${me.lastName || ''} (${usernameStr})`);
        }
      } catch (authErr) {
        console.warn('[MTProto] Session verification warning:', authErr.message);
      }

      // Register incoming message event handler exactly once
      if (!isListenerStarted && typeof onNewMessageCallback === 'function') {
        clientInstance.addEventHandler(async (event) => {
          try {
            if (event && event.message) {
              await onNewMessageCallback(event.message, clientInstance);
            }
          } catch (eventError) {
            console.error('[ERROR] MTProto message event handler encountered error:', eventError.message, '\nstack=', eventError.stack);
          }
        }, new NewMessage({}));

        isListenerStarted = true;
        console.log('[MTProto] Listener started');
      }

      isInitializing = false;
      return clientInstance;
    } catch (error) {
      isConnected = false;
      isInitializing = false;
      initPromise = null;

      // Clean up any partially initialized client on connection failure
      if (clientInstance) {
        try {
          await clientInstance.disconnect();
        } catch (_) {}
        clientInstance = null;
      }

      console.error('[MTProto] Connection error:', error.message);
      return null;
    }
  })();

  return initPromise;
}

/**
 * Starts a periodic background sync for watched channels every 60 seconds.
 */
function startPeriodicChannelSync(syncCallback) {
  if (periodicSyncInterval) return;
  periodicSyncInterval = setInterval(async () => {
    try {
      if (isConnected && clientInstance && typeof syncCallback === 'function') {
        await syncCallback();
      }
    } catch (err) {
      console.error('[ERROR] Periodic channel sync error:', err.message);
    }
  }, 60000);

  if (periodicSyncInterval.unref) {
    periodicSyncInterval.unref();
  }
}

/**
 * Validates and resolves a public Telegram channel by username or link.
 */
async function resolvePublicChannel(channelIdentifier) {
  if (!clientInstance || !isConnected) {
    return null;
  }

  try {
    const clean = normalizeChannelIdentifier(channelIdentifier);
    const entity = await clientInstance.getEntity(clean);

    if (entity) {
      return {
        id: entity.id ? entity.id.toString() : null,
        username: entity.username || clean,
        title: entity.title || clean,
        isChannel: entity.broadcast || entity.megagroup || false
      };
    }
    return null;
  } catch (error) {
    return null;
  }
}

function getTelegramClient() {
  return clientInstance;
}

function isMTProtoConnected() {
  return isConnected && clientInstance && clientInstance.connected;
}

module.exports = {
  initTelegramClient,
  syncWatchedChannels,
  startPeriodicChannelSync,
  resolvePublicChannel,
  getTelegramClient,
  isMTProtoConnected
};
