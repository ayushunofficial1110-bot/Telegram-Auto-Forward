const rawTelegramBot = require('node-telegram-bot-api');
const TelegramBot = typeof rawTelegramBot === 'function'
  ? rawTelegramBot
  : (rawTelegramBot.default || rawTelegramBot.TelegramBot || rawTelegramBot);
const User = require('../models/User');
const ForwardRule = require('../models/ForwardRule');
const Referral = require('../models/Referral');
const PromotionHistory = require('../models/PromotionHistory');
const { isDatabaseConnected, getDatabaseStatus } = require('./database');
const { isMTProtoConnected, resolvePublicChannel } = require('./telegramClient');
const {
  recordReferralStart,
  completeReferralIfPending,
  getAdFreeStatusLabel,
  isChannelAdFree
} = require('./referralEngine');
const {
  isUserAdmin,
  getSystemStatistics,
  getChannelAuditList,
  executeBroadcast,
  executeChannelPromotion,
  sendPayloadSafely
} = require('./adminService');
const {
  startLeaderElection,
  cedeLeadership,
  isLeader
} = require('./botLeader');

let bot = null;
let botInfo = null;

// User wizard sessions: Map<telegramUserId, { step: string, data: object, promptMsgId?: number }>
const wizardSessions = new Map();

/**
 * Initializes the Telegram Bot API client.
 */
async function initBot() {
  console.log('[BOT] Initializing...');

  const token = process.env.BOT_TOKEN;
  if (!token) {
    console.error('[BOT] Error: BOT_TOKEN is not set in environment variables.');
    return null;
  }

  try {
    // 1. Initialize TelegramBot without immediate polling
    bot = new TelegramBot(token.trim(), { polling: false });

    // 2. Clear any active webhooks that may conflict with long-polling
    try {
      await bot.deleteWebHook();
    } catch (whErr) {
      console.warn('[BOT] Notice: deleteWebHook completed with:', whErr.message);
    }

    // 3. Register polling and general error handlers with 409 Conflict mitigation
    bot.on('polling_error', (error) => {
      const errMsg = error.message || '';
      const statusCode = error.response && error.response.statusCode;

      // Handle 409 Conflict gracefully (another instance/container is polling)
      if (statusCode === 409 || errMsg.includes('409 Conflict')) {
        console.warn('[BOT] 409 Conflict detected (another instance or previous connection active). Standing by to prevent conflict...');
        cedeLeadership('409 Conflict detected');
        return;
      }

      const errCode = error.code || statusCode || errMsg;
      console.warn('[BOT] Polling warning:', errCode, errMsg);
    });

    bot.on('error', (error) => {
      console.error('[ERROR] [BOT] General error:', error.message);
    });

    // 4. Pre-register all commands and event handlers BEFORE starting polling
    setupCommandHandlers();
    setupCallbackQueryHandlers();
    setupTextMessageHandler();

    // 5. Start single-instance leader election (polls only if this instance is leader)
    startLeaderElection(bot);

    // 6. Fetch bot profile in background to verify bot identity and set botInfo
    bot.getMe().then((me) => {
      botInfo = me;
      console.log(`[BOT] Verified bot identity: @${me.username}`);
    }).catch((meErr) => {
      console.warn('[BOT] Notice: getMe completed with:', meErr.message);
    });

    return bot;
  } catch (error) {
    console.error('[ERROR] [BOT] Failed to start Telegram Bot:', error.message);
    return null;
  }
}

/**
 * Sets up /start, /menu, /admin, /help and command listeners.
 */
function setupCommandHandlers() {
  // /start handler with referral link support: /start ref_123456 or /start 123456
  bot.onText(/^\/start(?:@\w+)?(?:\s+(.*))?$/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from.id);
    const username = msg.from.username || null;
    const firstName = msg.from.first_name || '';
    const startParam = match && match[1] ? match[1].trim() : null;

    console.log(`[BOT] Received /start from user ${userId} (@${username || firstName || 'unknown'}), param: ${startParam || 'none'}`);

    // Clear any active wizard session
    wizardSessions.delete(userId);

    let userDoc = null;
    // Register or update user in MongoDB if connected
    if (isDatabaseConnected()) {
      try {
        userDoc = await User.findOneAndUpdate(
          { telegramUserId: userId },
          { username, firstName, updatedAt: new Date() },
          { upsert: true, returnDocument: 'after' }
        );

        // Process referral link if provided
        if (startParam) {
          const refResult = await recordReferralStart(userId, startParam, bot, {
            username,
            firstName
          });

          if (refResult && refResult.success) {
            console.log(`[REFERRAL] Successfully credited referral: ${refResult.referrerId} <- ${userId}`);
            await bot.sendMessage(
              chatId,
              `🎉 <b>Welcome!</b> You joined through an invite link. Enjoy auto-forwarding!`,
              { parse_mode: 'HTML' }
            ).catch(() => {});
          } else if (refResult && refResult.error === 'self_referral') {
            await bot.sendMessage(
              chatId,
              `⚠️ <i>Notice: You cannot refer yourself. Share your invite link with friends to earn Ad-Free rewards!</i>`,
              { parse_mode: 'HTML' }
            ).catch(() => {});
          } else if (refResult && refResult.error === 'already_referred') {
            console.log(`[REFERRAL] User ${userId} was already referred previously by ${refResult.referrerId}`);
          }
        }
      } catch (err) {
        console.error('[ERROR] Failed to save user on /start:', err.message);
      }
    }

    const adminCheck = isUserAdmin(userId, userDoc);
    sendMainMenu(chatId, firstName, adminCheck);
  });

  bot.onText(/^\/menu(?:@\w+)?(?:\s+(.*))?$/i, async (msg) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from.id);
    console.log(`[BOT] Received /menu from user ${userId}`);
    wizardSessions.delete(userId);

    let userDoc = null;
    if (isDatabaseConnected()) {
      userDoc = await User.findOne({ telegramUserId: userId }).catch(() => null);
    }
    const adminCheck = isUserAdmin(userId, userDoc);
    sendMainMenu(chatId, msg.from.first_name || '', adminCheck);
  });

  bot.onText(/^\/admin(?:@\w+)?(?:\s+(.*))?$/i, async (msg) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from.id);
    let userDoc = null;
    if (isDatabaseConnected()) {
      userDoc = await User.findOne({ telegramUserId: userId }).catch(() => null);
    }

    if (!isUserAdmin(userId, userDoc)) {
      return bot.sendMessage(
        chatId,
        '⛔️ <b>Access Denied</b>\n\nThis administrative panel is restricted to the authorized administrator.',
        { parse_mode: 'HTML' }
      );
    }

    wizardSessions.delete(userId);
    sendAdminPanel(chatId);
  });

  bot.onText(/^\/help(?:@\w+)?(?:\s+(.*))?$/i, async (msg) => {
    const chatId = msg.chat.id;
    sendHelpMessage(chatId);
  });

  bot.onText(/^\/(?:settings|status)(?:@\w+)?(?:\s+(.*))?$/i, async (msg) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from.id);
    let userDoc = null;
    if (isDatabaseConnected()) {
      userDoc = await User.findOne({ telegramUserId: userId }).catch(() => null);
    }
    if (isUserAdmin(userId, userDoc)) {
      return showAdminStatus(chatId);
    }
    return bot.sendMessage(
      chatId,
      '⛔️ <b>Settings Restricted</b>\n\nAll system settings and diagnostics are managed exclusively inside the <b>Admin Panel</b>.',
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: '🔙 Main Menu', callback_data: 'menu_main' }]]
        }
      }
    );
  });
}

/**
 * Sends the primary navigation menu with inline buttons.
 */
async function sendMainMenu(chatId, name, isAdminFlag = null) {
  let isAdmin = isAdminFlag;
  if (isAdmin === null && isDatabaseConnected()) {
    const userDoc = await User.findOne({ telegramUserId: String(chatId) }).catch(() => null);
    isAdmin = isUserAdmin(String(chatId), userDoc);
  }

  const welcomeText =
    `👋 Hello, <b>${escapeHtml(name || 'there')}</b>!\n\n` +
    `Welcome to <b>Auto Reposter Bot</b>. Configure automatic channel forwarding rules once and let the engine handle the rest.\n\n` +
    `Choose an option below:`;

  const keyboard = {
    inline_keyboard: [
      [{ text: '➕ Create Auto Forward', callback_data: 'menu_create' }],
      [{ text: '🔄 My Auto Forwards', callback_data: 'menu_list' }],
      [{ text: '👥 Refer & Earn', callback_data: 'menu_referrals' }],
      [{ text: '💬 Contact Support', callback_data: 'menu_support' }]
    ]
  };

  if (isAdmin) {
    keyboard.inline_keyboard.push([{ text: '👑 Admin Panel', callback_data: 'admin_panel' }]);
  }

  bot.sendMessage(chatId, welcomeText, {
    parse_mode: 'HTML',
    reply_markup: keyboard
  }).catch((err) => console.error('[ERROR] Failed to send main menu to chat', chatId, ':', err.message));
}

/**
 * Contact Support display with official link.
 */
function showContactSupport(chatId) {
  const supportText =
    `💬 <b>Contact Support</b>\n\n` +
    `If you have any query, ask here:\n\n` +
    `@Ayush_supporrt_bot`;

  bot.sendMessage(chatId, supportText, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '💬 Open Support Bot', url: 'https://t.me/Ayush_supporrt_bot' }],
        [{ text: '🔙 Back to Menu', callback_data: 'menu_main' }]
      ]
    }
  });
}

/**
 * Refer & Earn display showing user's link, referral stats and milestones.
 */
async function showReferralsMenu(chatId, userId) {
  let userDoc = null;
  if (isDatabaseConnected()) {
    userDoc = await User.findOne({ telegramUserId: userId });
  }

  const referralCount = userDoc ? (userDoc.referralCount || 0) : 0;
  const statusLabel = getAdFreeStatusLabel(userDoc);
  const botUsername = (botInfo && botInfo.username) ? botInfo.username : 'auto_forward_free_bot';
  const referralLink = `https://t.me/${botUsername}?start=ref_${userId}`;
  const shareText = `🚀 Check out this Telegram Auto Reposter bot! Automatically repost channel posts with custom branding and footer.\n\nJoin here: ${referralLink}`;
  const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=${encodeURIComponent(shareText)}`;

  const text =
    `👥 <b>Refer & Earn</b>\n\n` +
    `Successful Referrals: <b>${referralCount}</b>\n` +
    `🛡 Ad-Free Status: <b>${escapeHtml(statusLabel)}</b>\n\n` +
    `🎁 <b>Your Rewards:</b>\n` +
    `• 2 referrals ➔ 1 week ad-free\n` +
    `• 5 referrals ➔ 3 weeks ad-free\n` +
    `• 10 referrals ➔ 2 months ad-free\n` +
    `• 20 referrals ➔ 5 months ad-free\n` +
    `• 50 referrals ➔ Lifetime ad-free\n\n` +
    `Your Referral Link:\n` +
    `<code>${referralLink}</code>\n\n` +
    `<i>Share your link with friends. When someone starts the bot using your link, your referral count increases immediately and unlocks Ad-Free rewards!</i>`;

  bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📲 Share Referral Link', url: shareUrl }],
        [{ text: '🔄 Refresh', callback_data: 'menu_referrals' }],
        [{ text: '🔙 Back to Menu', callback_data: 'menu_main' }]
      ]
    }
  });
}

/**
 * Platform Promotions settings display.
 */
async function showPlatformPromotions(chatId, userId) {
  let userDoc = null;
  let rules = [];
  if (isDatabaseConnected()) {
    userDoc = await User.findOne({ telegramUserId: userId });
    rules = await ForwardRule.find({ userId });
  }

  const promoEnabled = userDoc ? userDoc.platformPromotionsEnabled !== false : true;
  const adFreeStatus = getAdFreeStatusLabel(userDoc);

  const text =
    `📢 <b>Platform Promotions</b>\n\n` +
    `Manage platform promotional announcements on your destination channels.\n\n` +
    `• <b>Ad-Free Status:</b> ${escapeHtml(adFreeStatus)}\n` +
    `• <b>Promotions on Your Channels:</b> ${promoEnabled ? '🟢 ON' : '🔴 OFF'}\n` +
    `• <b>Destination Channels:</b> ${rules.length}\n\n` +
    `<i>Channels that have unlocked Ad-Free rewards via Refer & Earn or have Promotions toggled OFF are automatically skipped from admin promotions. Normal auto-forwarding continues completely uninterrupted!</i>`;

  const toggleText = promoEnabled ? '🔴 Turn Promotions OFF' : '🟢 Turn Promotions ON';

  bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: toggleText, callback_data: 'toggle_promo_pref' }],
        [{ text: '👥 Refer & Earn (Unlock Ad-Free)', callback_data: 'menu_referrals' }],
        [{ text: '🔙 Back to Menu', callback_data: 'menu_main' }]
      ]
    }
  });
}

/**
 * Toggles user's platform promotions preference.
 */
async function togglePlatformPromotionsPref(chatId, userId) {
  if (!isDatabaseConnected()) {
    return bot.sendMessage(chatId, '⚠️ Database is disconnected.');
  }

  try {
    const userDoc = await User.findOne({ telegramUserId: userId });
    if (userDoc) {
      userDoc.platformPromotionsEnabled = !(userDoc.platformPromotionsEnabled !== false);
      await userDoc.save();

      // Also update forward rules owned by this user
      await ForwardRule.updateMany(
        { userId },
        { platformPromotionsEnabled: userDoc.platformPromotionsEnabled }
      );
    }
    showPlatformPromotions(chatId, userId);
  } catch (err) {
    bot.sendMessage(chatId, `❌ Error updating preference: ${err.message}`);
  }
}

/**
 * Help message explanation.
 */
function sendHelpMessage(chatId) {
  const helpText =
    `📖 <b>Auto Reposter Bot Help</b>\n\n` +
    `<b>Commands:</b>\n` +
    `• /start - Launch or reset the bot\n` +
    `• /menu - Open the main menu\n` +
    `• /admin - Open the Admin Panel (Admin only)\n` +
    `• /help - Display this help guide\n\n` +
    `<b>Features:</b>\n` +
    `• <b>Auto Forwarding:</b> Real-time synchronization from public channels to your destination channels.\n` +
    `• <b>Refer & Earn:</b> Invite channel owners to unlock Ad-Free status on your channels.\n` +
    `• <b>Support:</b> Contact @Ayush_supporrt_bot for any queries.`;

  bot.sendMessage(chatId, helpText, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[{ text: '🔙 Back to Menu', callback_data: 'menu_main' }]]
    }
  });
}

/**
 * Displays the Admin Control Panel.
 */
async function sendAdminPanel(chatId) {
  const text =
    `👑 <b>Admin Control Panel</b>\n\n` +
    `Welcome Administrator! Select a tool below:`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: '📊 Statistics', callback_data: 'admin_stats' },
        { text: '👥 Users', callback_data: 'admin_users' }
      ],
      [
        { text: '📺 Channels', callback_data: 'admin_channels' },
        { text: '🔄 Forward Rules', callback_data: 'admin_rules' }
      ],
      [
        { text: '📢 Broadcast', callback_data: 'admin_broadcast_init' },
        { text: '📢 My Promotion', callback_data: 'admin_promo_init' }
      ],
      [
        { text: '👥 Referrals', callback_data: 'admin_referrals' },
        { text: '⚙️ Settings & System Status', callback_data: 'admin_settings' }
      ],
      [{ text: '🔙 Back to Main Menu', callback_data: 'menu_main' }]
    ]
  };

  bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: keyboard
  });
}

/**
 * Admin Panel: 📊 Statistics
 */
async function showAdminStats(chatId) {
  const stats = await getSystemStatistics();

  const text =
    `📊 <b>System Statistics</b>\n\n` +
    `👥 <b>Users:</b>\n` +
    `• Total Registered: <b>${stats.users.total}</b>\n` +
    `• Joined Last 24h: <b>${stats.users.new24h}</b>\n` +
    `• Lifetime Ad-Free Users: <b>${stats.users.lifetimeAdFree}</b>\n` +
    `• Active Ad-Free Users: <b>${stats.users.activeAdFree}</b>\n\n` +
    `🔄 <b>Forwarding Rules:</b>\n` +
    `• Total Rules: <b>${stats.rules.total}</b>\n` +
    `• Active Rules: <b>${stats.rules.active}</b>\n\n` +
    `📺 <b>Destination Channels:</b>\n` +
    `• Total Unique Channels: <b>${stats.channels.total}</b>\n` +
    `• Eligible for Promo: <b>${stats.channels.eligibleForPromo}</b>\n` +
    `• Skipped (Ad-Free / Promo OFF): <b>${stats.channels.skippedPromo}</b>\n\n` +
    `👥 <b>Referrals:</b>\n` +
    `• Total Referrals: <b>${stats.referrals.total}</b>\n` +
    `• Completed: <b>${stats.referrals.completed}</b>\n` +
    `• Pending: <b>${stats.referrals.pending}</b>\n\n` +
    `📨 <b>Reposted Messages:</b>\n` +
    `• Total Processed: <b>${stats.processedMessages}</b>`;

  bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔄 Refresh', callback_data: 'admin_stats' }],
        [{ text: '🔙 Back to Admin Panel', callback_data: 'admin_panel' }]
      ]
    }
  });
}

/**
 * Admin Panel: 👥 Users
 */
async function showAdminUsers(chatId) {
  const users = await User.find().sort({ createdAt: -1 }).limit(10);
  const total = await User.countDocuments();

  let text = `👥 <b>Recent Users (Showing ${users.length} of ${total})</b>\n\n`;

  if (users.length === 0) {
    text += `<i>No users registered yet.</i>`;
  } else {
    users.forEach((u, i) => {
      const uname = u.username ? `@${escapeHtml(u.username)}` : escapeHtml(u.firstName || 'User');
      const adFree = u.isLifetimeAdFree ? '👑 Lifetime' : (u.adFreeUntil && new Date(u.adFreeUntil) > new Date() ? '🟢 Active' : '⚪️ Standard');
      text += `<b>${i + 1}. ${uname}</b> (<code>${u.telegramUserId}</code>)\n`;
      text += `   • Referrals: <b>${u.referralCount || 0}</b> | Ad-Free: <b>${adFree}</b>\n\n`;
    });
  }

  bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔄 Refresh', callback_data: 'admin_users' }],
        [{ text: '🔙 Back to Admin Panel', callback_data: 'admin_panel' }]
      ]
    }
  });
}

/**
 * Admin Panel: 📺 Channels
 */
async function showAdminChannels(chatId) {
  const channels = await getChannelAuditList();

  let text = `📺 <b>Destination Channels (${channels.length})</b>\n\n`;

  if (channels.length === 0) {
    text += `<i>No destination channels configured yet.</i>`;
  } else {
    channels.slice(0, 15).forEach((c, i) => {
      const channelDisplay = c.channelUsername || c.channelId;
      const statusIcon = c.isEligible ? '🟢 Eligible' : '🛡 Skipped';
      text += `<b>${i + 1}. ${escapeHtml(channelDisplay)}</b>\n`;
      text += `   • Promo Status: <b>${statusIcon}</b>`;
      if (c.skipReason) {
        text += ` (<i>${escapeHtml(c.skipReason)}</i>)`;
      }
      text += `\n   • Owner: <code>${c.ownerId}</code>\n\n`;
    });

    if (channels.length > 15) {
      text += `<i>...and ${channels.length - 15} more channels.</i>\n`;
    }
  }

  bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔄 Refresh', callback_data: 'admin_channels' }],
        [{ text: '🔙 Back to Admin Panel', callback_data: 'admin_panel' }]
      ]
    }
  });
}

/**
 * Admin Panel: 🔄 Forward Rules
 */
async function showAdminRules(chatId) {
  const rules = await ForwardRule.find().sort({ createdAt: -1 }).limit(10);
  const total = await ForwardRule.countDocuments();
  const activeCount = await ForwardRule.countDocuments({ active: true });

  let text = `🔄 <b>Forward Rules (${activeCount} active of ${total} total)</b>\n\n`;

  if (rules.length === 0) {
    text += `<i>No forward rules created yet.</i>`;
  } else {
    rules.forEach((r, i) => {
      const status = r.active ? '🟢 Active' : '⏸ Paused';
      text += `<b>${i + 1}. ${escapeHtml(r.sourceChannelUsername)} ➔ ${escapeHtml(r.destinationChannelUsername)}</b>\n`;
      text += `   • Status: ${status} | User: <code>${r.userId}</code>\n\n`;
    });
  }

  bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔄 Refresh', callback_data: 'admin_rules' }],
        [{ text: '🔙 Back to Admin Panel', callback_data: 'admin_panel' }]
      ]
    }
  });
}

/**
 * Admin Panel: 👥 Referrals
 */
async function showAdminReferrals(chatId) {
  const [totalRefs, completedRefs, topReferrers] = await Promise.all([
    Referral.countDocuments(),
    Referral.countDocuments({ status: 'completed' }),
    User.find({ referralCount: { $gt: 0 } }).sort({ referralCount: -1 }).limit(10)
  ]);

  let text =
    `👥 <b>Referral System Overview</b>\n\n` +
    `• Total Referrals: <b>${totalRefs}</b>\n` +
    `• Completed (Rewarded): <b>${completedRefs}</b>\n` +
    `• Pending Setup: <b>${totalRefs - completedRefs}</b>\n\n` +
    `🏆 <b>Top Referrers:</b>\n`;

  if (topReferrers.length === 0) {
    text += `<i>No users have completed referrals yet.</i>\n`;
  } else {
    topReferrers.forEach((u, i) => {
      const name = u.username ? `@${escapeHtml(u.username)}` : escapeHtml(u.firstName || 'User');
      const adFree = u.isLifetimeAdFree ? '👑 Lifetime' : (u.adFreeUntil ? '🟢 Active' : 'Standard');
      text += `<b>${i + 1}. ${name}</b> (<code>${u.telegramUserId}</code>)\n`;
      text += `   • Referrals: <b>${u.referralCount}</b> | Status: <b>${adFree}</b>\n\n`;
    });
  }

  bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔄 Refresh', callback_data: 'admin_referrals' }],
        [{ text: '🔙 Back to Admin Panel', callback_data: 'admin_panel' }]
      ]
    }
  });
}

/**
 * Admin Panel: ⚙️ Settings & System Status
 */
async function showAdminStatus(chatId) {
  const dbInfo = getDatabaseStatus();
  const dbStatus = dbInfo.connected ? '🟢 Connected' : (dbInfo.state === 'connecting' ? '🟡 Connecting' : '🔴 Disconnected');
  const mtprotoStatus = isMTProtoConnected() ? '🟢 Connected (Listening)' : '🟠 Not Connected / Standing By';
  const botStatus = botInfo ? `🟢 Online (@${botInfo.username})` : '🔴 Offline';
  const uptimeHours = (process.uptime() / 3600).toFixed(2);
  const memUsageMb = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);

  let totalRules = 0;
  let activeRules = 0;
  let totalUsers = 0;
  if (isDatabaseConnected()) {
    try {
      totalRules = await ForwardRule.countDocuments();
      activeRules = await ForwardRule.countDocuments({ active: true });
      totalUsers = await User.countDocuments();
    } catch (_) {}
  }

  const text =
    `⚙️ <b>Admin Settings & System Status</b>\n\n` +
    `• <b>Telegram Bot API:</b> ${botStatus}\n` +
    `• <b>MTProto Channel Listener:</b> ${mtprotoStatus}\n` +
    `• <b>MongoDB Atlas Database:</b> ${dbStatus}\n` +
    `• <b>Forwarding Rules:</b> ${totalRules} total (${activeRules} active)\n` +
    `• <b>Registered Users:</b> ${totalUsers}\n` +
    `• <b>Process Uptime:</b> ${uptimeHours} hours\n` +
    `• <b>Memory Usage (RSS):</b> ${memUsageMb} MB\n` +
    `• <b>Node.js Version:</b> ${process.version}\n\n` +
    `<i>All core settings, diagnostics, and background daemons are managed exclusively through this admin console.</i>`;

  bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔄 Refresh Settings & Status', callback_data: 'admin_settings' }],
        [{ text: '🔙 Back to Admin Panel', callback_data: 'admin_panel' }]
      ]
    }
  });
}

/**
 * Admin Broadcast: Initiates broadcast input wizard.
 */
async function startAdminBroadcast(chatId, userId) {
  wizardSessions.set(userId, {
    step: 'ADMIN_BROADCAST_WAIT_CONTENT',
    data: {
      adminId: userId
    }
  });

  const text =
    `📢 <b>Admin Broadcast to Users</b>\n\n` +
    `Please send the message you want to broadcast to all registered users.\n\n` +
    `Supported formats:\n` +
    `• <b>Text</b> (with Telegram formatting)\n` +
    `• <b>Photo</b> with optional caption\n` +
    `• <b>Video</b> with optional caption\n` +
    `• <b>Document</b> with optional caption\n\n` +
    `<i>A full preview will be shown for your approval before anything is sent.</i>\n\n` +
    `Send /cancel to abort.`;

  bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'admin_panel' }]]
    }
  });
}

/**
 * Admin Promotion: Initiates channel promotion target selection.
 */
async function startAdminPromoTargeting(chatId, userId) {
  const text =
    `📢 <b>Admin Channel Promotion</b>\n\n` +
    `Publish announcements and promotional messages directly to destination channels.\n\n` +
    `<b>Choose targeting:</b>\n` +
    `• <b>📢 Send to All Eligible Channels:</b> Automatically sends to all destination channels whose owners do not have active Ad-Free status.\n` +
    `• <b>🎯 Select Specific Channels:</b> Choose individual destination channels manually.\n\n` +
    `<i>Note: Channels that unlocked Ad-Free rewards or have Platform Promotions OFF are always safely skipped.</i>`;

  bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📢 Send to All Eligible Channels', callback_data: 'admin_promo_target_all' }],
        [{ text: '🎯 Select Specific Channels', callback_data: 'admin_promo_target_select' }],
        [{ text: '🔙 Back to Admin Panel', callback_data: 'admin_panel' }]
      ]
    }
  });
}

/**
 * Admin Promotion: Shows channel selection menu for specific targeting.
 */
async function showAdminPromoChannelSelector(chatId, userId, selectedKeys = []) {
  const channels = await getChannelAuditList();

  if (channels.length === 0) {
    return bot.sendMessage(chatId, '⚠️ No destination channels exist yet.', {
      reply_markup: { inline_keyboard: [[{ text: '🔙 Admin Panel', callback_data: 'admin_panel' }]] }
    });
  }

  const keyboard = [];

  channels.forEach((c) => {
    const isSelected = selectedKeys.includes(c.channelKey);
    const mark = isSelected ? '✅' : '⬜️';
    const tag = c.isEligible ? '' : ' (Ineligible)';
    keyboard.push([
      {
        text: `${mark} ${c.channelUsername || c.channelId}${tag}`,
        callback_data: `admin_promo_toggle_${c.channelKey}`
      }
    ]);
  });

  keyboard.push([
    { text: `🚀 Continue with (${selectedKeys.length}) Selected`, callback_data: 'admin_promo_select_done' }
  ]);
  keyboard.push([
    { text: '🔙 Cancel', callback_data: 'admin_panel' }
  ]);

  const text =
    `🎯 <b>Select Target Channels</b>\n\n` +
    `Click channels to toggle selection, then click Continue:\n` +
    `Selected: <b>${selectedKeys.length}</b> channels`;

  bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard }
  });
}

/**
 * Handles incoming broadcast or promotion content input (Text, Photo, Video, Document).
 */
async function handleAdminContentInput(chatId, userId, msg, session) {
  let payload = null;

  if (msg.photo && msg.photo.length > 0) {
    const largestPhoto = msg.photo[msg.photo.length - 1];
    payload = {
      type: 'photo',
      fileId: largestPhoto.file_id,
      caption: msg.caption || ''
    };
  } else if (msg.video) {
    payload = {
      type: 'video',
      fileId: msg.video.file_id,
      caption: msg.caption || ''
    };
  } else if (msg.document) {
    payload = {
      type: 'document',
      fileId: msg.document.file_id,
      caption: msg.caption || ''
    };
  } else if (msg.text) {
    payload = {
      type: 'text',
      text: msg.text
    };
  } else {
    return bot.sendMessage(chatId, '⚠️ Unsupported format. Please send Text, Photo, Video, or Document.');
  }

  session.data.payload = payload;

  if (session.step === 'ADMIN_BROADCAST_WAIT_CONTENT') {
    session.step = 'ADMIN_BROADCAST_CONFIRM';
    wizardSessions.set(userId, session);

    const userCount = await User.countDocuments();

    // 1. Show preview to admin
    await bot.sendMessage(chatId, '📢 <b>BROADCAST PREVIEW:</b>', { parse_mode: 'HTML' });
    await sendPayloadSafely(bot, chatId, payload);

    // 2. Prompt confirmation
    await bot.sendMessage(
      chatId,
      `📋 <b>Broadcast Confirmation</b>\n\n` +
      `• Target: <b>${userCount}</b> registered bot users\n` +
      `• Type: <b>${payload.type.toUpperCase()}</b>\n\n` +
      `Are you ready to send this broadcast to all users?`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🚀 Confirm & Send Broadcast', callback_data: 'admin_broadcast_confirm' }],
            [{ text: '❌ Cancel', callback_data: 'admin_panel' }]
          ]
        }
      }
    );
  } else if (session.step === 'ADMIN_PROMO_WAIT_CONTENT') {
    session.step = 'ADMIN_PROMO_CONFIRM';
    wizardSessions.set(userId, session);

    const channels = await getChannelAuditList();
    const targetKeys = session.data.selectedChannelKeys || [];
    const isTargetAll = session.data.targetMode === 'all';

    const relevantChannels = isTargetAll
      ? channels
      : channels.filter(c => targetKeys.includes(c.channelKey));

    const eligible = relevantChannels.filter(c => c.isEligible).length;
    const skipped = relevantChannels.filter(c => !c.isEligible).length;

    // 1. Show preview to admin
    await bot.sendMessage(chatId, '📢 <b>CHANNEL PROMOTION PREVIEW:</b>', { parse_mode: 'HTML' });
    await sendPayloadSafely(bot, chatId, payload);

    // 2. Prompt confirmation
    await bot.sendMessage(
      chatId,
      `📋 <b>Channel Promotion Confirmation</b>\n\n` +
      `• Target Mode: <b>${isTargetAll ? 'All Eligible Channels' : 'Selected Channels'}</b>\n` +
      `• Eligible Channels: <b>${eligible}</b>\n` +
      `• Skipped (Ad-Free / Promo OFF): <b>${skipped}</b>\n` +
      `• Type: <b>${payload.type.toUpperCase()}</b>\n\n` +
      `Are you ready to publish this promotion? Destination channel owners will receive an automated notification upon delivery.`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🚀 Confirm & Publish Promotion', callback_data: 'admin_promo_confirm' }],
            [{ text: '❌ Cancel', callback_data: 'admin_panel' }]
          ]
        }
      }
    );
  }
}

/**
 * Handles callback queries for inline buttons.
 */
function setupCallbackQueryHandlers() {
  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const userId = String(query.from.id);
    const data = query.data;

    console.log(`[BOT] Received callback_query "${data}" from user ${userId}`);

    await bot.answerCallbackQuery(query.id).catch(() => {});

    // Navigation callbacks
    if (data === 'menu_main') {
      wizardSessions.delete(userId);
      let userDoc = null;
      if (isDatabaseConnected()) {
        userDoc = await User.findOne({ telegramUserId: userId }).catch(() => null);
      }
      return sendMainMenu(chatId, query.from.first_name, isUserAdmin(userId, userDoc));
    }

    if (data === 'menu_create') {
      return startCreateWizard(chatId, userId);
    }

    if (data === 'menu_list') {
      return showUserRules(chatId, userId);
    }

    if (data === 'menu_settings') {
      const userDoc = await User.findOne({ telegramUserId: userId }).catch(() => null);
      if (isUserAdmin(userId, userDoc)) {
        return showAdminStatus(chatId);
      }
      return bot.sendMessage(
        chatId,
        '⛔️ <b>Settings Restricted</b>\n\nAll system settings and diagnostics are managed exclusively inside the <b>Admin Panel</b>.',
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[{ text: '🔙 Main Menu', callback_data: 'menu_main' }]]
          }
        }
      );
    }

    if (data === 'menu_support') {
      return showContactSupport(chatId);
    }

    if (data === 'menu_referrals') {
      return showReferralsMenu(chatId, userId);
    }

    if (data === 'menu_promotions') {
      return showPlatformPromotions(chatId, userId);
    }

    if (data === 'toggle_promo_pref') {
      return togglePlatformPromotionsPref(chatId, userId);
    }

    // Admin Panel routing
    if (data.startsWith('admin_')) {
      let userDoc = null;
      if (isDatabaseConnected()) {
        userDoc = await User.findOne({ telegramUserId: userId }).catch(() => null);
      }
      if (!isUserAdmin(userId, userDoc)) {
        return bot.sendMessage(chatId, '⛔️ Access Denied: Admin privileges required.');
      }

      if (data === 'admin_panel') {
        wizardSessions.delete(userId);
        return sendAdminPanel(chatId);
      }

      if (data === 'admin_stats') {
        return showAdminStats(chatId);
      }

      if (data === 'admin_users') {
        return showAdminUsers(chatId);
      }

      if (data === 'admin_channels') {
        return showAdminChannels(chatId);
      }

      if (data === 'admin_rules') {
        return showAdminRules(chatId);
      }

      if (data === 'admin_referrals') {
        return showAdminReferrals(chatId);
      }

      if (data === 'admin_status' || data === 'admin_settings') {
        return showAdminStatus(chatId);
      }

      if (data === 'admin_broadcast_init') {
        return startAdminBroadcast(chatId, userId);
      }

      if (data === 'admin_broadcast_confirm') {
        const session = wizardSessions.get(userId);
        if (session && session.step === 'ADMIN_BROADCAST_CONFIRM' && session.data.payload) {
          wizardSessions.delete(userId);
          const progressMsg = await bot.sendMessage(chatId, '⏳ <b>Sending broadcast...</b> Please wait.', { parse_mode: 'HTML' });
          const results = await executeBroadcast(bot, userId, session.data.payload);
          await bot.deleteMessage(chatId, progressMsg.message_id).catch(() => {});

          const summaryText =
            `✅ <b>Broadcast Completed</b>\n\n` +
            `Sent: <b>${results.sentCount}</b>\n` +
            `Failed: <b>${results.failedCount}</b>\n` +
            `Skipped: <b>${results.skippedCount}</b>`;

          return bot.sendMessage(chatId, summaryText, {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [[{ text: '👑 Admin Panel', callback_data: 'admin_panel' }]]
            }
          });
        }
      }

      if (data === 'admin_promo_init') {
        return startAdminPromoTargeting(chatId, userId);
      }

      if (data === 'admin_promo_target_all') {
        wizardSessions.set(userId, {
          step: 'ADMIN_PROMO_WAIT_CONTENT',
          data: {
            adminId: userId,
            targetMode: 'all',
            selectedChannelKeys: []
          }
        });

        return bot.sendMessage(
          chatId,
          `📢 <b>Send Promotion to All Eligible Channels</b>\n\n` +
          `Please send the promotional message (Text, Photo with caption, Video with caption, or Document with caption).\n\n` +
          `<i>Note: Channels with Ad-Free rewards or with Platform Promotions toggled OFF are automatically skipped.</i>\n\n` +
          `Send /cancel to abort.`,
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'admin_panel' }]]
            }
          }
        );
      }

      if (data === 'admin_promo_target_select') {
        wizardSessions.set(userId, {
          step: 'ADMIN_PROMO_SELECT_CHANNELS',
          data: {
            adminId: userId,
            targetMode: 'specific',
            selectedChannelKeys: []
          }
        });
        return showAdminPromoChannelSelector(chatId, userId, []);
      }

      if (data.startsWith('admin_promo_toggle_')) {
        const key = data.replace('admin_promo_toggle_', '');
        const session = wizardSessions.get(userId) || {
          step: 'ADMIN_PROMO_SELECT_CHANNELS',
          data: { adminId: userId, targetMode: 'specific', selectedChannelKeys: [] }
        };

        const currentKeys = session.data.selectedChannelKeys || [];
        const index = currentKeys.indexOf(key);
        if (index > -1) {
          currentKeys.splice(index, 1);
        } else {
          currentKeys.push(key);
        }
        session.data.selectedChannelKeys = currentKeys;
        wizardSessions.set(userId, session);
        return showAdminPromoChannelSelector(chatId, userId, currentKeys);
      }

      if (data === 'admin_promo_select_done') {
        const session = wizardSessions.get(userId);
        const selected = session && session.data ? session.data.selectedChannelKeys : [];
        if (!selected || selected.length === 0) {
          return bot.sendMessage(chatId, '⚠️ Please select at least one channel.');
        }

        session.step = 'ADMIN_PROMO_WAIT_CONTENT';
        wizardSessions.set(userId, session);

        return bot.sendMessage(
          chatId,
          `📢 <b>Publishing to (${selected.length}) Selected Channels</b>\n\n` +
          `Please send the promotional message (Text, Photo, Video, or Document).\n\n` +
          `Send /cancel to abort.`,
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'admin_panel' }]]
            }
          }
        );
      }

      if (data === 'admin_promo_confirm') {
        const session = wizardSessions.get(userId);
        if (session && session.step === 'ADMIN_PROMO_CONFIRM' && session.data.payload) {
          wizardSessions.delete(userId);
          const progressMsg = await bot.sendMessage(chatId, '⏳ <b>Publishing promotion to channels...</b> Please wait.', { parse_mode: 'HTML' });
          const targetKeys = session.data.targetMode === 'specific' ? session.data.selectedChannelKeys : null;
          const results = await executeChannelPromotion(bot, userId, session.data.payload, targetKeys);
          await bot.deleteMessage(chatId, progressMsg.message_id).catch(() => {});

          let summaryText =
            `✅ <b>Promotion Completed</b>\n\n` +
            `Sent: <b>${results.sentCount}</b>\n` +
            `Failed: <b>${results.failedCount}</b>\n` +
            `Skipped: <b>${results.skippedCount}</b>`;

          if (results.skippedReasons && results.skippedReasons.length > 0) {
            summaryText += `\n\n🛡 <b>Skipped Channels:</b>\n`;
            results.skippedReasons.slice(0, 5).forEach((r) => {
              summaryText += `• ${escapeHtml(r.target)}: <i>${escapeHtml(r.reason)}</i>\n`;
            });
            if (results.skippedReasons.length > 5) {
              summaryText += `<i>...and ${results.skippedReasons.length - 5} more</i>\n`;
            }
          }

          return bot.sendMessage(chatId, summaryText, {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [[{ text: '👑 Admin Panel', callback_data: 'admin_panel' }]]
            }
          });
        }
      }
    }

    // Wizard Step 3 callbacks: Branding replacement
    if (data === 'branding_yes') {
      const session = wizardSessions.get(userId);
      if (session && session.step === 'WAIT_BRANDING_CHOICE') {
        session.data.brandingEnabled = true;
        session.step = 'WAIT_FIND_TEXT';
        wizardSessions.set(userId, session);

        return bot.sendMessage(
          chatId,
          `📝 <b>Branding Replacement:</b>\n\nWhat text should I find?\n\n<i>Example:</i> <code>@OldChannel</code>`,
          { parse_mode: 'HTML' }
        );
      }
    }

    if (data === 'branding_no') {
      const session = wizardSessions.get(userId);
      if (session && session.step === 'WAIT_BRANDING_CHOICE') {
        session.data.brandingEnabled = false;
        session.data.findText = '';
        session.data.replaceText = '';
        session.step = 'WAIT_FOOTER_CHOICE';
        wizardSessions.set(userId, session);

        return askFooterChoice(chatId);
      }
    }

    // Wizard Step 4 callbacks: Custom footer
    if (data === 'footer_add') {
      const session = wizardSessions.get(userId);
      if (session && session.step === 'WAIT_FOOTER_CHOICE') {
        session.step = 'WAIT_FOOTER_TEXT';
        wizardSessions.set(userId, session);

        return bot.sendMessage(
          chatId,
          `✍️ Send your custom footer text (Telegram formatting, links, and text are supported):`,
          { parse_mode: 'HTML' }
        );
      }
    }

    if (data === 'footer_skip') {
      const session = wizardSessions.get(userId);
      if (session && session.step === 'WAIT_FOOTER_CHOICE') {
        session.data.footer = '';
        session.step = 'CONFIRM_SUMMARY';
        wizardSessions.set(userId, session);

        return showSummary(chatId, session.data);
      }
    }

    // Wizard Step 5 callbacks: Activation confirmation
    if (data === 'confirm_activate') {
      const session = wizardSessions.get(userId);
      if (session && session.step === 'CONFIRM_SUMMARY') {
        return await activateRule(chatId, userId, session.data);
      }
    }

    if (data === 'confirm_cancel') {
      wizardSessions.delete(userId);
      return bot.sendMessage(chatId, '❌ Auto Forward creation cancelled.', {
        reply_markup: {
          inline_keyboard: [[{ text: '🔙 Back to Menu', callback_data: 'menu_main' }]]
        }
      });
    }

    // Rule management callbacks: rule_toggle_<id>, rule_delete_<id>
    if (data.startsWith('rule_toggle_')) {
      const ruleId = data.replace('rule_toggle_', '');
      return toggleRuleStatus(chatId, userId, ruleId);
    }

    if (data.startsWith('rule_delete_')) {
      const ruleId = data.replace('rule_delete_', '');
      return deleteRule(chatId, userId, ruleId);
    }
  });
}

/**
 * Handles incoming text and media messages during wizard steps.
 */
function setupTextMessageHandler() {
  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from.id);
    const session = wizardSessions.get(userId);

    // Check for cancel command during wizard
    if (msg.text && (msg.text === '/cancel' || msg.text === '/menu')) {
      wizardSessions.delete(userId);
      let userDoc = null;
      if (isDatabaseConnected()) {
        userDoc = await User.findOne({ telegramUserId: userId }).catch(() => null);
      }
      return sendMainMenu(chatId, msg.from ? msg.from.first_name : '', isUserAdmin(userId, userDoc));
    }

    if (!session) return;

    // Handle Admin Broadcast / Promo content input (supports text, photo, video, document)
    if (session.step === 'ADMIN_BROADCAST_WAIT_CONTENT' || session.step === 'ADMIN_PROMO_WAIT_CONTENT') {
      return handleAdminContentInput(chatId, userId, msg, session);
    }

    // For rule creation wizard steps, text is required
    if (!msg.text || msg.text.startsWith('/')) return;

    const text = msg.text.trim();

    switch (session.step) {
      case 'STEP_1_SOURCE':
        await handleStep1Source(chatId, userId, text, session);
        break;

      case 'STEP_2_DESTINATION':
        await handleStep2Destination(chatId, userId, text, session);
        break;

      case 'WAIT_FIND_TEXT':
        session.data.findText = text;
        session.step = 'WAIT_REPLACE_TEXT';
        wizardSessions.set(userId, session);

        await bot.sendMessage(
          chatId,
          `🔄 What should replace <code>${escapeHtml(text)}</code>?\n\n<i>Example:</i> <code>@MyChannel</code>`,
          { parse_mode: 'HTML' }
        );
        break;

      case 'WAIT_REPLACE_TEXT':
        session.data.replaceText = text;
        session.step = 'WAIT_FOOTER_CHOICE';
        wizardSessions.set(userId, session);

        await askFooterChoice(chatId);
        break;

      case 'WAIT_FOOTER_TEXT':
        session.data.footer = text;
        session.step = 'CONFIRM_SUMMARY';
        wizardSessions.set(userId, session);

        await showSummary(chatId, session.data);
        break;

      default:
        break;
    }
  });
}

/**
 * Initiates the Step-by-Step Auto Forward Wizard.
 */
function startCreateWizard(chatId, userId) {
  wizardSessions.set(userId, {
    step: 'STEP_1_SOURCE',
    data: {
      userId: userId,
      sourceChannelUsername: '',
      sourceChannelId: null,
      destinationChannelUsername: '',
      destinationChannelId: '',
      brandingEnabled: false,
      findText: '',
      replaceText: '',
      footer: '',
      active: true
    }
  });

  bot.sendMessage(
    chatId,
    `<b>STEP 1: Source Channel</b>\n\n` +
    `Send the public source channel username, for example <code>@examplechannel</code>`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'confirm_cancel' }]]
      }
    }
  );
}

/**
 * STEP 1: Validates and saves public source channel.
 */
async function handleStep1Source(chatId, userId, text, session) {
  let clean = text.trim().replace(/^https?:\/\/t\.me\//i, '').replace(/^@/, '');

  if (!clean || clean.length < 3) {
    return bot.sendMessage(chatId, '⚠️ Invalid channel username. Please provide a valid username, e.g. <code>@examplechannel</code>', { parse_mode: 'HTML' });
  }

  const validatingMsg = await bot.sendMessage(chatId, `🔍 Validating public channel <code>@${escapeHtml(clean)}</code>...`, { parse_mode: 'HTML' });

  // Attempt verification using Bot API first, then MTProto
  let resolvedChat = null;
  try {
    resolvedChat = await bot.getChat(`@${clean}`);
  } catch (apiErr) {
    // If Bot API cannot see it, try MTProto resolver
    resolvedChat = await resolvePublicChannel(clean);
  }

  await bot.deleteMessage(chatId, validatingMsg.message_id).catch(() => {});

  if (!resolvedChat) {
    return bot.sendMessage(
      chatId,
      `❌ Could not verify public source channel <code>@${escapeHtml(clean)}</code>.\n\n` +
      `Please ensure that:\n` +
      `1. The channel is <b>public</b>\n` +
      `2. The username is spelled correctly\n\n` +
      `Please send the source channel username again:`,
      { parse_mode: 'HTML' }
    );
  }

  session.data.sourceChannelUsername = `@${clean}`;
  session.data.sourceChannelId = resolvedChat.id ? String(resolvedChat.id) : null;
  session.step = 'STEP_2_DESTINATION';
  wizardSessions.set(userId, session);

  bot.sendMessage(
    chatId,
    `✅ Source channel verified: <b>${escapeHtml(resolvedChat.title || clean)}</b> (<code>@${escapeHtml(clean)}</code>)\n\n` +
    `<b>STEP 2: Destination Channel</b>\n\n` +
    `Send your destination channel username (e.g. <code>@mydestinationchannel</code>).`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'confirm_cancel' }]]
      }
    }
  );
}

/**
 * STEP 2: Validates destination channel and verifies bot posting permissions.
 */
async function handleStep2Destination(chatId, userId, text, session) {
  let clean = text.trim().replace(/^https?:\/\/t\.me\//i, '').replace(/^@/, '');

  if (!clean) {
    return bot.sendMessage(chatId, '⚠️ Please provide a destination channel username (e.g. <code>@mydestchannel</code>).', { parse_mode: 'HTML' });
  }

  const checkingMsg = await bot.sendMessage(chatId, `🔍 Checking posting permissions in <code>@${escapeHtml(clean)}</code>...`, { parse_mode: 'HTML' });

  try {
    const destChat = await bot.getChat(`@${clean}`);
    const botMember = await bot.getChatMember(destChat.id, botInfo.id);

    await bot.deleteMessage(chatId, checkingMsg.message_id).catch(() => {});

    const isAdmin = botMember.status === 'administrator' || botMember.status === 'creator';
    const canPost = botMember.status === 'creator' || botMember.can_post_messages;

    if (!isAdmin || !canPost) {
      return bot.sendMessage(
        chatId,
        `⚠️ <b>Permission Required</b>\n\n` +
        `The bot cannot post in <b>@${escapeHtml(clean)}</b>.\n\n` +
        `Please add <b>@${escapeHtml(botInfo.username)}</b> as an <b>Administrator</b> in that channel with the <b>"Post Messages"</b> permission enabled.\n\n` +
        `Once added, send the destination channel username again:`,
        { parse_mode: 'HTML' }
      );
    }

    session.data.destinationChannelUsername = `@${clean}`;
    session.data.destinationChannelId = String(destChat.id);
    session.step = 'WAIT_BRANDING_CHOICE';
    wizardSessions.set(userId, session);

    bot.sendMessage(
      chatId,
      `✅ Destination channel verified: <b>${escapeHtml(destChat.title || clean)}</b>\n\n` +
      `<b>STEP 3: Branding Replacement</b>\n\n` +
      `Do you want to replace branding?`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Yes', callback_data: 'branding_yes' },
              { text: '❌ No', callback_data: 'branding_no' }
            ]
          ]
        }
      }
    );
  } catch (err) {
    await bot.deleteMessage(chatId, checkingMsg.message_id).catch(() => {});
    return bot.sendMessage(
      chatId,
      `⚠️ <b>Channel Access Error:</b>\n` +
      `Could not access <code>@${escapeHtml(clean)}</code>.\n\n` +
      `Make sure you have added <b>@${escapeHtml(botInfo.username)}</b> as an Administrator to that channel, then try sending the username again.`,
      { parse_mode: 'HTML' }
    );
  }
}

/**
 * STEP 4: Asks if user wants a custom footer.
 */
function askFooterChoice(chatId) {
  bot.sendMessage(
    chatId,
    `<b>STEP 4: Custom Footer</b>\n\n` +
    `Would you like to automatically append a custom footer to reposted messages?`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '➕ Add Footer', callback_data: 'footer_add' },
            { text: '⏭ Skip', callback_data: 'footer_skip' }
          ]
        ]
      }
    }
  );
}

/**
 * STEP 5: Configuration Summary & Activation.
 */
function showSummary(chatId, data) {
  const brandingText = data.brandingEnabled
    ? `✅ <b>Enabled</b>\n   • Find: <code>${escapeHtml(data.findText)}</code>\n   • Replace with: <code>${escapeHtml(data.replaceText)}</code>`
    : `❌ <b>Disabled</b>`;

  const footerText = data.footer
    ? `<code>${escapeHtml(data.footer)}</code>`
    : `<i>(None)</i>`;

  const summary =
    `📋 <b>Configuration Summary</b>\n\n` +
    `• <b>Source Channel:</b> ${escapeHtml(data.sourceChannelUsername)}\n` +
    `• <b>Destination:</b> ${escapeHtml(data.destinationChannelUsername)}\n` +
    `• <b>Branding Replacement:</b>\n   ${brandingText}\n` +
    `• <b>Custom Footer:</b>\n   ${footerText}\n\n` +
    `Ready to activate this auto forwarding rule?`;

  bot.sendMessage(chatId, summary, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Activate', callback_data: 'confirm_activate' },
          { text: '❌ Cancel', callback_data: 'confirm_cancel' }
        ]
      ]
    }
  });
}

/**
 * Saves and activates rule in MongoDB.
 * Triggers referral completion if this user was referred by someone.
 */
async function activateRule(chatId, userId, data) {
  if (!isDatabaseConnected()) {
    return await bot.sendMessage(chatId, '⚠️ Database is currently unreachable. Please verify MongoDB connection.');
  }

  try {
    const newRule = await ForwardRule.create({
      userId: userId,
      sourceChannelUsername: data.sourceChannelUsername,
      sourceChannelId: data.sourceChannelId || null,
      destinationChannelUsername: data.destinationChannelUsername,
      destinationChannelId: data.destinationChannelId,
      brandingEnabled: Boolean(data.brandingEnabled),
      findText: data.findText || '',
      replaceText: data.replaceText || '',
      footer: data.footer || '',
      platformPromotionsEnabled: true,
      active: true
    });

    wizardSessions.delete(userId);

    console.log(`[BOT] New ForwardRule created: ${newRule.sourceChannelUsername} -> ${newRule.destinationChannelUsername} (Rule ID: ${newRule._id})`);

    // Check and complete referral if pending (Rule 6: completes only after basic setup)
    completeReferralIfPending(userId, bot).catch((refErr) => {
      console.error('[REFERRAL] Error in completeReferralIfPending:', refErr.message);
    });

    return await bot.sendMessage(
      chatId,
      `🎉 <b>Auto Forward Activated!</b>\n\n` +
      `Rule ID: <code>${newRule._id}</code>\n` +
      `New posts appearing in <b>${escapeHtml(newRule.sourceChannelUsername)}</b> will now be automatically processed and published to <b>${escapeHtml(newRule.destinationChannelUsername)}</b>.`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '📋 View My Rules', callback_data: 'menu_list' }],
            [{ text: '🔙 Main Menu', callback_data: 'menu_main' }]
          ]
        }
      }
    );
  } catch (error) {
    console.error('[ERROR] Failed to activate rule:', error.message);
    return await bot.sendMessage(chatId, `❌ Failed to save rule: ${escapeHtml(error.message || 'Unknown database error')}`, {
      parse_mode: 'HTML'
    });
  }
}

/**
 * Displays user's configured forwarding rules.
 */
async function showUserRules(chatId, userId) {
  if (!isDatabaseConnected()) {
    return bot.sendMessage(chatId, '⚠️ Database disconnected. Cannot load rules.');
  }

  try {
    const rules = await ForwardRule.find({ userId: userId }).sort({ createdAt: -1 });

    if (rules.length === 0) {
      return bot.sendMessage(
        chatId,
        `📋 <b>My Auto Forwards</b>\n\nYou have no active forwarding rules yet.`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '➕ Create Auto Forward', callback_data: 'menu_create' }],
              [{ text: '🔙 Back to Menu', callback_data: 'menu_main' }]
            ]
          }
        }
      );
    }

    let text = `📋 <b>Your Auto Forward Rules (${rules.length})</b>\n\n`;

    const inlineKeyboard = [];

    rules.forEach((rule, index) => {
      const statusIcon = rule.active ? '🟢 Active' : '⏸ Paused';
      text += `<b>${index + 1}. ${escapeHtml(rule.sourceChannelUsername)} ➔ ${escapeHtml(rule.destinationChannelUsername)}</b>\n`;
      text += `Status: ${statusIcon}\n`;
      text += `Branding: ${rule.brandingEnabled ? 'Yes' : 'No'} | Footer: ${rule.footer ? 'Yes' : 'No'}\n\n`;

      const toggleAction = rule.active ? '⏸ Pause' : '▶️ Resume';
      inlineKeyboard.push([
        { text: `${toggleAction} #${index + 1}`, callback_data: `rule_toggle_${rule._id}` },
        { text: `🗑 Delete #${index + 1}`, callback_data: `rule_delete_${rule._id}` }
      ]);
    });

    inlineKeyboard.push([{ text: '➕ Add Another Rule', callback_data: 'menu_create' }]);
    inlineKeyboard.push([{ text: '🔙 Back to Menu', callback_data: 'menu_main' }]);

    bot.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: inlineKeyboard }
    });
  } catch (error) {
    bot.sendMessage(chatId, `❌ Error loading rules: ${error.message}`);
  }
}

/**
 * Toggles a rule between active and paused.
 */
async function toggleRuleStatus(chatId, userId, ruleId) {
  try {
    const rule = await ForwardRule.findOne({ _id: ruleId, userId });
    if (!rule) {
      return bot.sendMessage(chatId, '⚠️ Rule not found.');
    }

    rule.active = !rule.active;
    await rule.save();

    console.log(`[BOT] Rule ${rule._id} toggled active=${rule.active}`);
    await showUserRules(chatId, userId);
  } catch (err) {
    bot.sendMessage(chatId, `❌ Error toggling rule: ${err.message}`);
  }
}

/**
 * Deletes a rule from MongoDB.
 */
async function deleteRule(chatId, userId, ruleId) {
  try {
    await ForwardRule.findOneAndDelete({ _id: ruleId, userId });
    console.log(`[BOT] Rule ${ruleId} deleted`);
    await showUserRules(chatId, userId);
  } catch (err) {
    bot.sendMessage(chatId, `❌ Error deleting rule: ${err.message}`);
  }
}

/**
 * System diagnostic settings (restricted to Admin Panel).
 */
async function showSettings(chatId) {
  return showAdminStatus(chatId);
}

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function getBotInstance() {
  return bot;
}

function isBotConnected() {
  return bot !== null;
}

function getBotStatus() {
  return {
    initialized: bot !== null,
    polling: bot !== null && typeof bot.isPolling === 'function' && bot.isPolling(),
    mode: isLeader() ? 'leader' : 'standby',
    username: botInfo ? botInfo.username : null
  };
}

module.exports = {
  initBot,
  getBotInstance,
  isBotConnected,
  getBotStatus,
  isLeader
};
