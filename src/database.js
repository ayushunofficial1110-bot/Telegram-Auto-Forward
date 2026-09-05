const mongoose = require('mongoose');

let isConnected = false;
let isConnecting = false;
let lastDiagnostic = null;
let retryTimeout = null;
let listenersInitialized = false;

function setupEventListeners() {
  if (listenersInitialized) return;
  listenersInitialized = true;

  mongoose.connection.on('connected', () => {
    isConnected = true;
    isConnecting = false;
    lastDiagnostic = 'connected';
    console.log('[DATABASE] Connected successfully');
  });

  mongoose.connection.on('error', (err) => {
    isConnected = false;
    isConnecting = false;
    const msg = err && err.message ? err.message : String(err);
    if (msg.includes('whitelisted') || msg.includes('SSL routines') || msg.includes('alert number 80')) {
      lastDiagnostic = 'whitelist_required';
      console.warn('[DATABASE] Connection error (IP whitelist): Ensure 0.0.0.0/0 is added in MongoDB Atlas Network Access.');
    } else {
      lastDiagnostic = msg;
      console.error('[DATABASE] Connection error:', msg);
    }
    scheduleReconnect();
  });

  mongoose.connection.on('disconnected', () => {
    isConnected = false;
    isConnecting = false;
    console.warn('[DATABASE] MongoDB connection closed. Reconnecting in background...');
    scheduleReconnect();
  });
}

function scheduleReconnect(delayMs = 15000) {
  if (retryTimeout) return;
  retryTimeout = setTimeout(() => {
    retryTimeout = null;
    if (!isConnected && !isConnecting) {
      connectDatabase().catch(() => {});
    }
  }, delayMs);
}

async function connectDatabase() {
  const uri = process.env.MONGODB_URI;

  if (!uri) {
    console.error('[DATABASE] Error: MONGODB_URI is not set in environment variables. Database operations inactive.');
    lastDiagnostic = 'missing_uri';
    return false;
  }

  if (isConnected || isConnecting) {
    return isConnected;
  }

  setupEventListeners();
  mongoose.set('strictQuery', false);

  isConnecting = true;
  console.log('[DATABASE] Connecting...');
  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 5000,
      autoIndex: true,
      family: 4
    });
    isConnected = true;
    isConnecting = false;
    lastDiagnostic = 'connected';
    console.log('[DATABASE] Connected successfully');
    return true;
  } catch (err) {
    isConnecting = false;
    isConnected = false;
    const msg = err && err.message ? err.message : String(err);
    if (msg.includes('whitelisted') || msg.includes('SSL routines') || msg.includes('alert number 80')) {
      lastDiagnostic = 'whitelist_required';
      console.warn('[DATABASE] Connection error (IP whitelist): Cluster access list blocked container IP.');
      console.warn('[DATABASE] Resolution: In MongoDB Atlas -> Network Access -> Add IP -> Select "Allow Access From Anywhere" (0.0.0.0/0).');
    } else {
      lastDiagnostic = msg;
      console.error('[DATABASE] Connection error:', msg);
    }
    scheduleReconnect();
    return false;
  }
}

function isDatabaseConnected() {
  return isConnected && mongoose.connection.readyState === 1;
}

function getDatabaseStatus() {
  return {
    connected: isDatabaseConnected(),
    state: isConnected ? 'connected' : (isConnecting ? 'connecting' : 'disconnected'),
    diagnostic: lastDiagnostic
  };
}

module.exports = {
  connectDatabase,
  isDatabaseConnected,
  getDatabaseStatus
};
