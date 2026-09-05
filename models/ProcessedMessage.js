const mongoose = require('mongoose');

const ProcessedMessageSchema = new mongoose.Schema({
  ruleId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ForwardRule',
    required: true,
    index: true
  },
  sourceChannelId: {
    type: String,
    required: true,
    index: true
  },
  sourceMessageId: {
    type: Number,
    required: true,
    index: true
  },
  destinationMessageId: {
    type: Number,
    default: null
  },
  status: {
    type: String,
    enum: ['completed', 'failed', 'skipped'],
    default: 'completed'
  },
  createdAt: {
    type: Date,
    default: Date.now,
    // TTL index optional: keep messages for 90 days to conserve space while preventing duplicates
    expires: 60 * 60 * 24 * 90
  }
});

// Compound unique index to strictly guarantee no duplicate repost for the same rule & source message
ProcessedMessageSchema.index({ ruleId: 1, sourceMessageId: 1 }, { unique: true });

module.exports = mongoose.models.ProcessedMessage || mongoose.model('ProcessedMessage', ProcessedMessageSchema);
