/**
 * Helper utility to generate a Telegram MTProto StringSession locally.
 *
 * Usage:
 * 1. Set TELEGRAM_API_ID and TELEGRAM_API_HASH in .env or provide them when prompted.
 * 2. Run: node generateSession.js
 * 3. Enter your phone number (international format, e.g. +1234567890).
 * 4. Enter the verification code sent to your Telegram app.
 * 5. Copy the output session string into your .env file as TELEGRAM_SESSION=...
 */

require('dotenv').config();
const readline = require('readline');
const { TelegramClient, sessions } = require('teleproto');
const { StringSession } = sessions;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function ask(question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function run() {
  console.log('==============================================');
  console.log(' Telegram StringSession Generator (teleproto) ');
  console.log('==============================================\n');

  const apiIdInput = process.env.TELEGRAM_API_ID || await ask('Enter your Telegram API ID: ');
  const apiHashInput = process.env.TELEGRAM_API_HASH || await ask('Enter your Telegram API Hash: ');

  const apiId = parseInt(apiIdInput.trim(), 10);
  const apiHash = apiHashInput.trim();

  if (!apiId || !apiHash) {
    console.error('Error: API ID and API Hash are required.');
    rl.close();
    process.exit(1);
  }

  const stringSession = new StringSession('');
  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5
  });

  try {
    await client.start({
      phoneNumber: async () => await ask('Enter your phone number (e.g. +1234567890): '),
      password: async () => await ask('Enter your 2FA password (if enabled, or press enter): '),
      phoneCode: async () => await ask('Enter the code you received in Telegram: '),
      onError: (err) => console.error('Login error:', err.message)
    });

    console.log('\n[SUCCESS] Successfully authenticated!\n');
    const savedSession = client.session.save();

    console.log('--------------------------------------------------');
    console.log('YOUR TELEGRAM_SESSION STRING (KEEP THIS SECRET):');
    console.log('--------------------------------------------------\n');
    console.log(savedSession);
    console.log('\n--------------------------------------------------');
    console.log('Copy the string above and paste it into your .env:');
    console.log('TELEGRAM_SESSION=' + savedSession);
    console.log('--------------------------------------------------\n');

    await client.disconnect();
  } catch (error) {
    console.error('\n[ERROR] Failed to generate session:', error.message);
  } finally {
    rl.close();
    process.exit(0);
  }
}

run();
