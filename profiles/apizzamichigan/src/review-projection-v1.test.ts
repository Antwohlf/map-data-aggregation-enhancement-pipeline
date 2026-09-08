import assert from "node:assert/strict";
import test from "node:test";
import { normalizeFsqRowsV1 } from "./fsq-preview.js";
import { matchApizzaCandidatesV1 } from "./matching-v1.js";
import { projectApizzaReviewV1 } from "./review-projection-v1.js";
import type { ApizzaMatchDecisionV1 } from "./matching-v1.js";

const row = (id: string | null, name: string, lat: number, lng: number) => ({
  fsq_place_id: id, name, latitude: lat, longitude: lng, address: "1 Main St",
  locality: "Detroit", region: "MI", postcode: "48201", country: "US", tel: "555-1",
  website: "https://example.test", fsq_category_ids: ["pizza"], fsq_category_labels: ["Pizza"],
  date_closed: null, unresolved_flags: [],
});

function envelopes() {
  return normalizeFsqRowsV1([row("fsq-1", "One Pizza", 42.35, -83.05), row(null, "Two Pizza", 42.36, -83.06)], {
    runId: "run-1", stageId: "normalize", partition: "US", pluginVersion: "test",
    evaluationTime: "2026-09-07T12:00:00.000Z", fallbackRetrievedAt: "2026-09-07T00:00:00.000Z",
    license: "Apache-2.0", attribution: "test",
  });
}

test("projects only review decisions and preserves pipeline identities", () => {
  const candidates = envelopes();
  const result = matchApizzaCandidatesV1(candidates as any, { version: 1, rows: [] }, { partition: "US" });
  const projected = projectApizzaReviewV1(candidates, result.decisions, "2026-09-07T12:00:00.000Z");
  assert.equal(projected.mode, "dry-run");
  assert.ok(projected.likely_new.length >= 1);
  assert.equal(projected.ambiguous.length, 0);
  const likelyDecision = result.decisions.find(d => d.disposition === "likely_new" && d.source_id)!;
  const likelyItem = projected.likely_new.find(item => item.source_id === likelyDecision.source_id)! as any;
  assert.deepEqual(likelyItem.source_data?._pipeline, {
    source_record_key: likelyDecision.source_record_key,
    observation_id: likelyDecision.observation_id,
  });
  assert.equal("status" in (projected.likely_new[0] ?? {}), false);
  assert.equal("decision" in (projected.likely_new[0] ?? {}), false);
});

test("blocks null stable IDs without synthesizing queue IDs", () => {
  const candidates = envelopes();
  const matching = matchApizzaCandidatesV1(candidates as any, { version: 1, rows: [] }, { partition: "US" });
  const projected = projectApizzaReviewV1(candidates, matching.decisions, "2026-09-07T12:00:00.000Z");
  assert.ok(projected.counts.blocked >= 1);
  assert.equal(projected.status, "incomplete");
  assert.equal(projected.likely_new.some(item => item.source_id == null), false);
});

test("rejects mismatched decisions and missing or duplicated coverage", () => {
  const candidates = envelopes();
  const matching = matchApizzaCandidatesV1(candidates as any, { version: 1, rows: [] }, { partition: "US" });
  const decisions = matching.decisions.map(d => ({ ...d }));
  assert.throws(() => projectApizzaReviewV1(candidates, [{ ...decisions[0]!, source_id: "wrong" }, ...decisions.slice(1)], "2026-09-07T12:00:00.000Z"));
  assert.throws(() => projectApizzaReviewV1(candidates, [decisions[0]!], "2026-09-07T12:00:00.000Z"), /counts differ/);
  assert.throws(() => projectApizzaReviewV1(candidates, [decisions[0]!, decisions[0]!], "2026-09-07T12:00:00.000Z"), /Duplicate decision/);
});

test("ambiguous handoff uses the selected match even when another place is closer", () => {
  const candidate = envelopes().find(c => c.payload.source_id)!;
  const decision: ApizzaMatchDecisionV1 = {
    source_record_key: candidate.sourceRecordKey, observation_id: candidate.observationId,
    source_id: candidate.payload.source_id, candidate_route: "ready_for_match",
    disposition: "ambiguous_review", stable_source_id_present: true,
    best_match: { canonical_place_id: "2", name: "Selected Pizza", google_place_id: null,
      distance_m: 80, name_score: 0.4, match_method: "weak_spatial_name",
      identifier_match: { website: false, phone: false, exact: false } },
    nearest_place: { canonical_place_id: "1", name: "Closer Place", google_place_id: null,
      distance_m: 10, name_score: 0.1 },
  };
  const output = projectApizzaReviewV1([candidate], [decision], "2026-09-07T12:00:00.000Z");
  const nearest = output.ambiguous[0]!.nearest_place as Record<string, unknown>;
  assert.equal(nearest.id, "2");
  assert.equal(nearest.review_reason, "weak_spatial_name");
  assert.deepEqual(nearest.identifier_match, { website: false, phone: false, exact: false });
  const closure: ApizzaMatchDecisionV1 = { ...decision, candidate_route: "closed_evidence_candidate", disposition: "closed_evidence_dropped" };
  const closedCandidate = { ...candidate, payload: { ...candidate.payload, is_closed: true, route: "closed_evidence_candidate" as const } };
  const closedOutput = projectApizzaReviewV1([closedCandidate], [closure], "2026-09-07T12:00:00.000Z");
  assert.deepEqual(closedOutput.counts, { ready: 0, blocked: 0, notForReview: 1 });
});

test("rejects distinct observations colliding on the app queue identity", () => {
  const original = envelopes().find(c => c.payload.source_id)!;
  const duplicate = { ...original, observationId: `obs_${"f".repeat(64)}`, payload: { ...original.payload, name: "Another Pizza" } };
  const candidates = [original, duplicate];
  const matching = matchApizzaCandidatesV1(candidates as any, { version: 1, rows: [] }, { partition: "US" });
  assert.throws(() => projectApizzaReviewV1(candidates, matching.decisions, "2026-09-07T12:00:00.000Z"), /collide/);
});
