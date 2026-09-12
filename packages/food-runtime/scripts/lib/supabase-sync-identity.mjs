const LEGACY_MAX_DISTANCE_METERS = 25;
const STABLE_ID_MAX_DISTANCE_METERS = 250;

function contextOf(local, current, options) {
  const entity = options?.entity ?? local?.entity ?? local?.entity_type ?? current?.entity ?? current?.entity_type ?? 'unknown';
  const id = local?.id ?? current?.id ?? '(missing)';
  return `entity=${String(entity)} id=${String(id)}`;
}

function fail(local, current, reason, options) {
  throw new Error(`Supabase place identity check failed (${contextOf(local, current, options)}): ${reason}`);
}

function numericId(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function stableId(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function normalizedName(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u0027\u2019]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function coordinatePair(row, local, current, options) {
  const lat = row?.lat;
  const lng = row?.lng;
  const hasLat = lat !== undefined && lat !== null;
  const hasLng = lng !== undefined && lng !== null;
  if (!hasLat && !hasLng) return null;
  if (!hasLat || !hasLng || lat === '' || lng === '') {
    fail(local, current, 'invalid coordinates', options);
  }
  const latitude = typeof lat === 'number' ? lat : (typeof lat === 'string' && lat.trim() !== '' ? Number(lat) : NaN);
  const longitude = typeof lng === 'number' ? lng : (typeof lng === 'string' && lng.trim() !== '' ? Number(lng) : NaN);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    fail(local, current, 'invalid coordinates', options);
  }
  return { latitude, longitude };
}

function distanceMeters(first, second) {
  const radians = value => value * Math.PI / 180;
  const dLat = radians(second.latitude - first.latitude);
  const dLng = radians(second.longitude - first.longitude);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(radians(first.latitude)) * Math.cos(radians(second.latitude)) * Math.sin(dLng / 2) ** 2;
  const bounded = Math.max(0, Math.min(1, a));
  return 6371008.8 * 2 * Math.atan2(Math.sqrt(bounded), Math.sqrt(1 - bounded));
}

function compatibleState(local, current) {
  const first = String(local?.state ?? '').trim().toUpperCase();
  const second = String(current?.state ?? '').trim().toUpperCase();
  return !first || !second || first === second;
}

/**
 * Verify that a public row is the same canonical place as the local row.
 *
 * This intentionally ignores mutable or contaminated contact fields such as
 * website and phone. A missing public google_place_id is accepted only for a
 * strong legacy match: exact normalized name, compatible state, and a valid
 * coordinate distance of at most 25m.
 */
export function assertSupabasePlaceIdentity(local, current, options = {}) {
  const localId = numericId(local?.id);
  const currentId = numericId(current?.id);
  if (!localId || !currentId || localId !== currentId) {
    fail(local, current, 'numeric id mismatch or missing numeric id', options);
  }

  const localStableId = stableId(local?.google_place_id);
  const currentStableId = stableId(current?.google_place_id);
  if (localStableId && currentStableId && localStableId !== currentStableId) {
    fail(local, current, 'stable google_place_id mismatch', options);
  }
  if (!localStableId) {
    fail(local, current, 'local stable google_place_id is missing', options);
  }

  const localCoordinates = coordinatePair(local, local, current, options);
  const currentCoordinates = coordinatePair(current, local, current, options);

  if (!currentStableId) {
    const sameName = normalizedName(local?.name) !== ''
      && normalizedName(local?.name) === normalizedName(current?.name);
    const near = localCoordinates && currentCoordinates
      && distanceMeters(localCoordinates, currentCoordinates) <= LEGACY_MAX_DISTANCE_METERS;
    if (!sameName || !near || !compatibleState(local, current)) {
      fail(local, current, 'public stable identity missing without a strong legacy match', options);
    }
    return { ok: true, legacy: true };
  }

  if (localCoordinates && currentCoordinates && distanceMeters(localCoordinates, currentCoordinates) > STABLE_ID_MAX_DISTANCE_METERS) {
    fail(local, current, 'stable identity has an egregious coordinate conflict', options);
  }
  return { ok: true, legacy: false };
}
