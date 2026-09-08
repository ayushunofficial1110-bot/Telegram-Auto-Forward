const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  telegramUserId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  username: {
    type: String,
    default: null
  },
  firstName: {
    type: String,
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  referralCode: {
    type: String,
    sparse: true,
    index: true,
    default: null
  },
  referredBy: {
    type: String,
    default: null,
    index: true
  },
  referralCount: {
    type: Number,
    default: 0
  },
  adsFree: {
    type: Boolean,
    default: false,
    index: true
  },
  adFreeUntil: {
    type: Date,
    default: null
  },
  isLifetimeAdFree: {
    type: Boolean,
    default: false
  },
  platformPromotionsEnabled: {
    type: Boolean,
    default: true
  },
  setupCompleted: {
    type: Boolean,
    default: false
  },
  isAdmin: {
    type: Boolean,
    default: false
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.models.User || mongoose.model('User', UserSchema);
