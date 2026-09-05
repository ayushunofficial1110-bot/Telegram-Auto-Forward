const mongoose = require('mongoose');

const BotLockSchema = new mongoose.Schema({
  _id: { type: String, default: 'telegram_bot_polling' },
  instanceId: { type: String, required: true },
  host: { type: String, default: '' },
  acquiredAt: { type: Date, default: Date.now },
  lastHeartbeat: { type: Date, default: Date.now }
});

module.exports = mongoose.models.BotLock || mongoose.model('BotLock', BotLockSchema);
