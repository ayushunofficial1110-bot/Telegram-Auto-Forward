const ForwardRule = require('../models/ForwardRule');
const ProcessedMessage = require('../models/ProcessedMessage');
const { processTextContent } = require('./branding');
const { isDatabaseConnected } = require('./database');

// In-memory buffer for album / media group aggregation
const albumBuffer = new Map();
const ALBUM_DEBOUNCE_MS = 1500;

let botInstance = null;

function setBotInstance(bot) {
  botInstance = bot;
}

/**
 * Handles incoming MTProto channel messages.
 */
async function handleIncomingMessage(message, client) {
  if (!message || !client) return;

  try {
    // 1. Resolve source channel
    let chat = null;
    try {
      chat = await message.getChat();
    } catch (chatError) {
      // If getChat fails, try peerId directly
    }

    const sourceUsername = (chat && chat.username) ? chat.username.toLowerCase().replace(/^@/, '') : '';
    const sourceId = (chat && chat.id) ? chat.id.toString() : (message.chatId ? message.chatId.toString() : null);

    if (!sourceUsername && !sourceId) {
      return;
    }

    // Check database connection
    if (!isDatabaseConnected()) {
      return;
    }

    // 2. Find all active rules matching source channel username or ID
    const queryConditions = [];
    if (sourceUsername) {
      queryConditions.push({ sourceChannelUsername: new RegExp(`^@?${sourceUsername}$`, 'i') });
    }
    if (sourceId) {
      queryConditions.push({ sourceChannelId: sourceId });
    }

    if (queryConditions.length === 0) {
      return;
    }

    const matchingRules = await ForwardRule.find({
      active: true,
      $or: queryConditions
    });

    if (!matchingRules || matchingRules.length === 0) {
      return;
    }

    const displaySource = sourceUsername ? `@${sourceUsername}` : `Channel ID ${sourceId}`;
    console.log(`[REPOST] New message detected from ${displaySource} (ID: ${message.id})`);

    // Protected content check: do not attempt to bypass Telegram protected content
    if (message.noforwards) {
      console.log(`[REPOST] Message ${message.id} has protected content / noforwards flag; safely skipped.`);
      return;
    }

    // Handle Media Groups / Albums
    if (message.groupedId) {
      const groupKey = message.groupedId.toString();
      handleAlbumMessage(groupKey, message, client, matchingRules, sourceId || sourceUsername);
      return;
    }

    // Process single message across all matching rules
    for (const rule of matchingRules) {
      await processSingleMessageForRule(message, client, rule, sourceId || sourceUsername);
    }
  } catch (err) {
    console.error('[ERROR] Error processing incoming MTProto message:', err.message);
  }
}

/**
 * Buffers and aggregates media group / album items before publishing as a cohesive album.
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
        console.error(`[ERROR] Failed to forward media group for rule ${rule._id}:`, err.message);
      }
    }
  }, ALBUM_DEBOUNCE_MS);
}

/**
 * Processes a single message for a specific forward rule.
 */
async function processSingleMessageForRule(message, client, rule, sourceIdentifier) {
  if (!botInstance) {
    console.error('[ERROR] Bot instance not configured for repost engine.');
    return;
  }

  const destChatId = rule.destinationChannelId || rule.destinationChannelUsername;
  const destDisplay = rule.destinationChannelUsername || rule.destinationChannelId;

  try {
    // 3. Check duplicate in ProcessedMessage
    const existing = await ProcessedMessage.findOne({
      ruleId: rule._id,
      sourceMessageId: message.id
    });

    if (existing) {
      console.log(`[REPOST] Duplicate skipped: message ID ${message.id} for rule ${rule._id}`);
      return;
    }

    // 4 & 5. Prepare raw text and preserve formatting / captions
    const rawText = message.message || '';
    const processedText = processTextContent(rawText, rule);

    let sentMessage = null;

    // Detect media types
    if (!message.media) {
      // Plain text message
      if (!processedText.trim()) {
        return;
      }

      sentMessage = await botInstance.sendMessage(destChatId, processedText);
    } else {
      const mediaClass = message.media.className || message.media.constructor.name || '';

      if (mediaClass.includes('Photo') || message.media.photo) {
        // Photo with caption
        const mediaBuffer = await downloadMediaSafely(client, message);
        if (!mediaBuffer) return;

        sentMessage = await botInstance.sendPhoto(destChatId, mediaBuffer, {
          caption: processedText || undefined
        });
      } else if (mediaClass.includes('Document') || message.media.document) {
        const doc = message.media.document;
        const mimeType = doc ? doc.mimeType : '';
        const isVideo = mimeType && mimeType.startsWith('video');

        const mediaBuffer = await downloadMediaSafely(client, message);
        if (!mediaBuffer) return;

        if (isVideo) {
          sentMessage = await botInstance.sendVideo(destChatId, mediaBuffer, {
            caption: processedText || undefined
          });
        } else {
          // Document / File
          const fileName = extractFileName(message) || 'file';
          sentMessage = await botInstance.sendDocument(destChatId, mediaBuffer, {
            caption: processedText || undefined
          }, {
            filename: fileName
          });
        }
      } else {
        console.log(`[REPOST] Unsupported message media type '${mediaClass}' for message ID ${message.id}; skipped.`);
        return;
      }
    }

    if (sentMessage) {
      console.log(`[REPOST] Published message to ${destDisplay} (Source ID: ${message.id} -> Dest ID: ${sentMessage.message_id})`);

      // 9. Record in ProcessedMessage
      await ProcessedMessage.create({
        ruleId: rule._id,
        sourceChannelId: String(sourceIdentifier),
        sourceMessageId: message.id,
        destinationMessageId: sentMessage.message_id,
        status: 'completed'
      });
    }
  } catch (error) {
    handleRepostError(error, destDisplay, message.id);
  }
}

/**
 * Processes an entire media group / album for a specific forward rule.
 */
async function processAlbumForRule(messages, client, rule, sourceIdentifier) {
  if (!botInstance || messages.length === 0) return;

  const destChatId = rule.destinationChannelId || rule.destinationChannelUsername;
  const destDisplay = rule.destinationChannelUsername || rule.destinationChannelId;

  // Filter out any messages already processed
  const unhandledMessages = [];
  for (const msg of messages) {
    const exists = await ProcessedMessage.findOne({
      ruleId: rule._id,
      sourceMessageId: msg.id
    });
    if (!exists) {
      unhandledMessages.push(msg);
    }
  }

  if (unhandledMessages.length === 0) {
    return;
  }

  try {
    const firstMsg = unhandledMessages[0];
    const rawCaption = firstMsg.message || '';
    const processedCaption = processTextContent(rawCaption, rule);

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

    const sentResults = await botInstance.sendMediaGroup(destChatId, mediaGroup);
    console.log(`[REPOST] Published album (${mediaGroup.length} items) to ${destDisplay}`);

    // Record each item in ProcessedMessage
    for (let i = 0; i < downloadedBuffers.length; i++) {
      const srcId = downloadedBuffers[i].msg.id;
      const destId = sentResults && sentResults[i] ? sentResults[i].message_id : null;

      await ProcessedMessage.create({
        ruleId: rule._id,
        sourceChannelId: String(sourceIdentifier),
        sourceMessageId: srcId,
        destinationMessageId: destId,
        status: 'completed'
      });
    }
  } catch (error) {
    handleRepostError(error, destDisplay, messages.map(m => m.id).join(','));
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
 * Centralized error handler for reposting operations.
 */
function handleRepostError(error, destDisplay, messageId) {
  const errMsg = error.message || String(error);

  if (errMsg.includes('chat not found') || errMsg.includes('Forbidden') || errMsg.includes('need administrator rights')) {
    console.error(`[ERROR] Destination permission denied for ${destDisplay}: ${errMsg}`);
  } else if (errMsg.includes('FLOOD_WAIT') || errMsg.includes('429')) {
    console.warn(`[REPOST] Rate limit / FLOOD_WAIT encountered while posting to ${destDisplay}: ${errMsg}`);
  } else {
    console.error(`[ERROR] Repost failed for message ${messageId} to ${destDisplay}:`, errMsg);
  }
}

/**
 * Placeholder for future MVP+ edited post synchronization.
 */
async function handleEditedMessage(message, client) {
  // Structured for future edit sync integration
  console.log(`[REPOST] Post edit detected on message ID ${message.id}. Edit sync is reserved for future versions.`);
}

/**
 * Placeholder for future MVP+ deleted post synchronization.
 */
async function handleDeletedMessage(messageIds) {
  // Structured for future deletion sync integration
}

module.exports = {
  setBotInstance,
  handleIncomingMessage,
  handleEditedMessage,
  handleDeletedMessage
};
