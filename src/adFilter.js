/**
 * Advertisement and Promotional Content Filter
 *
 * Analyzes Telegram post text/captions to identify whether a post is
 * clearly an advertisement, sponsored post, paid promotion, referral promotion,
 * or promotional message using weighted multi-signal detection.
 */

// 1. Explicit / Definitive Ad Indicators (Weight: 3.5 - sufficient to classify as promotional)
const EXPLICIT_AD_PATTERNS = [
  // Hashtags and explicit tags
  /(?:^|\s)#(?:ad|ads|advertisement|sponsored|promo|promotion|promotional|paidpromo|paidpromotion|paidpartnership|collab|affiliate)\b/i,
  /\[(?:ad|ads|advertisement|sponsored|promo|promotion|paid\s*promo)\]/i,
  /\((?:ad|ads|advertisement|sponsored|promo|promotion|paid\s*promo)\)/i,
  /【(?:广告|推广)】/,

  // Explicit sponsorship/paid post disclosures
  /\bpaid\s+promotion\b/i,
  /\bsponsored\s+post\b/i,
  /\bpromotional\s+post\b/i,
  /\bpaid\s+(?:ad|advertisement|ads)\b/i,
  /\bsponsored\s+by\b/i,
  /\bpromoted\s+by\b/i,
  /\bpromoted\s+content\b/i,

  // Direct advertising sales / solicitation / contact
  /\badvertise\s+with\s+us\b/i,
  /\badvertise\s+here\b/i,
  /\b(?:contact|dm|pm|msg|message|reach\s+out)\s+(?:us\s+)?(?:for|to)\s+(?:paid\s+)?(?:promotion|promotions|promo|ads|advertising)\b/i,
  /\bfor\s+(?:paid\s+)?(?:promotion|promotions|promo|ads|advertising)\s+(?:contact|dm|pm|msg|message)\b/i,
  /\b(?:promotion|promo|ads|advertising)\s+(?:deal|deals|inquiry|inquiries|charges|rates|contact|available)\b/i,
  /\b(?:promotion|ads?)\s*(?:ke\s+liye|keliye)\s*(?:sampark|contact|dm|message)\b/i,
  /\bpaid\s*promo\b/i,

  // Referral and coupon calls to action
  /\b(?:use|apply)\s+(?:my\s+)?(?:referral|invite|coupon|promo|discount|voucher)\s+code\b/i,
  /\b(?:referral|invite|promo|coupon|discount|voucher)\s+code\s*:\s*[\w\d]+/i,
  /\buse\s+code\s*:\s*[\w\d]+/i,
  /\brefer\s+(?:and|&)\s+earn\b/i,
  /\bshare\s+(?:and|&)\s+earn\b/i,
  /\binvite\s+friends\s+(?:and|&)\s+earn\b/i,

  // Suspicious betting / gambling / color-prediction channel spam
  /\b(?:loss\s+recovery|100%\s+fixed\s+match|color\s+prediction|sure\s+shot\s+fixed|guaranteed\s+profit\s+daily)\b/i
];

// 2. Medium Promotional Signals (Weight: 1.5 each)
const MEDIUM_SIGNALS = [
  // Commercial offers and discounts
  { pattern: /\bpromotional\s+offer\b/i, label: 'promotional offer' },
  { pattern: /\b(?:exclusive|special|limited\s+time)\s+offer\b/i, label: 'special offer' },
  { pattern: /\b(?:flat|up\s+to|\b)\s*\d+%\s*(?:off|discount)\b/i, label: 'percentage discount' },
  { pattern: /\b(?:huge|mega|massive|unbelievable)\s+(?:discount|loot|sale)\b/i, label: 'discount/loot sale' },
  { pattern: /\bbuy\s+\d+\s+get\s+\d+\s+free\b/i, label: 'buy X get Y free' },
  { pattern: /\b(?:cashback|bonus)\s+(?:offer|deal)\b/i, label: 'cashback offer' },
  { pattern: /\b(?:claim|grab)\s+(?:your\s+)?(?:offer|deal|discount|gift|bonus)\b/i, label: 'claim offer' },
  { pattern: /\b(?:loot\s+deal|loot\s+offer|cheapest\s+price)\b/i, label: 'loot deal' },

  // Call-to-action to join other channels / promotional links
  { pattern: /\bjoin\s+(?:our\s+)?(?:backup|private|vip|secret|trading|premium)\s+channel\b/i, label: 'join backup/vip channel' },
  { pattern: /\bmust\s+join\s+(?:this\s+)?channel\b/i, label: 'must join channel' },
  { pattern: /\blink\s+(?:will\s+be\s+revoked|expires|valid)\s+(?:in|for)\s+\d+/i, label: 'expiring join link urgency' },
  { pattern: /\bjoin\s+fast\b/i, label: 'join fast' },
  { pattern: /\bjaldi\s+join\s+karo\b/i, label: 'join fast (hinglish)' },

  // Financial / earning claims
  { pattern: /\b(?:earn|make)\s+(?:\$|₹|rs\.?|inr)?\s*\d+[k\d]*\s+(?:daily|per\s+day|every\s+day|monthly)\b/i, label: 'earn daily money claim' },
  { pattern: /\b(?:deposit|sign\s*up|registration)\s+bonus\b/i, label: 'sign up/deposit bonus' },
  { pattern: /\bwithout\s+any?\s+investment\b/i, label: 'no investment claim' },
  { pattern: /\binstant\s+(?:withdrawal|payout|credit)\b/i, label: 'instant withdrawal claim' },

  // Referral / Affiliate links or keywords
  { pattern: /\breferral\s+link\b/i, label: 'referral link' },
  { pattern: /\baffiliate\s+link\b/i, label: 'affiliate link' },
  { pattern: /\bdownload\s+(?:and\s+earn|app\s+and\s+get)\b/i, label: 'download and earn' },
  { pattern: /\border\s+now\s+at\b/i, label: 'order now at' },
  { pattern: /\bbuy\s+now\s+(?:at|on|from)\b/i, label: 'buy now from' }
];

// 3. Low / Contextual Signals (Weight: 1.0 each)
const CONTEXTUAL_SIGNALS = [
  // Links with referral params or shorteners
  { pattern: /(?:https?:\/\/)?(?:www\.)?(?:bit\.ly|tinyurl\.com|amzn\.to|fkrt\.it|cutt\.ly|t\.ly|rb\.gy)\/[a-zA-Z0-9_-]+/i, label: 'shortened/affiliate URL' },
  { pattern: /[?&](?:ref|referral|aff|affiliate|invite|promo|code)=/i, label: 'referral URL parameter' },
  { pattern: /https?:\/\/t\.me\/(?:\+|joinchat\/)[a-zA-Z0-9_-]+/i, label: 'telegram private invite link' },

  // Contact for business / DM handle
  { pattern: /\b(?:contact|dm|pm|message)\s+(?:me\s+)?(?:at\s+)?@[a-zA-Z0-9_]{4,}/i, label: 'direct message / handle contact' },

  // Urgency
  { pattern: /\b(?:hurry\s+up|don['’]?t\s+miss\s+out|limited\s+(?:time|spots|seats|stock)|ends\s+soon|offer\s+valid\s+till|last\s+chance)\b/i, label: 'urgency marker' },

  // Generic promo terms in isolated usage
  { pattern: /\b(?:advertisement|advertisements|advertising)\b/i, label: 'generic advertisement word' },
  { pattern: /\b(?:sponsored|sponsor|sponsors)\b/i, label: 'generic sponsor word' },
  { pattern: /\b(?:promotion|promotional|promotions)\b/i, label: 'generic promotion word' },
  { pattern: /\b(?:discount|discounts)\b/i, label: 'generic discount word' },
  { pattern: /\b(?:giveaway|giveaways)\b/i, label: 'giveaway' }
];

// Threshold to decide if post is promotional
const PROMOTION_THRESHOLD = 3.0;

/**
 * Analyzes the text content and returns detailed signal detection results.
 * @param {string} text - Message text or media caption
 * @returns {{ isPromotional: boolean, score: number, signals: string[] }}
 */
function analyzePromotionalContent(text) {
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return {
      isPromotional: false,
      score: 0,
      signals: []
    };
  }

  const cleanText = text.trim();
  let score = 0;
  const signals = [];

  // 1. Check Explicit Patterns (High confidence: 3.5 points each)
  for (const pattern of EXPLICIT_AD_PATTERNS) {
    const match = cleanText.match(pattern);
    if (match) {
      score += 3.5;
      signals.push(`explicit:${match[0]}`);
      // If we already hit an explicit ad pattern, it's definitively promotional
      break;
    }
  }

  // 2. Check Medium Signals (1.5 points each)
  for (const item of MEDIUM_SIGNALS) {
    if (item.pattern.test(cleanText)) {
      score += 1.5;
      signals.push(`medium:${item.label}`);
    }
  }

  // 3. Check Contextual Signals (1.0 point each)
  for (const item of CONTEXTUAL_SIGNALS) {
    if (item.pattern.test(cleanText)) {
      score += 1.0;
      signals.push(`context:${item.label}`);
    }
  }

  const isPromotional = score >= PROMOTION_THRESHOLD;

  return {
    isPromotional,
    score: Number(score.toFixed(1)),
    signals
  };
}

/**
 * Quick boolean check: is this post an advertisement or promotional content?
 * @param {string} text - Message text or media caption
 * @returns {boolean}
 */
function isPromotionalPost(text) {
  const result = analyzePromotionalContent(text);
  return result.isPromotional;
}

module.exports = {
  isPromotionalPost,
  analyzePromotionalContent,
  PROMOTION_THRESHOLD
};
