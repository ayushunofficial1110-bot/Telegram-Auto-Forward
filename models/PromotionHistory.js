const mongoose = require('mongoose');

const PromotionHistorySchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['broadcast_users', 'promotion_channels'],
    required: true,
    index: true
  },
  adminId: {
    type: String,
    required: true
  },
  messageType: {
    type: String,
    enum: ['text', 'photo', 'video', 'document'],
    default: 'text'
  },
  content: {
    text: { type: String, default: '' },
    caption: { type: String, default: '' },
    fileId: { type: String, default: null }
  },
  targetCount: {
    type: Number,
    default: 0
  },
  sentCount: {
    type: Number,
    default: 0
  },
  failedCount: {
    type: Number,
    default: 0
  },
  skippedCount: {
    type: Number,
    default: 0
  },
  skippedReasons: [
    {
      target: String,
      reason: String
    }
  ],
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.models.PromotionHistory || mongoose.model('PromotionHistory', PromotionHistorySchema);
