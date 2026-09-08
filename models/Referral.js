const mongoose = require('mongoose');

const ReferralSchema = new mongoose.Schema({
  referrerId: {
    type: String,
    required: true,
    index: true
  },
  referredId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  referrerUserId: {
    type: String,
    index: true
  },
  referredUserId: {
    type: String,
    index: true
  },
  referralCode: {
    type: String,
    default: null
  },
  status: {
    type: String,
    enum: ['pending', 'successful', 'completed'],
    default: 'pending',
    index: true
  },
  rewardApplied: {
    type: Boolean,
    default: false
  },
  completedAt: {
    type: Date,
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Middleware to keep referrerId and referrerUserId in sync, and referredId and referredUserId in sync
ReferralSchema.pre('save', function () {
  if (!this.referrerUserId && this.referrerId) {
    this.referrerUserId = this.referrerId;
  }
  if (!this.referrerId && this.referrerUserId) {
    this.referrerId = this.referrerUserId;
  }
  if (!this.referredUserId && this.referredId) {
    this.referredUserId = this.referredId;
  }
  if (!this.referredId && this.referredUserId) {
    this.referredId = this.referredUserId;
  }
});

module.exports = mongoose.models.Referral || mongoose.model('Referral', ReferralSchema);
