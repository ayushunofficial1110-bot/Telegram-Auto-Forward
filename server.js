require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');

// Tee process console output to server.log for transparent startup monitoring
const logFilePath = path.join(__dirname, 'server.log');
const origLog = console.log;
const origError = console.error;
const origWarn = console.warn;

function formatLogLine(prefix, args) {
  const timestamp = new Date().toISOString();
  const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  return `[${timestamp}] ${prefix} ${msg}\n`;
}

console.log = function (...args) {
  origLog.apply(console, args);
  try { fs.appendFileSync(logFilePath, formatLogLine('[INFO]', args)); } catch (_) {}
};

console.error = function (...args) {
  origError.apply(console, args);
  try { fs.appendFileSync(logFilePath, formatLogLine('[ERROR]', args)); } catch (_) {}
};

console.warn = function (...args) {
  origWarn.apply(console, args);
  try { fs.appendFileSync(logFilePath, formatLogLine('[WARN]', args)); } catch (_) {}
};

const { connectDatabase, getDatabaseStatus } = require('./src/database');
const { initBot, isBotConnected, getBotStatus } = require('./src/bot');
const { initTelegramClient, isMTProtoConnected } = require('./src/telegramClient');
const { setBotInstance, handleIncomingMessage, refreshWatchedChannels } = require('./src/repostEngine');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

app.use(express.json());

// Root endpoint as specified in requirements
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Auto Reposter'
  });
});

// Health check endpoint for uptime monitoring & hosting checks
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy'
  });
});

// Detailed runtime status endpoint
app.get('/status', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Auto Reposter',
    components: {
      bot: getBotStatus(),
      database: getDatabaseStatus(),
      mtproto: {
        connected: isMTProtoConnected()
      }
    }
  });
});

// Process-level error protections
process.on('uncaughtException', (err) => {
  console.error('[ERROR] Uncaught Exception:', err ? (err.stack || err.message || err) : 'Unknown uncaught exception');
});

process.on('unhandledRejection', (reason) => {
  console.error('[ERROR] Unhandled Rejection:', reason ? (reason.stack || reason.message || reason) : 'Unknown unhandled rejection');
});

let isBootstrapped = false;

async function bootstrap() {
  if (isBootstrapped) {
    console.log('[SERVER] Bootstrap already executed - skipping duplicate call');
    return;
  }
  isBootstrapped = true;

  console.log('[SERVER] Starting Auto Reposter Application...');

  // 1. Start HTTP Express Server immediately for healthchecks and hosting probes
  app.listen(PORT, HOST, () => {
    console.log(`[SERVER] Express server listening on http://${HOST}:${PORT}`);
  });

  // 2. Initialize Telegram Bot API independently (ensures bot starts polling immediately without being blocked)
  initBot().then((bot) => {
    if (bot) {
      setBotInstance(bot);
    }
  }).catch((err) => {
    console.error('[ERROR] [BOT] Startup error:', err && err.message ? err.message : err);
  });

  // 3. Connect to MongoDB Atlas independently (a database delay/failure will not prevent Telegram Bot from running)
  connectDatabase().catch((err) => {
    console.error('[ERROR] [DATABASE] Connection error:', err && err.message ? err.message : err);
  });

  // 4. Initialize MTProto client independently for receiving channel feeds
  initTelegramClient(async (message, client) => {
    await handleIncomingMessage(message, client);
  }).then(async (mtprotoClient) => {
    if (mtprotoClient) {
      await refreshWatchedChannels();
    }
  }).catch((err) => {
    console.error('[ERROR] [MTProto] Connection error:', err && err.message ? err.message : err);
  });
}

bootstrap().catch((err) => {
  console.error('[ERROR] Fatal error during bootstrap:', err && err.message ? err.message : err);
});
