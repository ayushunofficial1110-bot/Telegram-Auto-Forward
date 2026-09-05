const mongoose = require('mongoose');

const ForwardRuleSchema = new mongoose.Schema({
  userId: {
    type: String,
    required: true,
    index: true
  },
  sourceChannelUsername: {
    type: String,
    required: true,
    trim: true,
    index: true
  },
  sourceChannelId: {
    type: String,
    default: null,
    index: true
  },
  destinationChannelUsername: {
    type: String,
    required: true,
    trim: true
  },
  destinationChannelId: {
    type: String,
    required: true,
    trim: true
  },
  brandingEnabled: {
    type: Boolean,
    default: false
  },
  findText: {
    type: String,
    default: ''
  },
  replaceText: {
    type: String,
    default: ''
  },
  footer: {
    type: String,
    default: ''
  },
  platformPromotionsEnabled: {
    type: Boolean,
    default: true
  },
  active: {
    type: Boolean,
    default: true,
    index: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Update the updatedAt timestamp automatically on save
ForwardRuleSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  if (typeof next === 'function') {
    return next();
  }
});

module.exports = mongoose.models.ForwardRule || mongoose.model('ForwardRule', ForwardRuleSchema);
