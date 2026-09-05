/**
 * Utility functions for branding replacement and footer customization.
 */

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replaces all occurrences of findText with replaceText.
 * Uses case-insensitive regex for robust matching against usernames and links.
 */
function replaceBranding(text, findText, replaceText) {
  if (!text || !findText) {
    return text || '';
  }

  try {
    const escaped = escapeRegExp(findText.trim());
    const regex = new RegExp(escaped, 'gi');
    return text.replace(regex, replaceText || '');
  } catch (error) {
    console.error('[ERROR] Error replacing branding:', error.message);
    return text;
  }
}

/**
 * Appends a custom footer with a blank line preceding it.
 */
function appendFooter(text, footer) {
  const cleanFooter = (footer || '').trim();
  if (!cleanFooter) {
    return text || '';
  }

  const cleanText = (text || '').trim();
  if (!cleanText) {
    return cleanFooter;
  }

  return `${cleanText}\n\n${cleanFooter}`;
}

/**
 * Applies all active branding and footer transformations according to the rule.
 */
function processTextContent(rawText, rule) {
  let processed = rawText || '';

  if (rule.brandingEnabled && rule.findText) {
    processed = replaceBranding(processed, rule.findText, rule.replaceText);
  }

  if (rule.footer) {
    processed = appendFooter(processed, rule.footer);
  }

  return processed;
}

module.exports = {
  escapeRegExp,
  replaceBranding,
  appendFooter,
  processTextContent
};
