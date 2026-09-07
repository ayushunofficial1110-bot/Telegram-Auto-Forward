const ForwardRule = require('../models/ForwardRule');
const ProcessedMessage = require('../models/ProcessedMessage');
const { replaceBranding, appendFooter, escapeRegExp } = require('./branding');
const { isDatabaseConnected } = require('./database');
const { isPromotionalPost } = require('./adFilter');
const { syncWatchedChannels, startPeriodicChannelSync } = require('./telegramClient');

// In-memory buffer for album / media group aggregation
const albumBuffer = new Map();
const ALBUM_DEBOUNCE_MS = 1500;

let botInstance = null;

function setBotInstance(bot) {
  botInstance = bot;
}

/**
 * Synchronizes all active source channels from MongoDB with MTProto's channel difference polling.
 */
async function refreshWatchedChannels() {
  if (!isDatabaseConnected()) return;
  try {
    const activeRules = await ForwardRule.find({ active: true }).lean();
    const channelsToWatch = [];
    for (const rule of activeRules) {
      if (rule.sourceChannelUsername) {
        channelsToWatch.push(rule.sourceChannelUsername);
      }
      if (rule.sourceChannelId) {
        channelsToWatch.push(rule.sourceChannelId);
      }
    }
    if (channelsToWatch.length > 0) {
      await syncWatchedChannels(channelsToWatch);
    }
  } catch (err) {
    console.error('[ERROR] Failed to refresh watched channels:', err.message);
  }
}

// Start periodic channel sync every 60 seconds
startPeriodicChannelSync(refreshWatchedChannels);

/**
 * Extracts and normalizes channel IDs and usernames from an MTProto message.
 * Inspects message.peerId, message.chatId, and message.getChat() to ensure
 * reliable source identification even if Telegram omits username or formats IDs differently.
 */
async function extractSourceIdentifiers(message, client) {
  let rawChannelId = null;
  let markedChannelId = null;
  let chat = null;

  try {
    if (typeof message.getChat === 'function') {
      chat = await message.getChat();
    }
  } catch (_) {
    // getChat can fail if network times out or entity not cached; proceed with peerId inspection
  }

  // 1. Direct inspection of message.peerId (most authoritative)
  if (message.peerId) {
    if (message.peerId.channelId) {
      rawChannelId = message.peerId.channelId.toString();
      markedChannelId = `-100${rawChannelId}`;
    } else if (message.peerId.chatId) {
      rawChannelId = message.peerId.chatId.toString();
      markedChannelId = `-${rawChannelId}`;
    } else if (message.peerId.userId) {
      rawChannelId = message.peerId.userId.toString();
      markedChannelId = rawChannelId;
    }
  }

  // 2. Fallback to chat object if available
  if (chat && chat.id) {
    const cid = chat.id.toString();
    const bare = cid.replace(/^-100/, '').replace(/^-/, '');
    if (!rawChannelId) {
      rawChannelId = bare;
      markedChannelId = `-100${bare}`;
    }
  }

  // 3. Fallback to message.chatId
  if (!rawChannelId && message.chatId) {
    const cid = message.chatId.toString();
    const bare = cid.replace(/^-100/, '').replace(/^-/, '');
    rawChannelId = bare;
    markedChannelId = `-100${bare}`;
  }

  // Extract username
  let sourceUsername = '';
  if (chat && chat.username) {
    sourceUsername = chat.username.toLowerCase().replace(/^@/, '');
  }

  // If username not yet found, attempt lookup in client's in-memory entity cache
  if (!sourceUsername && rawChannelId && client && client._entityCache) {
    try {
      const cached = client._entityCache.get(rawChannelId) || client._entityCache.get(markedChannelId);
      if (cached && cached.username) {
        sourceUsername = cached.username.toLowerCase().replace(/^@/, '');
      }
    } catch (_) {}
  }

  const possibleIds = [];
  if (markedChannelId) possibleIds.push(markedChannelId);
  if (rawChannelId && rawChannelId !== markedChannelId) possibleIds.push(rawChannelId);

  return {
    rawChannelId,
    markedChannelId,
    possibleIds,
    sourceUsername,
    chat
  };
}

/**
 * Determines media type for logging and API dispatch.
 */
function detectMediaType(message) {
  if (!message || !message.media) return 'text';

  const mediaClass = message.media.className || message.media.constructor?.name || '';
  if (mediaClass.includes('Photo') || message.media.photo) {
    return 'photo';
  }

  if (mediaClass.includes('Document') || message.media.document) {
    const doc = message.media.document;
    const mimeType = doc ? doc.mimeType : '';
    if (mimeType && mimeType.startsWith('video')) {
      return 'video';
    }
    if (mimeType && mimeType.startsWith('audio')) {
      return 'audio';
    }
    return 'document';
  }

  return 'other';
}

/**
 * Central MTProto incoming message handler.
 * Implements the single central forwarding pipeline with isolated error handling per stage.
 */
async function handleIncomingMessage(message, client) {
  if (!message || !client) return;

  // Stage 1: MTProto Event
  console.log('[MTProto] New message received');
  console.log(`[MTProto] Message ID: ${message.id}`);

  try {
    // Stage 2: Source Detection
    const sourceInfo = await extractSourceIdentifiers(message, client);
    const { rawChannelId, markedChannelId, possibleIds, sourceUsername } = sourceInfo;
    const mediaType = detectMediaType(message);

    console.log('[MTProto] Source channel detected');
    console.log(`[SOURCE]\nchannelId=${markedChannelId || rawChannelId || 'unknown'}\nusername=${sourceUsername ? `@${sourceUsername}` : 'unknown'}\nmessageId=${message.id}`);

    if (possibleIds.length === 0 && !sourceUsername) {
      console.log(`[ROUTER] Could not determine source identifier for message ID ${message.id}; skipped.`);
      return;
    }

    // Stage 3: Active Rule Matching
    console.log('[ROUTER] Checking active forwarding rules');

    if (!isDatabaseConnected()) {
      console.warn('[ROUTER] Database not connected; cannot query forward rules.');
      return;
    }

    const queryConditions = [];
    if (possibleIds.length > 0) {
      queryConditions.push({ sourceChannelId: { $in: possibleIds } });
    }
    if (sourceUsername) {
      queryConditions.push({ sourceChannelUsername: new RegExp(`^@?${escapeRegExp(sourceUsername)}$`, 'i') });
    }

    const matchingRules = await ForwardRule.find({
      active: true,
      $or: queryConditions
    });

    if (!matchingRules || matchingRules.length === 0) {
      console.log('[ROUTER] No matching active rule');
      return;
    }

    for (const rule of matchingRules) {
      const sourceDesc = rule.sourceChannelUsername || rule.sourceChannelId;
      const destDesc = rule.destinationChannelUsername || rule.destinationChannelId;
      console.log(`[ROUTER] Rule found:\nruleId=${rule._id}\nsource=${sourceDesc}\ndestination=${destDesc}`);
    }

    // Check protected content flag
    if (message.noforwards) {
      console.log(`[REPOST] Message ${message.id} has protected content / noforwards flag; safely skipped.`);
      return;
    }

    const sourceIdentifier = markedChannelId || rawChannelId || sourceUsername;

    // Handle Media Groups / Albums
    if (message.groupedId) {
      const groupKey = message.groupedId.toString();
      handleAlbumMessage(groupKey, message, client, matchingRules, sourceIdentifier);
      return;
    }

    // Process single message across each matching rule with strict error isolation
    for (const rule of matchingRules) {
      try {
        await processSingleMessageForRule(message, client, rule, sourceIdentifier, mediaType);
      } catch (ruleError) {
        console.error(`[ERROR] Stage=rule_processing ruleId=${rule._id} messageId=${message.id} error=${ruleError.message}\nstack=${ruleError.stack}`);
      }
    }
  } catch (err) {
    console.error(`[ERROR] Stage=incoming_handler messageId=${message ? message.id : 'unknown'} error=${err.message}\nstack=${err.stack}`);
  }
}

/**
 * Buffers and aggregates media group / album items before publishing.
 */
function handleAlbumMessage(groupKey, message, client, matchingRules, sourceIdentifier) {
  let entry = albumBuffer.get(groupKey);

  if (!entry) {
    entry = {
      messages: [],
      timer: null
    };
    albumBuffer.set(groupKey, entry);
  }

  // Clear pending debounce timer
  if (entry.timer) {
    clearTimeout(entry.timer);
  }

  // Push item if not already in list
  if (!entry.messages.some(m => m.id === message.id)) {
    entry.messages.push(message);
  }

  // Set debounce timer to publish whole album together
  entry.timer = setTimeout(async () => {
    albumBuffer.delete(groupKey);
    const messagesToProcess = entry.messages.sort((a, b) => a.id - b.id);

    for (const rule of matchingRules) {
      try {
        await processAlbumForRule(messagesToProcess, client, rule, sourceIdentifier);
      } catch (err) {
        console.error(`[ERROR] Failed to forward media group for rule ${rule._id}:`, err.message, '\nstack=', err.stack);
      }
    }
  }, ALBUM_DEBOUNCE_MS);
}

/**
 * Processes a single message for a specific forward rule.
 * Pipeline: Dedup Check -> Ad Filter -> Branding (optional) -> Footer (optional) -> Send -> Mark Success
 */
async function processSingleMessageForRule(message, client, rule, sourceIdentifier, mediaType) {
  if (!botInstance) {
    console.error('[ERROR] Bot instance not configured for repost engine.');
    return;
  }

  const destChatId = rule.destinationChannelId || rule.destinationChannelUsername;
  const destDisplay = rule.destinationChannelUsername || rule.destinationChannelId;

  // Stage 4: Per-Rule Dedup Check
  console.log(`[DEDUP] Checking message\nsourceChannelId=${sourceIdentifier}\nmessageId=${message.id}\nruleId=${rule._id}`);

  const existing = await ProcessedMessage.findOne({
    ruleId: rule._id,
    sourceMessageId: message.id,
    status: { $in: ['completed', 'skipped'] }
  });

  if (existing) {
    console.log('[DEDUP] Already processed - skipping');
    return;
  }

  console.log('[DEDUP] New message - continue processing');

  // Stage 5: Ad Filter Check
  const rawText = message.message || '';
  console.log('[AD-FILTER] Checking message');

  let isAd = false;
  try {
    isAd = isPromotionalPost(rawText);
  } catch (adErr) {
    console.error(`[ERROR] Stage=ad_filter messageId=${message.id} error=${adErr.message}`);
    isAd = false;
  }

  if (isAd) {
    console.log('[AD-FILTER] Promotional post detected - skipping');
    // Record skipped promotional post to prevent duplicate reprocessing
    await ProcessedMessage.create({
      ruleId: rule._id,
      sourceChannelId: String(sourceIdentifier),
      sourceMessageId: message.id,
      destinationMessageId: null,
      status: 'skipped'
    }).catch(createErr => {
      if (createErr.code !== 11000) {
        console.error('[ERROR] ProcessedMessage create skipped error:', createErr.message);
      }
    });
    return;
  }

  console.log('[AD-FILTER] Normal post - forwarding');

  // Stage 6: Branding (Optional & Isolated)
  let processedText = rawText;
  if (!rule.brandingEnabled || !rule.findText) {
    console.log('[BRANDING] Disabled - using original content');
  } else {
    try {
      console.log('[BRANDING] Processing started');
      processedText = replaceBranding(processedText, rule.findText, rule.replaceText);
      console.log('[BRANDING] Replacement completed');
    } catch (brandErr) {
      console.error(`[ERROR] Stage=branding ruleId=${rule._id} messageId=${message.id} error=${brandErr.message}\nstack=${brandErr.stack}`);
      // Fallback to unbranded content on error
      processedText = rawText;
    }
  }

  // Stage 7: Footer (Optional & Isolated)
  const footerText = (rule.footer || '').trim();
  if (!footerText) {
    console.log('[FOOTER] Disabled');
  } else {
    try {
      processedText = appendFooter(processedText, footerText);
      console.log('[FOOTER] Footer appended');
    } catch (footerErr) {
      console.error(`[ERROR] Stage=footer ruleId=${rule._id} messageId=${message.id} error=${footerErr.message}\nstack=${footerErr.stack}`);
    }
  }

  // Stage 8: Destination Send
  console.log(`[FORWARD] Type=${mediaType}`);
  console.log(`[FORWARD] Sending message\nruleId=${rule._id}\nsourceMessageId=${message.id}\ndestination=${destDisplay}`);

  let sentMessage = null;
  try {
    if (mediaType === 'text') {
      if (!processedText.trim()) {
        console.log(`[FORWARD] Empty text message ID ${message.id} - skipped`);
        return;
      }
      sentMessage = await botInstance.sendMessage(destChatId, processedText);
    } else if (mediaType === 'photo') {
      const mediaBuffer = await downloadMediaSafely(client, message);
      if (!mediaBuffer) return;
      sentMessage = await botInstance.sendPhoto(destChatId, mediaBuffer, {
        caption: processedText || undefined
      });
    } else if (mediaType === 'video') {
      const mediaBuffer = await downloadMediaSafely(client, message);
      if (!mediaBuffer) return;
      sentMessage = await botInstance.sendVideo(destChatId, mediaBuffer, {
        caption: processedText || undefined
      });
    } else if (mediaType === 'document' || mediaType === 'audio') {
      const mediaBuffer = await downloadMediaSafely(client, message);
      if (!mediaBuffer) return;
      const fileName = extractFileName(message) || 'file';
      sentMessage = await botInstance.sendDocument(destChatId, mediaBuffer, {
        caption: processedText || undefined
      }, {
        filename: fileName
      });
    } else {
      console.log(`[REPOST] Unsupported message media type for message ID ${message.id}; skipped.`);
      return;
    }

    if (sentMessage) {
      console.log(`[FORWARD] SUCCESS\nsourceMessageId=${message.id}\ndestination=${destDisplay}`);

      // Stage 9: Mark Success (ONLY after destination sending succeeds)
      await ProcessedMessage.create({
        ruleId: rule._id,
        sourceChannelId: String(sourceIdentifier),
        sourceMessageId: message.id,
        destinationMessageId: sentMessage.message_id,
        status: 'completed'
      }).catch(dbErr => {
        if (dbErr.code !== 11000) {
          console.error('[ERROR] Failed to save ProcessedMessage:', dbErr.message);
        }
      });
    }
  } catch (sendError) {
    console.error(`[FORWARD] FAILED\nsourceMessageId=${message.id}\ndestination=${destDisplay}\nerror=${sendError.message}\nstack=${sendError.stack}`);
  }
}

/**
 * Processes an entire media group / album for a specific forward rule.
 */
async function processAlbumForRule(messages, client, rule, sourceIdentifier) {
  if (!botInstance || messages.length === 0) return;

  const destChatId = rule.destinationChannelId || rule.destinationChannelUsername;
  const destDisplay = rule.destinationChannelUsername || rule.destinationChannelId;

  // Filter out messages already processed
  const unhandledMessages = [];
  for (const msg of messages) {
    console.log(`[DEDUP] Checking message\nsourceChannelId=${sourceIdentifier}\nmessageId=${msg.id}\nruleId=${rule._id}`);
    const exists = await ProcessedMessage.findOne({
      ruleId: rule._id,
      sourceMessageId: msg.id,
      status: { $in: ['completed', 'skipped'] }
    });
    if (!exists) {
      console.log('[DEDUP] New message - continue processing');
      unhandledMessages.push(msg);
    } else {
      console.log('[DEDUP] Already processed - skipping');
    }
  }

  if (unhandledMessages.length === 0) {
    return;
  }

  try {
    const rawCaption = unhandledMessages.find(m => m.message && m.message.trim().length > 0)?.message || unhandledMessages[0].message || '';

    // Ad Filter Check
    console.log('[AD-FILTER] Checking message');
    let isAd = false;
    try {
      isAd = isPromotionalPost(rawCaption);
    } catch (adErr) {
      console.error(`[ERROR] Stage=ad_filter album error=${adErr.message}`);
      isAd = false;
    }

    if (isAd) {
      console.log(`[AD-FILTER] Promotional post detected - skipping`);
      for (const msg of unhandledMessages) {
        await ProcessedMessage.create({
          ruleId: rule._id,
          sourceChannelId: String(sourceIdentifier),
          sourceMessageId: msg.id,
          destinationMessageId: null,
          status: 'skipped'
        }).catch(() => {});
      }
      return;
    }

    console.log(`[AD-FILTER] Normal post - forwarding`);

    // Branding (Optional & Isolated)
    let processedCaption = rawCaption;
    if (!rule.brandingEnabled || !rule.findText) {
      console.log('[BRANDING] Disabled - using original content');
    } else {
      try {
        console.log('[BRANDING] Processing started');
        processedCaption = replaceBranding(processedCaption, rule.findText, rule.replaceText);
        console.log('[BRANDING] Replacement completed');
      } catch (brandErr) {
        console.error(`[ERROR] Stage=branding ruleId=${rule._id} album error=${brandErr.message}`);
        processedCaption = rawCaption;
      }
    }

    // Footer (Optional & Isolated)
    const footerText = (rule.footer || '').trim();
    if (!footerText) {
      console.log('[FOOTER] Disabled');
    } else {
      try {
        processedCaption = appendFooter(processedCaption, footerText);
        console.log('[FOOTER] Footer appended');
      } catch (footerErr) {
        console.error(`[ERROR] Stage=footer ruleId=${rule._id} album error=${footerErr.message}`);
      }
    }

    const mediaGroup = [];
    const downloadedBuffers = [];

    for (let i = 0; i < unhandledMessages.length; i++) {
      const msg = unhandledMessages[i];
      const buffer = await downloadMediaSafely(client, msg);
      if (!buffer) continue;

      downloadedBuffers.push({ msg, buffer });

      const doc = msg.media && msg.media.document;
      const isVideo = doc && doc.mimeType && doc.mimeType.startsWith('video');

      mediaGroup.push({
        type: isVideo ? 'video' : 'photo',
        media: buffer,
        caption: i === 0 && processedCaption ? processedCaption : undefined
      });
    }

    if (mediaGroup.length === 0) {
      return;
    }

    console.log(`[FORWARD] Type=album (${mediaGroup.length} items)`);
    console.log(`[FORWARD] Sending message\nruleId=${rule._id}\nsourceMessageId=${unhandledMessages[0].id}\ndestination=${destDisplay}`);

    const sentResults = await botInstance.sendMediaGroup(destChatId, mediaGroup);

    console.log(`[FORWARD] SUCCESS\nsourceMessageId=${unhandledMessages[0].id}\ndestination=${destDisplay}`);

    // Record each sent message in ProcessedMessage
    for (let i = 0; i < downloadedBuffers.length; i++) {
      const srcId = downloadedBuffers[i].msg.id;
      const destId = sentResults && sentResults[i] ? sentResults[i].message_id : null;

      await ProcessedMessage.create({
        ruleId: rule._id,
        sourceChannelId: String(sourceIdentifier),
        sourceMessageId: srcId,
        destinationMessageId: destId,
        status: 'completed'
      }).catch(() => {});
    }
  } catch (error) {
    console.error(`[FORWARD] FAILED\nsourceMessageId=${unhandledMessages[0].id}\ndestination=${destDisplay}\nerror=${error.message}\nstack=${error.stack}`);
  }
}

/**
 * Downloads media safely from MTProto client.
 */
async function downloadMediaSafely(client, message) {
  try {
    const buffer = await client.downloadMedia(message);
    if (!buffer) {
      console.warn(`[REPOST] Warning: Empty media buffer returned for message ID ${message.id}`);
      return null;
    }
    return buffer;
  } catch (err) {
    console.error(`[ERROR] Failed to download media for message ID ${message.id}:`, err.message);
    return null;
  }
}

/**
 * Extracts file name from document attributes if available.
 */
function extractFileName(message) {
  try {
    const doc = message.media && message.media.document;
    if (doc && doc.attributes) {
      for (const attr of doc.attributes) {
        if (attr.fileName) return attr.fileName;
      }
    }
  } catch (e) {
    // ignore
  }
  return null;
}

/**
 * Placeholder for future MVP+ edited post synchronization.
 */
async function handleEditedMessage(message, client) {
  console.log(`[REPOST] Post edit detected on message ID ${message.id}. Edit sync is reserved for future versions.`);
}

/**
 * Placeholder for future MVP+ deleted post synchronization.
 */
async function handleDeletedMessage(messageIds) {
  // Reserved for future deletion sync integration
}

module.exports = {
  setBotInstance,
  handleIncomingMessage,
  handleEditedMessage,
  handleDeletedMessage,
  refreshWatchedChannels
};
