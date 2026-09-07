import {
  PIPELINE_API_VERSION,
  canonicalize,
  type CanonicalJson,
  type CanonicalJsonValidator,
  type RecordEnvelope,
  type StagePluginManifest,
} from "@map-pipeline/core";
import { definePlugin, type StagePlugin } from "@map-pipeline/sdk";
import {
  APIZZA_SOURCE_CANDIDATE_SCHEMA,
  classifyApizzaCandidateRouteV1,
  normalizeApizzaCandidateTextV1,
  type ApizzaCandidateRouteV1,
  type ApizzaCandidateRoutingPayloadV1,
} from "./candidate-v1.js";

export const APIZZA_CANONICAL_MATCH_SNAPSHOT_SCHEMA = {
  name: "apizza.canonical-match-snapshot",
  version: 1,
} as const;
export const APIZZA_MATCH_DECISIONS_SCHEMA = {
  name: "apizza.match-decisions",
  version: 1,
} as const;
export const APIZZA_MATCH_REPORT_SCHEMA = {
  name: "apizza.match-report",
  version: 1,
} as const;

export type ApizzaCandidateRoute = ApizzaCandidateRouteV1;

export type ApizzaMatchMethod =
  | "exact_identifier_nearby"
  | "exact_name_nearby"
  | "strong_spatial_name"
  | "weak_spatial_name"
  | "spatial_only_review"
  | "no_match";

export type ApizzaMatchDisposition =
  | "not_compared"
  | "matched_existing"
  | "ambiguous_review"
  | "likely_new"
  | "closed_evidence"
  | "closed_evidence_dropped";

export interface ApizzaSourceCandidatePayload {
  source_id: string | null;
  name: string | null;
  lat: number | null;
  lng: number | null;
  website: string | null;
  phone: string | null;
  region: string | null;
  source_url: string | null;
  categories: string[];
  is_closed: boolean;
  route: ApizzaCandidateRoute;
  [key: string]: unknown;
}

export interface ApizzaCanonicalPlaceV1 {
  canonical_place_id: string;
  name: string | null;
  address: string | null;
  state: string | null;
  google_place_id: string | null;
  website_url: string | null;
  phone: string | null;
  lat: number;
  lng: number;
}

export interface ApizzaCanonicalSnapshotV1 {
  version: 1;
  rows: ApizzaCanonicalPlaceV1[];
}

export interface ApizzaIdentifierMatchV1 {
  website: boolean;
  phone: boolean;
  exact: boolean;
}

export interface ApizzaEvaluatedPlaceV1 {
  canonical_place_id: string;
  name: string | null;
  google_place_id: string | null;
  distance_m: number;
  name_score: number;
  identifier_match: ApizzaIdentifierMatchV1;
  match_method: ApizzaMatchMethod;
}

export interface ApizzaNearestPlaceV1 {
  canonical_place_id: string;
  name: string | null;
  google_place_id: string | null;
  distance_m: number;
  name_score: number;
}

export interface ApizzaMatchDecisionV1 {
  source_record_key: string;
  observation_id: string;
  source_id: string | null;
  candidate_route: ApizzaCandidateRoute;
  disposition: ApizzaMatchDisposition;
  best_match: ApizzaEvaluatedPlaceV1 | null;
  nearest_place: ApizzaNearestPlaceV1 | null;
  stable_source_id_present: boolean;
}

export interface ApizzaMatchingV1Config {
  maxDistanceM?: number;
  gridCellDegrees?: number;
  prefetchTileDegrees?: number;
  prefetchBatchSize?: number;
}

export interface ResolvedApizzaMatchingV1Config {
  maxDistanceM: number;
  gridCellDegrees: number;
  prefetchTileDegrees: number;
  prefetchBatchSize: number;
}

export interface ApizzaMatchReportV1 {
  version: 1;
  profile: "apizzamichigan";
  matcher: "legacy-source-port-v1";
  partition: string;
  config: ResolvedApizzaMatchingV1Config;
  candidate_route_counts: Record<ApizzaCandidateRoute, number>;
  candidate_rows: number;
  active_candidates_compared: number;
  closed_candidates_compared: number;
  canonical_snapshot_rows: number;
  canonical_rows_prefetched: number;
  canonical_prefetch_tiles: number;
  canonical_prefetch_queries: number;
  grid_cells_built: number;
  matched_existing_places: number;
  ambiguous_review_candidates: number;
  likely_new_unmatched_candidates: number;
  closed_signals_matched: number;
  legacy_active_matches_with_source_id: number;
  closed_evidence_dropped: number;
  decision_rows: number;
}

export interface ApizzaMatchingV1Result {
  decisions: ApizzaMatchDecisionV1[];
  report: ApizzaMatchReportV1;
}

interface InternalEvaluatedPlace extends ApizzaCanonicalPlaceV1 {
  distanceM: number;
  nameScore: number;
  identifierMatch: ApizzaIdentifierMatchV1;
  matchMethod: ApizzaMatchMethod;
}

interface PrefetchBox {
  latitudeCell: number;
  longitudeCell: number;
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

export const APIZZA_MATCHING_V1_MAX_CANDIDATES = 5_000;
export const APIZZA_MATCHING_V1_MAX_CANONICAL_ROWS = 500_000;

const MATCHABLE_ROUTES = new Set<ApizzaCandidateRoute>([
  "ready_for_match",
  "closed_evidence_candidate",
]);

const ALL_ROUTES: readonly ApizzaCandidateRoute[] = [
  "ready_for_match",
  "closed_evidence_candidate",
  "filtered_non_pizza",
  "excluded_unusable",
  "excluded_out_of_scope",
];

const ALL_METHODS: readonly ApizzaMatchMethod[] = [
  "exact_identifier_nearby",
  "exact_name_nearby",
  "strong_spatial_name",
  "weak_spatial_name",
  "spatial_only_review",
  "no_match",
];

const ALL_DISPOSITIONS: readonly ApizzaMatchDisposition[] = [
  "not_compared",
  "matched_existing",
  "ambiguous_review",
  "likely_new",
  "closed_evidence",
  "closed_evidence_dropped",
];

const DEFAULT_CONFIG: ResolvedApizzaMatchingV1Config = {
  maxDistanceM: 100,
  gridCellDegrees: 0.02,
  prefetchTileDegrees: 1,
  prefetchBatchSize: 100,
};

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertCandidateInputs(
  candidates: Array<RecordEnvelope<ApizzaSourceCandidatePayload>>,
  partition: string,
): void {
  if (candidates.length > APIZZA_MATCHING_V1_MAX_CANDIDATES) {
    throw new TypeError(
      `APizza matching v1 accepts at most ${APIZZA_MATCHING_V1_MAX_CANDIDATES} candidates`,
    );
  }
  let priorKey: [string, string] | null = null;
  let priorCanonical: string | null = null;
  for (const [index, candidate] of candidates.entries()) {
    const payload = candidate?.payload;
    if (
      !candidate ||
      typeof candidate.sourceRecordKey !== "string" ||
      !candidate.sourceRecordKey ||
      typeof candidate.observationId !== "string" ||
      !candidate.observationId ||
      candidate.partition !== partition ||
      !payload ||
      typeof payload !== "object" ||
      !ALL_ROUTES.includes(payload.route) ||
      !isStringOrNull(payload.source_id) ||
      !isStringOrNull(payload.name) ||
      !isStringOrNull(payload.website) ||
      !isStringOrNull(payload.phone) ||
      !isStringOrNull(payload.region) ||
      !isStringOrNull(payload.source_url) ||
      !Array.isArray(payload.categories) ||
      payload.categories.some((category) => typeof category !== "string") ||
      !(payload.lat === null || (typeof payload.lat === "number" && Number.isFinite(payload.lat))) ||
      !(payload.lng === null || (typeof payload.lng === "number" && Number.isFinite(payload.lng))) ||
      typeof payload.is_closed !== "boolean"
    ) {
      throw new TypeError(`APizza candidate ${index} does not match the matcher input contract`);
    }
    const { route, ...payloadWithoutRoute } = payload;
    if (route !== classifyApizzaCandidateRouteV1(
        payloadWithoutRoute as ApizzaCandidateRoutingPayloadV1,
    )) {
      throw new TypeError(`APizza candidate ${index} route contradicts its payload`);
    }
    const currentKey: [string, string] = [candidate.sourceRecordKey, candidate.observationId];
    const currentCanonical = canonicalize(candidate as unknown as CanonicalJson);
    if (priorKey && (
      compareUtf8(currentKey[0], priorKey[0]) < 0 ||
      (currentKey[0] === priorKey[0] && compareUtf8(currentKey[1], priorKey[1]) < 0)
    )) {
      throw new TypeError("APizza candidates must be canonically ordered by source record and observation ID");
    }
    if (
      priorKey &&
      currentKey[0] === priorKey[0] &&
      currentKey[1] === priorKey[1] &&
      currentCanonical !== priorCanonical
    ) {
      throw new TypeError("Duplicate APizza candidate identities must have identical content");
    }
    priorKey = currentKey;
    priorCanonical = currentCanonical;
  }
}

function assertCanonicalSnapshot(value: unknown): asserts value is ApizzaCanonicalSnapshotV1 {
  assertObject(value, "APizza canonical snapshot");
  if (!exactKeys(value, ["version", "rows"]) || value.version !== 1 || !Array.isArray(value.rows)) {
    throw new TypeError("APizza canonical snapshot must contain exact v1 rows");
  }
  if (value.rows.length > APIZZA_MATCHING_V1_MAX_CANONICAL_ROWS) {
    throw new TypeError(
      `APizza matching v1 accepts at most ${APIZZA_MATCHING_V1_MAX_CANONICAL_ROWS} canonical rows`,
    );
  }
  let priorCanonicalId: string | null = null;
  for (const [index, rawPlace] of value.rows.entries()) {
    assertObject(rawPlace, `APizza canonical snapshot row ${index}`);
    if (
      !exactKeys(rawPlace, [
        "canonical_place_id", "name", "address", "state", "google_place_id",
        "website_url", "phone", "lat", "lng",
      ]) ||
      typeof rawPlace.canonical_place_id !== "string" ||
      !rawPlace.canonical_place_id ||
      Buffer.byteLength(rawPlace.canonical_place_id, "utf8") > 256 ||
      !isStringOrNull(rawPlace.name) ||
      !isStringOrNull(rawPlace.address) ||
      !isStringOrNull(rawPlace.state) ||
      !isStringOrNull(rawPlace.google_place_id) ||
      !isStringOrNull(rawPlace.website_url) ||
      !isStringOrNull(rawPlace.phone) ||
      typeof rawPlace.lat !== "number" ||
      !Number.isFinite(rawPlace.lat) ||
      rawPlace.lat < -90 ||
      rawPlace.lat > 90 ||
      typeof rawPlace.lng !== "number" ||
      !Number.isFinite(rawPlace.lng) ||
      rawPlace.lng < -180 ||
      rawPlace.lng > 180
    ) throw new TypeError(`APizza canonical snapshot row ${index} does not match v1`);
    if (
      priorCanonicalId !== null &&
      compareUtf8(rawPlace.canonical_place_id, priorCanonicalId) <= 0
    ) {
      throw new TypeError("Canonical snapshot IDs must be strictly increasing in UTF-8 order");
    }
    priorCanonicalId = rawPlace.canonical_place_id;
  }
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function resolveConfig(config: unknown): ResolvedApizzaMatchingV1Config {
  assertObject(config, "APizza matching v1 config");
  if (
    ![Object.prototype, null].includes(Object.getPrototypeOf(config)) ||
    Object.keys(config).some((key) => !(key in DEFAULT_CONFIG))
  ) throw new TypeError("APizza matching v1 config has unexpected fields");
  const resolved = {
    ...DEFAULT_CONFIG,
    ...(config as ApizzaMatchingV1Config),
  };
  if (Object.entries(DEFAULT_CONFIG).some(([name, value]) =>
    resolved[name as keyof ResolvedApizzaMatchingV1Config] !== value)) {
    throw new TypeError("APizza matching v1 configuration is pinned to the legacy defaults");
  }
  return resolved;
}

export function normalizeApizzaMatchText(value: unknown): string {
  return normalizeApizzaCandidateTextV1(value);
}

function nameTokens(value: unknown): string[] {
  const ignored = new Set(["the", "and", "pizza", "pizzeria", "restaurant", "bar", "grill"]);
  return normalizeApizzaMatchText(value)
    .split(" ")
    .filter((token) => token.length > 1 && !ignored.has(token));
}

export function apizzaNameScore(left: unknown, right: unknown): number {
  const normalizedLeft = normalizeApizzaMatchText(left);
  const normalizedRight = normalizeApizzaMatchText(right);
  if (!normalizedLeft || !normalizedRight) return 0;
  if (normalizedLeft === normalizedRight) return 1;
  if (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)) return 0.85;
  const leftTokens = nameTokens(left);
  const rightTokens = nameTokens(right);
  if (!leftTokens.length || !rightTokens.length) return 0;
  const rightSet = new Set(rightTokens);
  const shared = leftTokens.filter((token) => rightSet.has(token)).length;
  return shared / Math.max(leftTokens.length, rightTokens.length);
}

export function normalizeApizzaMatchPhone(value: unknown): string {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length >= 7 ? digits.slice(-10) : "";
}

export function normalizeApizzaMatchUrl(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?/, "")
    .replace(/\/+$/, "");
}

export function apizzaIdentifierMatch(
  candidate: Pick<ApizzaSourceCandidatePayload, "website" | "phone">,
  place: Pick<ApizzaCanonicalPlaceV1, "website_url" | "phone">,
): ApizzaIdentifierMatchV1 {
  const sourcePhone = normalizeApizzaMatchPhone(candidate.phone);
  const placePhone = normalizeApizzaMatchPhone(place.phone);
  const sourceWebsite = normalizeApizzaMatchUrl(candidate.website);
  const placeWebsite = normalizeApizzaMatchUrl(place.website_url);
  const website = Boolean(
    sourceWebsite && placeWebsite && sourceWebsite === placeWebsite && sourceWebsite.includes("/"),
  );
  const phone = Boolean(sourcePhone && placePhone && sourcePhone === placePhone);
  return { website, phone, exact: website || phone };
}

export function apizzaMatchMethod(
  distanceM: number,
  nameScore: number,
  identifierMatch = false,
): ApizzaMatchMethod {
  if (identifierMatch && distanceM <= 100) return "exact_identifier_nearby";
  if (distanceM <= 25 && nameScore >= 0.99) return "exact_name_nearby";
  if (distanceM <= 75 && nameScore >= 0.99) return "strong_spatial_name";
  if (distanceM <= 50 && nameScore >= 0.6) return "strong_spatial_name";
  if (distanceM <= 100 && nameScore >= 0.35) return "weak_spatial_name";
  if (distanceM <= 25) return "spatial_only_review";
  return "no_match";
}

export function apizzaHaversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRadians = (value: number) => value * Math.PI / 180;
  const earthRadiusM = 6_371_000;
  const latitudeDelta = toRadians(lat2 - lat1);
  const longitudeDelta = toRadians(lng2 - lng1);
  const value = Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 2 * earthRadiusM * Math.asin(Math.min(1, Math.sqrt(value)));
}

function buildPrefetchBoxes(
  candidates: Array<RecordEnvelope<ApizzaSourceCandidatePayload>>,
  config: ResolvedApizzaMatchingV1Config,
): PrefetchBox[] {
  const tiles = new Map<string, PrefetchBox>();
  for (const candidate of candidates) {
    const { lat, lng } = candidate.payload;
    if (lat === null || lng === null) {
      throw new TypeError("Matchable APizza candidates must have finite coordinates");
    }
    const latitudeCell = Math.floor(lat / config.prefetchTileDegrees);
    const longitudeCell = Math.floor(lng / config.prefetchTileDegrees);
    const key = `${latitudeCell}:${longitudeCell}`;
    const tile = tiles.get(key);
    if (tile) {
      tile.minLat = Math.min(tile.minLat, lat);
      tile.maxLat = Math.max(tile.maxLat, lat);
      tile.minLng = Math.min(tile.minLng, lng);
      tile.maxLng = Math.max(tile.maxLng, lng);
    } else {
      tiles.set(key, {
        latitudeCell,
        longitudeCell,
        minLat: lat,
        maxLat: lat,
        minLng: lng,
        maxLng: lng,
      });
    }
  }
  const latitudePadding = config.maxDistanceM / 111_320;
  return [...tiles.values()].map((tile) => {
    const centerLatitude = (tile.minLat + tile.maxLat) / 2;
    const longitudePadding = config.maxDistanceM /
      (111_320 * Math.max(Math.cos(centerLatitude * Math.PI / 180), 0.01));
    return {
      latitudeCell: tile.latitudeCell,
      longitudeCell: tile.longitudeCell,
      minLat: tile.minLat - latitudePadding,
      maxLat: tile.maxLat + latitudePadding,
      minLng: tile.minLng - longitudePadding,
      maxLng: tile.maxLng + longitudePadding,
    };
  });
}

function prefetchCanonicalRows(
  rows: readonly ApizzaCanonicalPlaceV1[],
  boxes: readonly PrefetchBox[],
  tileDegrees: number,
): ApizzaCanonicalPlaceV1[] {
  const boxesByCell = new Map(
    boxes.map((box) => [`${box.latitudeCell}:${box.longitudeCell}`, box]),
  );
  return rows.filter((place) => {
    const latitudeCell = Math.floor(place.lat / tileDegrees);
    const longitudeCell = Math.floor(place.lng / tileDegrees);
    for (let latitudeOffset = -1; latitudeOffset <= 1; latitudeOffset += 1) {
      for (let longitudeOffset = -1; longitudeOffset <= 1; longitudeOffset += 1) {
        const box = boxesByCell.get(
          `${latitudeCell + latitudeOffset}:${longitudeCell + longitudeOffset}`,
        );
        if (
          box &&
          place.lat >= box.minLat && place.lat <= box.maxLat &&
          place.lng >= box.minLng && place.lng <= box.maxLng
        ) return true;
      }
    }
    return false;
  });
}

function cellKey(lat: number, lng: number, cellDegrees: number): string {
  return `${Math.floor(lat / cellDegrees)}:${Math.floor(lng / cellDegrees)}`;
}

function nearbyPlaces(
  grid: ReadonlyMap<string, readonly ApizzaCanonicalPlaceV1[]>,
  candidate: RecordEnvelope<ApizzaSourceCandidatePayload>,
  config: ResolvedApizzaMatchingV1Config,
): InternalEvaluatedPlace[] {
  const { lat, lng } = candidate.payload;
  if (lat === null || lng === null) throw new TypeError("Matchable APizza candidate is missing coordinates");
  const latitudeCell = Math.floor(lat / config.gridCellDegrees);
  const longitudeCell = Math.floor(lng / config.gridCellDegrees);
  const cellRadius = Math.max(
    1,
    Math.ceil((config.maxDistanceM / 111_320) / config.gridCellDegrees) + 1,
  );
  const rows: InternalEvaluatedPlace[] = [];
  for (let latitudeOffset = -cellRadius; latitudeOffset <= cellRadius; latitudeOffset += 1) {
    for (let longitudeOffset = -cellRadius; longitudeOffset <= cellRadius; longitudeOffset += 1) {
      const places = grid.get(
        `${latitudeCell + latitudeOffset}:${longitudeCell + longitudeOffset}`,
      ) ?? [];
      for (const place of places) {
        const distanceM = apizzaHaversineMeters(lat, lng, place.lat, place.lng);
        if (distanceM <= config.maxDistanceM) {
          const nameScore = apizzaNameScore(candidate.payload.name, place.name);
          const identifierMatch = apizzaIdentifierMatch(candidate.payload, place);
          rows.push({
            ...place,
            distanceM,
            nameScore,
            identifierMatch,
            matchMethod: apizzaMatchMethod(distanceM, nameScore, identifierMatch.exact),
          });
        }
      }
    }
  }
  return rows
    .sort((left, right) => left.distanceM - right.distanceM ||
      compareUtf8(left.canonical_place_id, right.canonical_place_id))
    .slice(0, 10);
}

function bestMatch(nearby: readonly InternalEvaluatedPlace[]): InternalEvaluatedPlace | null {
  if (!nearby.length) return null;
  return [...nearby].sort((left, right) => {
    const leftGood = left.matchMethod === "no_match" ? 0 : 1;
    const rightGood = right.matchMethod === "no_match" ? 0 : 1;
    return rightGood - leftGood ||
      right.nameScore - left.nameScore ||
      left.distanceM - right.distanceM ||
      compareUtf8(left.canonical_place_id, right.canonical_place_id);
  })[0]!;
}

function serializeBest(place: InternalEvaluatedPlace | null): ApizzaEvaluatedPlaceV1 | null {
  if (!place) return null;
  return {
    canonical_place_id: place.canonical_place_id,
    name: place.name,
    google_place_id: place.google_place_id,
    distance_m: place.distanceM,
    name_score: place.nameScore,
    identifier_match: { ...place.identifierMatch },
    match_method: place.matchMethod,
  };
}

function serializeNearest(place: InternalEvaluatedPlace | null): ApizzaNearestPlaceV1 | null {
  if (!place) return null;
  return {
    canonical_place_id: place.canonical_place_id,
    name: place.name,
    google_place_id: place.google_place_id,
    distance_m: place.distanceM,
    name_score: place.nameScore,
  };
}

function activeDisposition(best: InternalEvaluatedPlace | null): ApizzaMatchDisposition {
  if (!best || best.matchMethod === "no_match") return "likely_new";
  if (["weak_spatial_name", "spatial_only_review"].includes(best.matchMethod)) {
    return "ambiguous_review";
  }
  return "matched_existing";
}

function acceptedMatch(best: InternalEvaluatedPlace | null): boolean {
  return Boolean(best && [
    "exact_identifier_nearby",
    "exact_name_nearby",
    "strong_spatial_name",
  ].includes(best.matchMethod));
}

export function matchApizzaCandidatesV1(
  candidates: Array<RecordEnvelope<ApizzaSourceCandidatePayload>>,
  canonicalSnapshot: ApizzaCanonicalSnapshotV1,
  input: { partition: string; config?: ApizzaMatchingV1Config },
): ApizzaMatchingV1Result {
  const config = resolveConfig(input.config === undefined ? {} : input.config);
  if (!input.partition) throw new TypeError("APizza matcher partition must not be empty");
  assertCandidateInputs(candidates, input.partition);
  assertCanonicalSnapshot(canonicalSnapshot);
  const matchable = candidates.filter((candidate) => MATCHABLE_ROUTES.has(candidate.payload.route));
  const boxes = buildPrefetchBoxes(matchable, config);
  const prefetched = prefetchCanonicalRows(
    canonicalSnapshot.rows,
    boxes,
    config.prefetchTileDegrees,
  );
  const grid = new Map<string, ApizzaCanonicalPlaceV1[]>();
  for (const place of prefetched) {
    const key = cellKey(place.lat, place.lng, config.gridCellDegrees);
    const cell = grid.get(key) ?? [];
    cell.push(place);
    grid.set(key, cell);
  }

  const decisions = candidates.map((candidate): ApizzaMatchDecisionV1 => {
    const stableSourceIdPresent = Boolean(candidate.payload.source_id);
    if (!MATCHABLE_ROUTES.has(candidate.payload.route)) {
      return {
        source_record_key: candidate.sourceRecordKey,
        observation_id: candidate.observationId,
        source_id: candidate.payload.source_id,
        candidate_route: candidate.payload.route,
        disposition: "not_compared",
        best_match: null,
        nearest_place: null,
        stable_source_id_present: stableSourceIdPresent,
      };
    }
    const nearby = nearbyPlaces(grid, candidate, config);
    const best = bestMatch(nearby);
    if (candidate.payload.route === "closed_evidence_candidate") {
      const evidenceEligible = stableSourceIdPresent && acceptedMatch(best);
      return {
        source_record_key: candidate.sourceRecordKey,
        observation_id: candidate.observationId,
        source_id: candidate.payload.source_id,
        candidate_route: candidate.payload.route,
        disposition: evidenceEligible ? "closed_evidence" : "closed_evidence_dropped",
        best_match: serializeBest(best),
        nearest_place: serializeNearest(nearby[0] ?? null),
        stable_source_id_present: stableSourceIdPresent,
      };
    }
    const disposition = activeDisposition(best);
    return {
      source_record_key: candidate.sourceRecordKey,
      observation_id: candidate.observationId,
      source_id: candidate.payload.source_id,
      candidate_route: candidate.payload.route,
      disposition,
      best_match: serializeBest(best),
      nearest_place: serializeNearest(nearby[0] ?? null),
      stable_source_id_present: stableSourceIdPresent,
    };
  }).sort((left, right) =>
    compareUtf8(left.source_record_key, right.source_record_key) ||
    compareUtf8(left.observation_id, right.observation_id));

  const routeCounts = Object.fromEntries(ALL_ROUTES.map((route) => [route, 0])) as
    Record<ApizzaCandidateRoute, number>;
  for (const candidate of candidates) routeCounts[candidate.payload.route] += 1;
  const count = (disposition: ApizzaMatchDisposition) =>
    decisions.filter((decision) => decision.disposition === disposition).length;
  const activeMatches = decisions.filter((decision) =>
    decision.candidate_route === "ready_for_match" && decision.disposition === "matched_existing");
  const report: ApizzaMatchReportV1 = {
    version: 1,
    profile: "apizzamichigan",
    matcher: "legacy-source-port-v1",
    partition: input.partition,
    config,
    candidate_route_counts: routeCounts,
    candidate_rows: candidates.length,
    active_candidates_compared: routeCounts.ready_for_match,
    closed_candidates_compared: routeCounts.closed_evidence_candidate,
    canonical_snapshot_rows: canonicalSnapshot.rows.length,
    canonical_rows_prefetched: prefetched.length,
    canonical_prefetch_tiles: boxes.length,
    canonical_prefetch_queries: boxes.length ? Math.ceil(boxes.length / config.prefetchBatchSize) : 0,
    grid_cells_built: grid.size,
    matched_existing_places: count("matched_existing"),
    ambiguous_review_candidates: count("ambiguous_review"),
    likely_new_unmatched_candidates: count("likely_new"),
    closed_signals_matched: count("closed_evidence"),
    legacy_active_matches_with_source_id: activeMatches.filter((decision) =>
      decision.stable_source_id_present).length,
    closed_evidence_dropped: count("closed_evidence_dropped"),
    decision_rows: decisions.length,
  };
  return { decisions, report };
}

const MATCH_DECISION_KEYS = [
  "source_record_key",
  "observation_id",
  "source_id",
  "candidate_route",
  "disposition",
  "best_match",
  "nearest_place",
  "stable_source_id_present",
] as const;

function validateEvaluatedPlace(value: unknown): void {
  assertObject(value, "APizza evaluated place");
  assertObject(value.identifier_match, "APizza evaluated identifier match");
  if (
    !exactKeys(value, [
      "canonical_place_id", "name", "google_place_id", "distance_m", "name_score",
      "identifier_match", "match_method",
    ]) ||
    typeof value.canonical_place_id !== "string" ||
    !value.canonical_place_id ||
    Buffer.byteLength(value.canonical_place_id, "utf8") > 256 ||
    !isStringOrNull(value.name) ||
    !isStringOrNull(value.google_place_id) ||
    typeof value.distance_m !== "number" ||
    !Number.isFinite(value.distance_m) ||
    value.distance_m < 0 ||
    value.distance_m > DEFAULT_CONFIG.maxDistanceM ||
    typeof value.name_score !== "number" ||
    !Number.isFinite(value.name_score) ||
    value.name_score < 0 ||
    value.name_score > 1 ||
    !exactKeys(value.identifier_match, ["website", "phone", "exact"]) ||
    typeof value.identifier_match.website !== "boolean" ||
    typeof value.identifier_match.phone !== "boolean" ||
    typeof value.identifier_match.exact !== "boolean" ||
    value.identifier_match.exact !==
      (value.identifier_match.website || value.identifier_match.phone) ||
    !ALL_METHODS.includes(value.match_method as ApizzaMatchMethod) ||
    value.match_method !== apizzaMatchMethod(
      value.distance_m,
      value.name_score,
      value.identifier_match.exact,
    )
  ) throw new TypeError("APizza evaluated place does not match v1");
}

function validateNearestPlace(value: unknown): void {
  assertObject(value, "APizza nearest place");
  if (
    !exactKeys(value, [
      "canonical_place_id", "name", "google_place_id", "distance_m", "name_score",
    ]) ||
    typeof value.canonical_place_id !== "string" ||
    !value.canonical_place_id ||
    Buffer.byteLength(value.canonical_place_id, "utf8") > 256 ||
    !isStringOrNull(value.name) ||
    !isStringOrNull(value.google_place_id) ||
    typeof value.distance_m !== "number" ||
    !Number.isFinite(value.distance_m) ||
    value.distance_m < 0 ||
    value.distance_m > DEFAULT_CONFIG.maxDistanceM ||
    typeof value.name_score !== "number" ||
    !Number.isFinite(value.name_score) ||
    value.name_score < 0 ||
    value.name_score > 1
  ) throw new TypeError("APizza nearest place does not match v1");
}

const validateDecisions: CanonicalJsonValidator = (value) => {
  if (!Array.isArray(value)) throw new TypeError("APizza match decisions must be an array");
  let priorKey: [string, string] | null = null;
  let priorCanonical: string | null = null;
  for (const decision of value) {
    assertObject(decision, "APizza match decision");
    if (
      !exactKeys(decision, MATCH_DECISION_KEYS) ||
      typeof decision.source_record_key !== "string" ||
      !/^srk_[a-f0-9]{64}$/.test(decision.source_record_key) ||
      typeof decision.observation_id !== "string" ||
      !/^obs_[a-f0-9]{64}$/.test(decision.observation_id) ||
      !isStringOrNull(decision.source_id) ||
      !ALL_ROUTES.includes(decision.candidate_route as ApizzaCandidateRoute) ||
      !ALL_DISPOSITIONS.includes(decision.disposition as ApizzaMatchDisposition) ||
      typeof decision.stable_source_id_present !== "boolean"
    ) throw new TypeError("APizza match decision does not match v1");
    if (decision.best_match !== null) validateEvaluatedPlace(decision.best_match);
    if (decision.nearest_place !== null) validateNearestPlace(decision.nearest_place);
    const disposition = decision.disposition as ApizzaMatchDisposition;
    const sourceAuthority = Boolean(decision.source_id);
    const method = (decision.best_match as { match_method?: ApizzaMatchMethod } | null)
      ?.match_method ?? null;
    const acceptedMethod = method !== null && [
      "exact_identifier_nearby", "exact_name_nearby", "strong_spatial_name",
    ].includes(method);
    const ambiguousMethod = method !== null &&
      ["weak_spatial_name", "spatial_only_review"].includes(method);
    const bestDistance = (decision.best_match as { distance_m?: number } | null)?.distance_m;
    const nearestDistance = (decision.nearest_place as { distance_m?: number } | null)?.distance_m;
    if (
      (disposition === "not_compared" && (
        MATCHABLE_ROUTES.has(decision.candidate_route as ApizzaCandidateRoute) ||
        decision.best_match !== null ||
        decision.nearest_place !== null
      )) ||
      (disposition !== "not_compared" &&
        !MATCHABLE_ROUTES.has(decision.candidate_route as ApizzaCandidateRoute)) ||
      decision.stable_source_id_present !== sourceAuthority ||
      (disposition === "matched_existing" &&
        (decision.candidate_route !== "ready_for_match" || !acceptedMethod)) ||
      (disposition === "ambiguous_review" &&
        (decision.candidate_route !== "ready_for_match" || !ambiguousMethod)) ||
      (disposition === "likely_new" &&
        (decision.candidate_route !== "ready_for_match" ||
          ![null, "no_match"].includes(method))) ||
      (disposition === "closed_evidence" &&
        (decision.candidate_route !== "closed_evidence_candidate" || !acceptedMethod ||
          !sourceAuthority)) ||
      (disposition === "closed_evidence_dropped" &&
        (decision.candidate_route !== "closed_evidence_candidate" ||
          (acceptedMethod && sourceAuthority))) ||
      ((decision.best_match === null) !== (decision.nearest_place === null)) ||
      (typeof bestDistance === "number" && typeof nearestDistance === "number" &&
        nearestDistance > bestDistance)
    ) throw new TypeError("APizza match decision has inconsistent authority or routing");
    const currentKey: [string, string] = [
      decision.source_record_key as string,
      decision.observation_id as string,
    ];
    const currentCanonical = canonicalize(decision as CanonicalJson);
    if (priorKey && (
      compareUtf8(currentKey[0], priorKey[0]) < 0 ||
      (currentKey[0] === priorKey[0] && compareUtf8(currentKey[1], priorKey[1]) < 0)
    )) throw new TypeError("APizza match decisions are not in canonical order");
    if (
      priorKey &&
      currentKey[0] === priorKey[0] &&
      currentKey[1] === priorKey[1] &&
      currentCanonical !== priorCanonical
    ) {
      throw new TypeError("Duplicate APizza decision identities must have identical content");
    }
    priorKey = currentKey;
    priorCanonical = currentCanonical;
  }
};

const validateMatchReport: CanonicalJsonValidator = (value) => {
  assertObject(value, "APizza match report");
  assertObject(value.config, "APizza match report config");
  assertObject(value.candidate_route_counts, "APizza match report route counts");
  const countKeys = [
    "candidate_rows", "active_candidates_compared", "closed_candidates_compared",
    "canonical_snapshot_rows", "canonical_rows_prefetched", "canonical_prefetch_tiles",
    "canonical_prefetch_queries", "grid_cells_built", "matched_existing_places",
    "ambiguous_review_candidates", "likely_new_unmatched_candidates",
    "closed_signals_matched", "legacy_active_matches_with_source_id",
    "closed_evidence_dropped", "decision_rows",
  ] as const;
  if (
    !exactKeys(value, [
      "version", "profile", "matcher", "partition", "config", "candidate_route_counts",
      ...countKeys,
    ]) ||
    value.version !== 1 ||
    value.profile !== "apizzamichigan" ||
    value.matcher !== "legacy-source-port-v1" ||
    typeof value.partition !== "string" ||
    !value.partition ||
    !exactKeys(value.config, [
      "maxDistanceM", "gridCellDegrees", "prefetchTileDegrees", "prefetchBatchSize",
    ]) ||
    !exactKeys(value.candidate_route_counts, ALL_ROUTES) ||
    Object.values(value.config).some((entry) =>
      typeof entry !== "number" || !Number.isFinite(entry) || entry <= 0) ||
    !Number.isSafeInteger(value.config.prefetchBatchSize) ||
    Object.entries(DEFAULT_CONFIG).some(([name, expected]) =>
      (value.config as Record<string, CanonicalJson>)[name] !== expected) ||
    Object.values(value.candidate_route_counts).some((entry) =>
      !Number.isSafeInteger(entry) || Number(entry) < 0) ||
    countKeys.some((key) => !Number.isSafeInteger(value[key]) || Number(value[key]) < 0)
  ) throw new TypeError("APizza match report does not match v1");
  const routeTotal = Object.values(value.candidate_route_counts)
    .reduce<number>((sum, count) => sum + Number(count), 0);
  const matchableCount = Number(value.active_candidates_compared) +
    Number(value.closed_candidates_compared);
  if (
    routeTotal !== value.candidate_rows ||
    value.active_candidates_compared !== value.candidate_route_counts.ready_for_match ||
    value.closed_candidates_compared !== value.candidate_route_counts.closed_evidence_candidate ||
    Number(value.active_candidates_compared) + Number(value.closed_candidates_compared) +
      Number(value.candidate_route_counts.filtered_non_pizza) +
      Number(value.candidate_route_counts.excluded_unusable) +
      Number(value.candidate_route_counts.excluded_out_of_scope) !== value.decision_rows ||
    value.decision_rows !== value.candidate_rows ||
    Number(value.matched_existing_places) + Number(value.ambiguous_review_candidates) +
      Number(value.likely_new_unmatched_candidates) !== value.active_candidates_compared ||
    Number(value.closed_signals_matched) + Number(value.closed_evidence_dropped) !==
      value.closed_candidates_compared ||
    Number(value.legacy_active_matches_with_source_id) > Number(value.matched_existing_places) ||
    Number(value.canonical_rows_prefetched) > Number(value.canonical_snapshot_rows) ||
    Number(value.grid_cells_built) > Number(value.canonical_rows_prefetched) ||
    Number(value.canonical_prefetch_tiles) >
      matchableCount ||
    (Number(value.canonical_prefetch_tiles) === 0) !== (matchableCount === 0) ||
    (Number(value.canonical_prefetch_tiles) === 0 &&
      Number(value.canonical_rows_prefetched) !== 0) ||
    (Number(value.grid_cells_built) === 0) !==
      (Number(value.canonical_rows_prefetched) === 0) ||
    Number(value.canonical_prefetch_queries) !== (Number(value.canonical_prefetch_tiles) === 0
      ? 0
      : Math.ceil(
        Number(value.canonical_prefetch_tiles) / Number(value.config.prefetchBatchSize),
      ))
  ) throw new TypeError("APizza match report counts do not reconcile");
};

const validateCanonicalSnapshot: CanonicalJsonValidator = (value) => {
  assertCanonicalSnapshot(value);
};

export const apizzaMatchingV1SchemaValidators: Readonly<Record<string, CanonicalJsonValidator>> =
  Object.freeze({
    [`${APIZZA_CANONICAL_MATCH_SNAPSHOT_SCHEMA.name}@${APIZZA_CANONICAL_MATCH_SNAPSHOT_SCHEMA.version}`]: validateCanonicalSnapshot,
    [`${APIZZA_MATCH_DECISIONS_SCHEMA.name}@${APIZZA_MATCH_DECISIONS_SCHEMA.version}`]: validateDecisions,
    [`${APIZZA_MATCH_REPORT_SCHEMA.name}@${APIZZA_MATCH_REPORT_SCHEMA.version}`]: validateMatchReport,
  });

function matcherLock() {
  return {
    packageName: "@map-pipeline/profile-apizzamichigan",
    packageVersion: "0.0.0-preview",
    pluginApiVersion: PIPELINE_API_VERSION,
    integrity: `sha256:${"4".repeat(64)}`,
    configSchema: { name: "apizza.match-v1.config", version: 1 },
    configSchemaDigest: `sha256:${"4".repeat(64)}`,
  };
}

export const apizzaMatchingV1Manifest: StagePluginManifest = {
  id: "apizza-match-v1",
  lock: matcherLock(),
  inputs: {
    candidates: {
      schema: APIZZA_SOURCE_CANDIDATE_SCHEMA,
      cardinality: "many",
      partitioning: "by_partition",
      ordering: "canonical",
      artifactPolicy: "required",
    },
    canonical: {
      schema: APIZZA_CANONICAL_MATCH_SNAPSHOT_SCHEMA,
      cardinality: "many",
      partitioning: "by_partition",
      ordering: "canonical",
      artifactPolicy: "required",
    },
  },
  outputs: {
    decisions: {
      schema: APIZZA_MATCH_DECISIONS_SCHEMA,
      cardinality: "many",
      partitioning: "by_partition",
      ordering: "canonical",
      artifactPolicy: "required",
    },
    report: {
      schema: APIZZA_MATCH_REPORT_SCHEMA,
      cardinality: "one",
      partitioning: "by_partition",
      ordering: "canonical",
      artifactPolicy: "required",
    },
  },
  sourceAdapter: null,
  effects: ["artifact.write"],
  delivery: "none",
};

export function createApizzaMatchingV1Plugin(
  manifest: StagePluginManifest = apizzaMatchingV1Manifest,
): StagePlugin<ApizzaMatchingV1Config> {
  if (manifest.sourceAdapter !== null) throw new TypeError("APizza matcher must be a transform plugin");
  return definePlugin({
    manifest,
    async run(context, inputs, config) {
      const candidates = await context.broker.readDatasetJson(inputs.candidates!);
      const canonical = await context.broker.readDatasetJson(inputs.canonical!);
      if (!Array.isArray(candidates)) throw new TypeError("APizza candidate input must be an array");
      assertObject(canonical, "APizza canonical snapshot");
      if (canonical.version !== 1 || !Array.isArray(canonical.rows)) {
        throw new TypeError("APizza canonical snapshot must contain v1 rows");
      }
      const result = matchApizzaCandidatesV1(
        candidates as unknown as Array<RecordEnvelope<ApizzaSourceCandidatePayload>>,
        canonical as unknown as ApizzaCanonicalSnapshotV1,
        { partition: context.partition, config },
      );
      const stagedDecisions = await context.broker.stageDerivedJson({
        outputPort: "decisions",
        value: result.decisions as unknown as CanonicalJson,
      });
      const decisions = await context.broker.finalizeDerivedArtifact({
        stagedArtifact: stagedDecisions,
        outputPort: "decisions",
      });
      const stagedReport = await context.broker.stageDerivedJson({
        outputPort: "report",
        value: result.report as unknown as CanonicalJson,
      });
      const report = await context.broker.finalizeDerivedArtifact({
        stagedArtifact: stagedReport,
        outputPort: "report",
      });
      return {
        outputs: { decisions, report },
        metrics: {
          decisions: result.decisions.length,
          matched: result.report.matched_existing_places,
          ambiguous: result.report.ambiguous_review_candidates,
          likelyNew: result.report.likely_new_unmatched_candidates,
          closedEvidence: result.report.closed_signals_matched,
        },
      };
    },
  });
}
