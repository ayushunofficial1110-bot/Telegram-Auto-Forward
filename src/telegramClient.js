const { TelegramClient, sessions, events } = require('teleproto');
const { StringSession } = sessions;
const { NewMessage } = events;

let clientInstance = null;
let isConnected = false;

/**
 * Initializes and connects the Telegram MTProto client.
 * @param {Function} onNewMessageCallback Handler for incoming channel messages
 */
async function initTelegramClient(onNewMessageCallback) {
  const apiId = process.env.TELEGRAM_API_ID;
  const apiHash = process.env.TELEGRAM_API_HASH;
  const sessionString = process.env.TELEGRAM_SESSION;

  console.log('[MTProto] Initializing...');

  if (!apiId || !apiHash || !sessionString) {
    const missing = [];
    if (!apiId) missing.push('TELEGRAM_API_ID');
    if (!apiHash) missing.push('TELEGRAM_API_HASH');
    if (!sessionString) missing.push('TELEGRAM_SESSION');
    console.error(`[MTProto] Connection error: Missing required environment variable(s): ${missing.join(', ')}`);
    return null;
  }

  try {
    const stringSession = new StringSession(sessionString.trim());
    const numericApiId = parseInt(apiId, 10);

    if (isNaN(numericApiId)) {
      throw new Error('TELEGRAM_API_ID must be a valid integer.');
    }

    clientInstance = new TelegramClient(stringSession, numericApiId, apiHash.trim(), {
      connectionRetries: 5,
      retryDelay: 3000,
      autoReconnect: true,
      useWSS: false,
      deviceModel: 'AutoReposter Server',
      systemVersion: 'NodeJS',
      appVersion: '1.0.0'
    });

    await clientInstance.connect();
    isConnected = true;
    console.log('[MTProto] Connected successfully');

    // Register incoming message event handler
    if (typeof onNewMessageCallback === 'function') {
      clientInstance.addEventHandler(async (event) => {
        try {
          if (event && event.message) {
            await onNewMessageCallback(event.message, clientInstance);
          }
        } catch (eventError) {
          console.error('[ERROR] MTProto message event handler encountered error:', eventError.message);
        }
      }, new NewMessage({}));
    }

    return clientInstance;
  } catch (error) {
    isConnected = false;
    console.error('[MTProto] Connection error:', error.message);
    return null;
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
