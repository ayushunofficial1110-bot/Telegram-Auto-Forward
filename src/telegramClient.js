const { TelegramClient, sessions, events } = require('teleproto');
const { StringSession } = sessions;
const { NewMessage } = events;

// Single shared client instance for the entire application process
let clientInstance = null;
let isInitializing = false;
let isConnected = false;
let isListenerStarted = false;
let initPromise = null;

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
        connectionRetries: 5,
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

      // Register incoming message event handler exactly once
      if (!isListenerStarted && typeof onNewMessageCallback === 'function') {
        clientInstance.addEventHandler(async (event) => {
          try {
            if (event && event.message) {
              await onNewMessageCallback(event.message, clientInstance);
            }
          } catch (eventError) {
            console.error('[ERROR] MTProto message event handler encountered error:', eventError.message);
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
 * Validates and resolves a public Telegram channel by username or link.
 */
async function resolvePublicChannel(channelIdentifier) {
  if (!clientInstance || !isConnected) {
    return null;
  }

  try {
    let clean = channelIdentifier.trim().replace(/^https?:\/\/t\.me\//i, '').replace(/^@/, '');
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
  resolvePublicChannel,
  getTelegramClient,
  isMTProtoConnected
};
