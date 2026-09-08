import { readFileSync } from 'node:fs';

export const SOURCE_PROMOTION_POLICY_VERSION = 1;

const sourcePolicy = JSON.parse(readFileSync(new URL('../../config/source-policy.json', import.meta.url), 'utf8'));
const configuredSourceOrder = Object.entries(sourcePolicy.sources || {})
  .sort(([, left], [, right]) => Number(right.priority) - Number(left.priority))
  .map(([source]) => source);

// Keep the default source order aligned with config/source-policy.json. All
// configured sources may supply safe contact evidence; field policy still
// limits automatic promotion to blank website_url and phone values.
export const SOURCE_PROMOTION_DEFAULTS = {
  entity: sourcePolicy.entity,
  // Highest configured priority wins for a blank field/place.
  sources: configuredSourceOrder,
  fields: ['website_url', 'phone'],
  matchMethods: ['exact_name_nearby', 'strong_spatial_name', 'imported_primary', 'reviewed_link', 'reviewed_new_import', 'scraped_first_party'],
  minConfidence: 0.9,
  limit: 50,
  maxUpdates: 50,
};

export const SOURCE_PROMOTION_FIELD_POLICIES = {
  website_url: {
    group: 'contact',
    disposition: 'auto_fill_if_blank',
    reason: 'Safe contact field; fill blank canonical values only from accepted high-confidence source evidence.',
    sourceKeys: ['website', 'website_url', 'contact:website', 'url'],
    normalize: normalizeWebsite,
    valid: isValidWebsite,
  },
  phone: {
    group: 'contact',
    disposition: 'auto_fill_if_blank',
    reason: 'Safe contact field; fill blank canonical values only from accepted high-confidence source evidence.',
    sourceKeys: ['phone', 'contact:phone', 'tel'],
    normalize: normalizePhone,
    valid: isValidPhone,
  },
  menu_url: {
    group: 'contact',
    disposition: 'evidence_only',
    reason: 'Useful factual field, but source-specific normalization and conflict rules are required before promotion.',
  },
  email: {
    group: 'contact',
    disposition: 'evidence_only',
    reason: 'Useful factual field, but source-specific normalization and conflict rules are required before promotion.',
  },
  instagram_url: {
    group: 'social',
    disposition: 'evidence_only',
    reason: 'Keep social evidence in place_sources until source-specific URL ownership rules exist.',
  },
  facebook_url: {
    group: 'social',
    disposition: 'evidence_only',
    reason: 'Keep social evidence in place_sources until source-specific URL ownership rules exist.',
  },
  twitter_url: {
    group: 'social',
    disposition: 'evidence_only',
    reason: 'Keep social evidence in place_sources until source-specific URL ownership rules exist.',
  },
  whatsapp: {
    group: 'social',
    disposition: 'evidence_only',
    reason: 'Keep social/contact evidence in place_sources until source-specific normalization rules exist.',
  },
  hours: {
    group: 'service',
    disposition: 'evidence_only',
    reason: 'Hours need freshness, timezone, and source ownership rules before promotion.',
  },
  delivery: {
    group: 'service',
    disposition: 'evidence_only',
    reason: 'Service flags should be promoted only after source-specific semantics are defined.',
  },
  takeaway: {
    group: 'service',
    disposition: 'evidence_only',
    reason: 'Service flags should be promoted only after source-specific semantics are defined.',
  },
  drive_through: {
    group: 'service',
    disposition: 'evidence_only',
    reason: 'Service flags should be promoted only after source-specific semantics are defined.',
  },
  outdoor_seating: {
    group: 'service',
    disposition: 'evidence_only',
    reason: 'Service flags should be promoted only after source-specific semantics are defined.',
  },
  indoor_seating: {
    group: 'service',
    disposition: 'evidence_only',
    reason: 'Service flags should be promoted only after source-specific semantics are defined.',
  },
  wheelchair: {
    group: 'service',
    disposition: 'evidence_only',
    reason: 'Accessibility flags should be promoted only after source-specific semantics are defined.',
  },
  name: {
    group: 'identity',
    disposition: 'manual_review_only',
    reason: 'Identity field; review source_review_queue candidates before changing it.',
  },
  address: {
    group: 'identity',
    disposition: 'manual_review_only',
    reason: 'Identity field; review source_review_queue candidates before changing it.',
  },
  lat: {
    group: 'identity',
    disposition: 'manual_review_only',
    reason: 'Identity field; review source_review_queue candidates before changing it.',
  },
  lng: {
    group: 'identity',
    disposition: 'manual_review_only',
    reason: 'Identity field; review source_review_queue candidates before changing it.',
  },
  state: {
    group: 'identity',
    disposition: 'manual_review_only',
    reason: 'Identity field; review source_review_queue candidates before changing it.',
  },
  google_place_id: {
    group: 'identity',
    disposition: 'manual_review_only',
    reason: 'Legacy external identity field; do not auto-promote from source evidence.',
  },
  brand: {
    group: 'identity',
    disposition: 'manual_review_only',
    reason: 'Brand/operator identity needs review because false chain attribution is expensive.',
  },
  brand_wikidata: {
    group: 'identity',
    disposition: 'manual_review_only',
    reason: 'Brand/operator identity needs review because false chain attribution is expensive.',
  },
  operator: {
    group: 'identity',
    disposition: 'manual_review_only',
    reason: 'Operator identity needs review because false attribution is expensive.',
  },
  operator_wikidata: {
    group: 'identity',
    disposition: 'manual_review_only',
    reason: 'Operator identity needs review because false attribution is expensive.',
  },
  style: {
    group: 'classifier_editorial',
    disposition: 'blocked',
    reason: 'Classifier/manual/editorial field; not a source-adapter promotion target.',
  },
  price: {
    group: 'classifier_editorial',
    disposition: 'blocked',
    reason: 'Classifier/manual/editorial field; not a source-adapter promotion target.',
  },
  price_range: {
    group: 'classifier_editorial',
    disposition: 'blocked',
    reason: 'Classifier/manual/editorial field; not a source-adapter promotion target.',
  },
  style_confidence: {
    group: 'classifier_editorial',
    disposition: 'blocked',
    reason: 'Classifier/manual/editorial field; not a source-adapter promotion target.',
  },
  rating: {
    group: 'editorial',
    disposition: 'blocked',
    reason: 'Manual/editorial field; source adapters must not promote it.',
  },
  notes: {
    group: 'editorial',
    disposition: 'blocked',
    reason: 'Manual/editorial field; source adapters must not promote it.',
  },
  status: {
    group: 'editorial',
    disposition: 'blocked',
    reason: 'Manual/user-facing field; source adapters must not promote it.',
  },
  lifecycle_status: {
    group: 'lifecycle',
    disposition: 'blocked',
    reason: 'Manual lifecycle field; source adapters must not decide whether a business is closed or replaced.',
  },
  lifecycle_replaced_by_id: {
    group: 'lifecycle',
    disposition: 'blocked',
    reason: 'Manual lifecycle relationship; replacement links require an explicit review action.',
  },
  photos: {
    group: 'editorial',
    disposition: 'blocked',
    reason: 'Manual/media workflow field; source adapters must not promote it.',
  },
};

export function autoPromotableSourceFields() {
  return Object.entries(SOURCE_PROMOTION_FIELD_POLICIES)
    .filter(([, policy]) => policy.disposition === 'auto_fill_if_blank')
    .map(([field]) => field);
}

export function blockedSourcePromotionFields() {
  return Object.entries(SOURCE_PROMOTION_FIELD_POLICIES)
    .filter(([, policy]) => ['manual_review_only', 'blocked', 'evidence_only'].includes(policy.disposition))
    .map(([field]) => field);
}

export function sourcePromotionFieldPolicy(field) {
  return SOURCE_PROMOTION_FIELD_POLICIES[field] || null;
}

export function assertAutoPromotableSourceField(field) {
  const policy = sourcePromotionFieldPolicy(field);
  if (!policy) {
    throw new Error(`Invalid --fields. Use any of: ${autoPromotableSourceFields().join(',')}`);
  }
  if (policy.disposition !== 'auto_fill_if_blank') {
    throw new Error(`Refusing to auto-promote ${field}: ${policy.reason}`);
  }
  return policy;
}

function normalizeWebsite(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const withProtocol = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(withProtocol);
    url.hash = '';
    return url.toString();
  } catch (error) {
    return null;
  }
}

function isValidWebsite(value) {
  const normalized = normalizeWebsite(value);
  if (!normalized) return false;
  try {
    const url = new URL(normalized);
    return ['http:', 'https:'].includes(url.protocol) && Boolean(url.hostname?.includes('.'));
  } catch (error) {
    return false;
  }
}

function normalizePhone(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  return text.replace(/\s+/g, ' ');
}

function isValidPhone(value) {
  const text = normalizePhone(value);
  if (!text) return false;
  const digits = text.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 16;
}
