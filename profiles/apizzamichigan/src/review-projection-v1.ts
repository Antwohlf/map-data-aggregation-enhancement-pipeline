import type { CanonicalJson, RecordEnvelope } from "@map-pipeline/core";
import { validateApizzaSourceCandidatesV1, type ApizzaFsqCandidatePayloadV1 } from "./fsq-preview.js";
import {
  APIZZA_MATCH_DECISIONS_SCHEMA,
  apizzaMatchingV1SchemaValidators,
  type ApizzaMatchDecisionV1,
} from "./matching-v1.js";

export interface ApizzaReviewProjectionV1 {
  generated_at: string;
  entity: "pizza";
  source: "fsq_os_places";
  source_label: "Foursquare OS Places";
  mode: "dry-run";
  status: "complete" | "incomplete";
  counts: { ready: number; blocked: number; notForReview: number };
  ambiguous: Array<Record<string, unknown>>;
  likely_new: Array<Record<string, unknown>>;
}

type Candidate = RecordEnvelope<ApizzaFsqCandidatePayloadV1>;

const decisionValidator = apizzaMatchingV1SchemaValidators[
  `${APIZZA_MATCH_DECISIONS_SCHEMA.name}@${APIZZA_MATCH_DECISIONS_SCHEMA.version}`
];

function assertGeneratedAt(value: string): void {
  const parsed = Date.parse(value);
  if (!value || Number.isNaN(parsed) || new Date(parsed).toISOString() !== value) {
    throw new TypeError("generatedAt must be a canonical ISO timestamp");
  }
}

function sourceData(candidate: Candidate, decision: ApizzaMatchDecisionV1): Record<string, unknown> {
  const p = candidate.payload;
  return {
    name: p.name,
    lat: p.lat,
    lng: p.lng,
    address: p.address,
    locality: p.locality,
    region: p.region,
    postcode: p.postcode,
    country: p.country,
    website: p.website,
    phone: p.phone,
    category: p.categories.join(", ") || null,
    is_closed: p.is_closed,
    _pipeline: {
      source_record_key: decision.source_record_key,
      observation_id: decision.observation_id,
    },
  };
}

function nearest(value: ApizzaMatchDecisionV1["nearest_place"] | ApizzaMatchDecisionV1["best_match"]): Record<string, unknown> | null {
  if (!value) return null;
  const output: Record<string, unknown> = {
    id: value.canonical_place_id,
    name: value.name,
    google_place_id: value.google_place_id,
    distance_m: value.distance_m,
    name_score: value.name_score,
  };
  if ("identifier_match" in value) output.identifier_match = { ...value.identifier_match };
  return output;
}

export function projectApizzaReviewV1(
  candidates: readonly Candidate[],
  decisions: readonly ApizzaMatchDecisionV1[],
  generatedAt: string,
): ApizzaReviewProjectionV1 {
  assertGeneratedAt(generatedAt);
  validateApizzaSourceCandidatesV1(candidates as unknown as CanonicalJson);
  if (!decisionValidator) throw new TypeError("APizza decision validator is unavailable");
  decisionValidator(decisions as unknown as CanonicalJson);
  if (candidates.length !== decisions.length) throw new TypeError("Candidate and decision counts differ");

  const byIdentity = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const key = `${candidate.sourceRecordKey}\u0000${candidate.observationId}`;
    if (byIdentity.has(key)) throw new TypeError("Duplicate candidate identity");
    byIdentity.set(key, candidate);
  }
  const queueKeys = new Set<string>();
  const ambiguous: Array<Record<string, unknown>> = [];
  const likelyNew: Array<Record<string, unknown>> = [];
  const seenDecisions = new Set<string>();
  let blocked = 0;
  let notForReview = 0;

  for (const decision of decisions) {
    const identity = `${decision.source_record_key}\u0000${decision.observation_id}`;
    if (seenDecisions.has(identity)) throw new TypeError("Duplicate decision identity");
    seenDecisions.add(identity);
    const candidate = byIdentity.get(identity);
    if (!candidate || candidate.payload.source_id !== decision.source_id ||
      candidate.payload.route !== decision.candidate_route) {
      throw new TypeError("Decision does not reconcile to its candidate");
    }
    if (!["ambiguous_review", "likely_new"].includes(decision.disposition)) {
      notForReview++;
      continue;
    }
    if (!decision.source_id || !decision.stable_source_id_present) {
      blocked++;
      continue;
    }
    const kind = decision.disposition === "ambiguous_review" ? "ambiguous" : "likely_new";
    const queueKey = `${candidate.payload.source}\u0000${decision.source_id}\u0000${kind}`;
    if (queueKeys.has(queueKey)) throw new TypeError("Review decisions collide on app queue identity");
    queueKeys.add(queueKey);
    const item: Record<string, unknown> = {
      source: candidate.payload.source,
      source_id: decision.source_id,
      source_name: candidate.payload.name,
      source_url: candidate.payload.source_url,
      source_data: sourceData(candidate, decision),
      // The app's ambiguous queue expects the selected match, not merely the
      // geographically nearest row. These may differ when name evidence wins.
      nearest_place: nearest(kind === "ambiguous" ? decision.best_match : decision.nearest_place),
    };
    if (kind === "ambiguous") {
      if (item.nearest_place) {
        (item.nearest_place as Record<string, unknown>).review_reason =
          decision.best_match?.match_method ?? null;
      }
      ambiguous.push(item);
    } else {
      likelyNew.push(item);
    }
  }
  if (seenDecisions.size !== byIdentity.size) throw new TypeError("Missing decision for candidate");
  return {
    generated_at: generatedAt,
    entity: "pizza",
    source: "fsq_os_places",
    source_label: "Foursquare OS Places",
    mode: "dry-run",
    status: blocked ? "incomplete" : "complete",
    counts: { ready: ambiguous.length + likelyNew.length, blocked, notForReview },
    ambiguous,
    likely_new: likelyNew,
  };
}
