import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalJson, DatasetHandle, DatasetRef, RecordEnvelope } from "@map-pipeline/core";
import type { StageBroker, StageContext } from "@map-pipeline/sdk";

import {
  APIZZA_CANONICAL_MATCH_SNAPSHOT_SCHEMA,
  APIZZA_MATCH_DECISIONS_SCHEMA,
  APIZZA_MATCH_REPORT_SCHEMA,
  apizzaIdentifierMatch,
  apizzaMatchMethod,
  apizzaMatchingV1Manifest,
  apizzaMatchingV1SchemaValidators,
  apizzaNameScore,
  createApizzaMatchingV1Plugin,
  matchApizzaCandidatesV1,
  normalizeApizzaMatchPhone,
  normalizeApizzaMatchUrl,
  type ApizzaCanonicalPlaceV1,
  type ApizzaCandidateRoute,
  type ApizzaSourceCandidatePayload,
} from "./matching-v1.js";

const PARTITION = "US";

function hexId(prefix: "srk" | "obs", index: number): string {
  return `${prefix}_${index.toString(16).padStart(64, "0")}`;
}

function candidate(
  index: number,
  input: {
    route?: ApizzaCandidateRoute;
    sourceId?: string | null;
    name?: string | null;
    lat?: number | null;
    lng?: number | null;
    website?: string | null;
    phone?: string | null;
    region?: string | null;
    sourceUrl?: string | null;
    categories?: string[];
  } = {},
): RecordEnvelope<ApizzaSourceCandidatePayload> {
  const route = input.route ?? "ready_for_match";
  return {
    sourceRecordKey: hexId("srk", index),
    observationId: hexId("obs", index),
    source: {
      name: "fsq_os_places",
      namespace: "foursquare",
      externalId: input.sourceId ?? `fsq-${index}`,
      retrievedAt: "2026-09-06T00:00:00.000Z",
    },
    schema: { name: "apizza.source-candidate", version: 1 },
    partition: PARTITION,
    payload: {
      source_id: input.sourceId === undefined ? `fsq-${index}` : input.sourceId,
      name: input.name === undefined ? `Candidate ${index}` : input.name,
      lat: input.lat === undefined ? 42 + (index / 100) : input.lat,
      lng: input.lng === undefined ? -83 : input.lng,
      website: input.website ?? null,
      phone: input.phone ?? null,
      region: input.region ?? "MI",
      source_url: input.sourceUrl ?? null,
      categories: input.categories ?? ["Pizza"],
      is_closed: route === "closed_evidence_candidate",
      route,
    },
    lineage: [],
  };
}

function longitudeOffsetMeters(meters: number, latitude: number): number {
  return (meters / (6_371_000 * Math.cos(latitude * Math.PI / 180))) * (180 / Math.PI);
}

function canonical(
  id: string,
  input: {
    name?: string | null;
    lat?: number;
    lng?: number;
    website?: string | null;
    phone?: string | null;
  } = {},
): ApizzaCanonicalPlaceV1 {
  return {
    canonical_place_id: id,
    name: input.name ?? `Canonical ${id}`,
    address: null,
    state: "MI",
    google_place_id: null,
    website_url: input.website ?? null,
    phone: input.phone ?? null,
    lat: input.lat ?? 42,
    lng: input.lng ?? -83,
  };
}

test("pins every inclusive legacy method boundary", () => {
  const epsilon = Number.EPSILON * 128;
  const cases: Array<[string, number, number, boolean, string]> = [
    ["identifier at 100m", 100, 0, true, "exact_identifier_nearby"],
    ["identifier beyond 100m", 100 + epsilon, 0, true, "no_match"],
    ["exact name at 25m", 25, 0.99, false, "exact_name_nearby"],
    ["exact name beyond 25m", 25 + epsilon, 0.99, false, "strong_spatial_name"],
    ["exact name at 75m", 75, 0.99, false, "strong_spatial_name"],
    ["exact name beyond 75m", 75 + epsilon, 0.99, false, "weak_spatial_name"],
    ["0.60 score at 50m", 50, 0.6, false, "strong_spatial_name"],
    ["0.60 score beyond 50m", 50 + epsilon, 0.6, false, "weak_spatial_name"],
    ["0.35 score at 100m", 100, 0.35, false, "weak_spatial_name"],
    ["0.35 score beyond 100m", 100 + epsilon, 0.35, false, "no_match"],
    ["below weak score at 25m", 25, 0.35 - epsilon, false, "spatial_only_review"],
    ["below weak score beyond 25m", 25 + epsilon, 0.35 - epsilon, false, "no_match"],
  ];
  for (const [label, distance, score, identifier, expected] of cases) {
    assert.equal(apizzaMatchMethod(distance, score, identifier), expected, label);
  }
});

test("pins legacy name, URL, phone, and identifier quirks", () => {
  assert.equal(apizzaNameScore("Café & Pizza", "Cafe and Pizza"), 1);
  assert.equal(apizzaNameScore("Little Caesars", "Little Caesars Express"), 0.85);
  assert.equal(apizzaNameScore("Pizza", "Pizza"), 1);
  assert.equal(apizzaNameScore("Pizza", "Pizzeria"), 0);
  assert.equal(apizzaNameScore("foo foo", "foo bar"), 1);
  assert.equal(apizzaNameScore("foo bar", "foo foo"), 0.5);

  assert.equal(normalizeApizzaMatchPhone("+1 (313) 555-0199"), "3135550199");
  assert.equal(normalizeApizzaMatchPhone("555-0199"), "5550199");
  assert.equal(normalizeApizzaMatchPhone("123456"), "");
  assert.equal(normalizeApizzaMatchUrl(" HTTPS://WWW.Example.com/store/ "), "example.com/store");

  assert.deepEqual(
    apizzaIdentifierMatch(
      { website: "https://example.com/store/", phone: null },
      { website_url: "http://www.example.com/store", phone: null },
    ),
    { website: true, phone: false, exact: true },
  );
  assert.equal(apizzaIdentifierMatch(
    { website: "https://example.com/", phone: null },
    { website_url: "https://example.com", phone: null },
  ).exact, false, "a chain homepage is not a store identifier");
  assert.equal(apizzaIdentifierMatch(
    { website: "foo/bar", phone: null },
    { website_url: "foo/bar", phone: null },
  ).exact, true, "legacy checks for a slash rather than parsing a URL path");
});

test("golden: every normalized route has an explicit, authority-safe decision", () => {
  const inputs = [
    candidate(1, { name: "Phone Winner", phone: "3135550001" }),
    candidate(2, { name: "Strong Two" }),
    candidate(3, { name: "Alpha Beta" }),
    candidate(4, { name: "No Relation" }),
    candidate(5, { name: "Strong Five", sourceId: null }),
    candidate(6, { name: "Gamma Delta", sourceId: null }),
    candidate(7, { route: "closed_evidence_candidate", name: "Closed Seven" }),
    candidate(8, { route: "closed_evidence_candidate", name: "Closed Eight", sourceId: null }),
    candidate(9, { route: "closed_evidence_candidate", name: "Closed Alpha Beta" }),
    candidate(10, {
      route: "filtered_non_pizza",
      name: "Not compared",
      categories: [],
    }),
  ];
  const places = [
    canonical("c00", { name: "Outside every prefetch box", lat: 45, lng: -90 }),
    canonical("c01", {
      name: "Unrelated One",
      lat: inputs[0]!.payload.lat!,
      lng: inputs[0]!.payload.lng! + longitudeOffsetMeters(90, inputs[0]!.payload.lat!),
      phone: "313-555-0001",
    }),
    canonical("c02", {
      name: "Strong Two",
      lat: inputs[1]!.payload.lat!,
      lng: inputs[1]!.payload.lng! + longitudeOffsetMeters(30, inputs[1]!.payload.lat!),
    }),
    canonical("c03", {
      name: "Alpha Gamma",
      lat: inputs[2]!.payload.lat!,
      lng: inputs[2]!.payload.lng! + longitudeOffsetMeters(80, inputs[2]!.payload.lat!),
    }),
    canonical("c04", {
      name: "Other Place",
      lat: inputs[3]!.payload.lat!,
      lng: inputs[3]!.payload.lng! + longitudeOffsetMeters(50, inputs[3]!.payload.lat!),
    }),
    canonical("c05", {
      name: "Strong Five",
      lat: inputs[4]!.payload.lat!,
      lng: inputs[4]!.payload.lng! + longitudeOffsetMeters(30, inputs[4]!.payload.lat!),
    }),
    canonical("c06", {
      name: "Gamma Other",
      lat: inputs[5]!.payload.lat!,
      lng: inputs[5]!.payload.lng! + longitudeOffsetMeters(80, inputs[5]!.payload.lat!),
    }),
    canonical("c07", {
      name: "Closed Seven",
      lat: inputs[6]!.payload.lat!,
      lng: inputs[6]!.payload.lng! + longitudeOffsetMeters(10, inputs[6]!.payload.lat!),
    }),
    canonical("c08", {
      name: "Closed Eight",
      lat: inputs[7]!.payload.lat!,
      lng: inputs[7]!.payload.lng! + longitudeOffsetMeters(10, inputs[7]!.payload.lat!),
    }),
    canonical("c09", {
      name: "Closed Alpha Gamma",
      lat: inputs[8]!.payload.lat!,
      lng: inputs[8]!.payload.lng! + longitudeOffsetMeters(80, inputs[8]!.payload.lat!),
    }),
  ];
  const result = matchApizzaCandidatesV1(inputs, { version: 1, rows: places }, { partition: PARTITION });
  assert.deepEqual(
    result.decisions.map((decision) => ({
      disposition: decision.disposition,
      method: decision.best_match?.match_method ?? null,
      best: decision.best_match?.canonical_place_id ?? null,
      stableId: decision.stable_source_id_present,
    })),
    [
      { disposition: "matched_existing", method: "exact_identifier_nearby", best: "c01", stableId: true },
      { disposition: "matched_existing", method: "strong_spatial_name", best: "c02", stableId: true },
      { disposition: "ambiguous_review", method: "weak_spatial_name", best: "c03", stableId: true },
      { disposition: "likely_new", method: "no_match", best: "c04", stableId: true },
      { disposition: "matched_existing", method: "strong_spatial_name", best: "c05", stableId: false },
      { disposition: "ambiguous_review", method: "weak_spatial_name", best: "c06", stableId: false },
      { disposition: "closed_evidence", method: "exact_name_nearby", best: "c07", stableId: true },
      { disposition: "closed_evidence_dropped", method: "exact_name_nearby", best: "c08", stableId: false },
      { disposition: "closed_evidence_dropped", method: "weak_spatial_name", best: "c09", stableId: true },
      { disposition: "not_compared", method: null, best: null, stableId: true },
    ],
  );
  assert.deepEqual({
    candidates: result.report.candidate_rows,
    active: result.report.active_candidates_compared,
    closed: result.report.closed_candidates_compared,
    snapshot: result.report.canonical_snapshot_rows,
    prefetched: result.report.canonical_rows_prefetched,
    matched: result.report.matched_existing_places,
    ambiguous: result.report.ambiguous_review_candidates,
    likelyNew: result.report.likely_new_unmatched_candidates,
    closedMatched: result.report.closed_signals_matched,
    matchedWithSourceId: result.report.legacy_active_matches_with_source_id,
    closedDropped: result.report.closed_evidence_dropped,
    decisions: result.report.decision_rows,
  }, {
    candidates: 10,
    active: 6,
    closed: 3,
    snapshot: 10,
    prefetched: 9,
    matched: 3,
    ambiguous: 2,
    likelyNew: 1,
    closedMatched: 1,
    matchedWithSourceId: 2,
    closedDropped: 2,
    decisions: 10,
  });
});

test("legacy top-ten pruning happens before identifier and method scoring", () => {
  const input = candidate(1, {
    name: "Target Place",
    lat: 42,
    lng: -83,
    phone: "3135559999",
  });
  const decoys = Array.from({ length: 10 }, (_, index) => canonical(
    String(index + 1).padStart(2, "0"),
    {
      name: "Other",
      lat: 42,
      lng: -83 + longitudeOffsetMeters(index + 1, 42),
    },
  ));
  const exactEleventh = canonical("z", {
    name: "Other",
    lat: 42,
    lng: -83 + longitudeOffsetMeters(11, 42),
    phone: "313-555-9999",
  });
  const { decisions } = matchApizzaCandidatesV1(
    [input],
    { version: 1, rows: [...decoys, exactEleventh] },
    { partition: PARTITION },
  );
  assert.equal(decisions[0]?.disposition, "ambiguous_review");
  assert.equal(decisions[0]?.best_match?.canonical_place_id, "01");
  assert.equal(decisions[0]?.best_match?.match_method, "spatial_only_review");
});

test("legacy best-match ordering lets a farther weak-name match beat an exact identifier", () => {
  const input = candidate(1, {
    name: "Target Place",
    lat: 42.2,
    lng: -83,
    phone: "3135551212",
  });
  const exactIdentifier = canonical("a", {
    name: "Unrelated",
    lat: 42.2,
    lng: -83 + longitudeOffsetMeters(20, 42.2),
    phone: "313-555-1212",
  });
  const exactName = canonical("b", {
    name: "Target Place",
    lat: 42.2,
    lng: -83 + longitudeOffsetMeters(80, 42.2),
  });
  const { decisions } = matchApizzaCandidatesV1(
    [input],
    { version: 1, rows: [exactIdentifier, exactName] },
    { partition: PARTITION },
  );
  assert.equal(decisions[0]?.nearest_place?.canonical_place_id, "a");
  assert.equal(decisions[0]?.best_match?.canonical_place_id, "b");
  assert.equal(decisions[0]?.best_match?.match_method, "weak_spatial_name");
  assert.equal(decisions[0]?.disposition, "ambiguous_review");
});

test("closed no-match and identity-free likely-new routes stay non-authoritative", () => {
  const inputs = [
    candidate(1, { sourceId: null, name: "Unknown One" }),
    candidate(2, { route: "closed_evidence_candidate", name: "Unknown Two" }),
  ];
  const { decisions, report } = matchApizzaCandidatesV1(
    inputs,
    { version: 1, rows: [] },
    { partition: PARTITION },
  );
  assert.deepEqual(decisions.map((decision) => ({
    disposition: decision.disposition,
    stableId: decision.stable_source_id_present,
  })), [
    { disposition: "likely_new", stableId: false },
    { disposition: "closed_evidence_dropped", stableId: true },
  ]);
  assert.equal(report.closed_signals_matched, 0);
  assert.equal(report.closed_evidence_dropped, 1);
});

test("legacy tile-center longitude padding is simulated against the full snapshot", () => {
  const low = candidate(1, { name: "Low Edge", lat: 41.61, lng: -83 });
  const high = candidate(2, { name: "High Edge", lat: 41.99, lng: -83 });
  const closeToHigh = canonical("1", {
    name: "High Edge",
    lat: 41.99,
    lng: -83 + longitudeOffsetMeters(99.9, 41.99),
  });
  const { decisions, report } = matchApizzaCandidatesV1(
    [low, high],
    { version: 1, rows: [closeToHigh] },
    { partition: PARTITION },
  );
  assert.equal(report.canonical_snapshot_rows, 1);
  assert.equal(report.canonical_rows_prefetched, 0);
  assert.deepEqual(decisions.map(({ disposition }) => disposition), ["likely_new", "likely_new"]);
});

test("UTF-8 canonical ID is the deterministic correction for complete legacy ties", () => {
  const input = candidate(1, { name: "Tie Place", lat: 42.3, lng: -83 });
  const rows = ["1", "10", "2"].map((id) => canonical(id, {
    name: "Tie Place",
    lat: 42.3,
    lng: -83 + longitudeOffsetMeters(30, 42.3),
  }));
  const { decisions } = matchApizzaCandidatesV1(
    [input],
    { version: 1, rows },
    { partition: PARTITION },
  );
  assert.equal(decisions[0]?.best_match?.canonical_place_id, "1");
});

test("canonical snapshot and output validators fail closed", () => {
  const canonicalValidator = apizzaMatchingV1SchemaValidators[
    `${APIZZA_CANONICAL_MATCH_SNAPSHOT_SCHEMA.name}@${APIZZA_CANONICAL_MATCH_SNAPSHOT_SCHEMA.version}`
  ]!;
  assert.doesNotThrow(() => canonicalValidator({
    version: 1,
    rows: [canonical("1", { name: null })],
  } as unknown as CanonicalJson));
  assert.throws(() => canonicalValidator({
    version: 1,
    rows: [canonical("2"), canonical("1")],
  } as unknown as CanonicalJson), /strictly increasing/);
  assert.throws(() => canonicalValidator({
    version: 1,
    rows: [{ ...canonical("1"), extra: true }],
  } as unknown as CanonicalJson), /does not match v1/);
  assert.throws(() => canonicalValidator({
    version: 1,
    rows: [canonical("é".repeat(129))],
  } as unknown as CanonicalJson), /does not match v1/);

  const valid = matchApizzaCandidatesV1(
    [candidate(1, { route: "excluded_out_of_scope", lat: 0, lng: 0 })],
    { version: 1, rows: [] },
    { partition: PARTITION },
  );
  assert.doesNotThrow(() => apizzaMatchingV1SchemaValidators[
    `${APIZZA_MATCH_DECISIONS_SCHEMA.name}@${APIZZA_MATCH_DECISIONS_SCHEMA.version}`
  ]!(valid.decisions as unknown as CanonicalJson));
  const exactDecision = matchApizzaCandidatesV1(
    [candidate(1, { name: "Exact" })],
    { version: 1, rows: [canonical("1", { name: "Exact", lat: 42.01, lng: -83 })] },
    { partition: PARTITION },
  ).decisions[0]!;
  assert.throws(() => apizzaMatchingV1SchemaValidators[
    `${APIZZA_MATCH_DECISIONS_SCHEMA.name}@${APIZZA_MATCH_DECISIONS_SCHEMA.version}`
  ]!([{
    ...exactDecision,
    best_match: {
      ...exactDecision.best_match!,
      distance_m: 999,
      name_score: 0,
      identifier_match: { website: false, phone: false, exact: false },
      match_method: "exact_name_nearby",
    },
    nearest_place: null,
  }] as unknown as CanonicalJson), /does not match v1/);
  assert.doesNotThrow(() => apizzaMatchingV1SchemaValidators[
    `${APIZZA_MATCH_REPORT_SCHEMA.name}@${APIZZA_MATCH_REPORT_SCHEMA.version}`
  ]!(valid.report as unknown as CanonicalJson));
  const readyReport = matchApizzaCandidatesV1(
    [candidate(1), candidate(2)],
    { version: 1, rows: [] },
    { partition: PARTITION },
  ).report;
  const contradictoryReport = {
    ...readyReport,
    active_candidates_compared: 1,
    closed_candidates_compared: 1,
    likely_new_unmatched_candidates: 1,
    closed_evidence_dropped: 1,
  };
  assert.throws(() => apizzaMatchingV1SchemaValidators[
    `${APIZZA_MATCH_REPORT_SCHEMA.name}@${APIZZA_MATCH_REPORT_SCHEMA.version}`
  ]!(contradictoryReport as unknown as CanonicalJson), /counts do not reconcile/);
  assert.throws(() => apizzaMatchingV1SchemaValidators[
    `${APIZZA_MATCH_REPORT_SCHEMA.name}@${APIZZA_MATCH_REPORT_SCHEMA.version}`
  ]!({
    ...readyReport,
    config: { ...readyReport.config, maxDistanceM: 999 },
  } as unknown as CanonicalJson), /does not match v1/);
  assert.throws(() => apizzaMatchingV1SchemaValidators[
    `${APIZZA_MATCH_REPORT_SCHEMA.name}@${APIZZA_MATCH_REPORT_SCHEMA.version}`
  ]!({
    ...valid.report,
    canonical_snapshot_rows: 1,
    canonical_rows_prefetched: 1,
    grid_cells_built: 1,
  } as unknown as CanonicalJson), /counts do not reconcile/);
});

test("matcher contract is a pure two-input APizza transform", () => {
  assert.equal(apizzaMatchingV1Manifest.sourceAdapter, null);
  assert.deepEqual(Object.keys(apizzaMatchingV1Manifest.inputs).sort(), ["candidates", "canonical"]);
  assert.deepEqual(Object.keys(apizzaMatchingV1Manifest.outputs).sort(), ["decisions", "report"]);
  assert.deepEqual(apizzaMatchingV1Manifest.effects, ["artifact.write"]);
  assert.equal(apizzaMatchingV1Manifest.delivery, "none");
});

test("plugin wrapper reads both broker inputs and persists bounded outputs", async () => {
  const sourceCandidates = [candidate(1, { route: "excluded_unusable", name: null })];
  const snapshot = { version: 1 as const, rows: [] };
  const candidateHandle = { brokerHandle: "candidates" } as unknown as DatasetHandle;
  const canonicalHandle = { brokerHandle: "canonical" } as unknown as DatasetHandle;
  const stagedValues = new Map<string, CanonicalJson>();
  const finalizedPorts: string[] = [];
  let stagedPort: string | null = null;
  const outputFor = (port: string) => ({ brokerHandle: `output:${port}` }) as unknown as DatasetRef;
  const broker = {
    async readDatasetJson(handle: DatasetHandle) {
      if (handle === candidateHandle) return sourceCandidates as unknown as CanonicalJson;
      if (handle === canonicalHandle) return snapshot as unknown as CanonicalJson;
      throw new Error("unexpected input handle");
    },
    async stageDerivedJson(input: { outputPort: string; value: CanonicalJson }) {
      if (stagedPort !== null) throw new Error("only one staged artifact is permitted");
      stagedPort = input.outputPort;
      stagedValues.set(input.outputPort, input.value);
      return { kind: "broker_staged_artifact", brokerHandle: `staged:${input.outputPort}` } as never;
    },
    async finalizeDerivedArtifact(input: { outputPort: string }) {
      assert.equal(input.outputPort, stagedPort);
      finalizedPorts.push(input.outputPort);
      stagedPort = null;
      return outputFor(input.outputPort);
    },
  } as unknown as StageBroker;
  const context = {
    runId: "matching-plugin-test",
    stageRunId: "matching-plugin-test:match:1",
    profile: "apizzamichigan",
    partition: PARTITION,
    mode: "preview",
    signal: new AbortController().signal,
    broker,
    declaredSecretRefs: [],
  } satisfies StageContext;
  const result = await createApizzaMatchingV1Plugin().run(
    context,
    { candidates: candidateHandle, canonical: canonicalHandle },
    {},
  );
  assert.deepEqual(finalizedPorts, ["decisions", "report"]);
  assert.equal(stagedPort, null);
  assert.deepEqual(
    (stagedValues.get("decisions") as unknown as Array<{ disposition: string }>)
      .map(({ disposition }) => disposition),
    ["not_compared"],
  );
  assert.equal(
    (stagedValues.get("report") as unknown as { canonical_snapshot_rows: number })
      .canonical_snapshot_rows,
    0,
  );
  assert.equal((result.outputs.decisions as DatasetRef).brokerHandle, "output:decisions");
  assert.equal((result.outputs.report as DatasetRef).brokerHandle, "output:report");
});

test("matcher rejects unordered candidates and a partition mismatch", () => {
  const first = candidate(1);
  const second = candidate(2);
  assert.throws(() => matchApizzaCandidatesV1(
    [second, first],
    { version: 1, rows: [] },
    { partition: PARTITION },
  ), /canonically ordered/);
  assert.throws(() => matchApizzaCandidatesV1(
    [{ ...first, partition: "MI" }],
    { version: 1, rows: [] },
    { partition: PARTITION },
  ), /input contract/);
  assert.throws(() => matchApizzaCandidatesV1(
    [{
      ...first,
      payload: { ...first.payload, route: "ready_for_match", is_closed: true },
    }],
    { version: 1, rows: [] },
    { partition: PARTITION },
  ), /route contradicts its payload/);
  assert.throws(() => matchApizzaCandidatesV1(
    [{
      ...first,
      payload: { ...first.payload, route: "ready_for_match", name: null },
    }],
    { version: 1, rows: [] },
    { partition: PARTITION },
  ), /route contradicts its payload/);
  assert.throws(() => matchApizzaCandidatesV1(
    [first],
    { version: 1, rows: [] },
    { partition: PARTITION, config: { gridCellDegrees: Number.MIN_VALUE } },
  ), /pinned to the legacy defaults/);
  assert.throws(() => matchApizzaCandidatesV1(
    [first],
    { version: 1, rows: [] },
    { partition: PARTITION, config: { unexpected: 1 } as never },
  ), /unexpected fields/);
});

test("byte-identical source rows remain duplicate decisions for legacy parity", () => {
  const first = candidate(1);
  const duplicate = structuredClone(first);
  const result = matchApizzaCandidatesV1(
    [first, duplicate],
    { version: 1, rows: [] },
    { partition: PARTITION },
  );
  assert.equal(result.decisions.length, 2);
  assert.equal(result.report.likely_new_unmatched_candidates, 2);
  assert.deepEqual(result.decisions[0], result.decisions[1]);
  assert.doesNotThrow(() => apizzaMatchingV1SchemaValidators[
    `${APIZZA_MATCH_DECISIONS_SCHEMA.name}@${APIZZA_MATCH_DECISIONS_SCHEMA.version}`
  ]!(result.decisions as unknown as CanonicalJson));
});

test("conflicting records cannot reuse a candidate or decision identity", () => {
  const first = candidate(1);
  const conflictingCandidate = {
    ...structuredClone(first),
    payload: { ...structuredClone(first.payload), name: "Conflicting Pizza" },
  };
  assert.throws(() => matchApizzaCandidatesV1(
    [first, conflictingCandidate],
    { version: 1, rows: [] },
    { partition: PARTITION },
  ), /identities must have identical content/);

  const decisions = matchApizzaCandidatesV1(
    [first, structuredClone(first)],
    { version: 1, rows: [] },
    { partition: PARTITION },
  ).decisions;
  const contradictoryDecisions = [
    decisions[0]!,
    {
      ...structuredClone(decisions[1]!),
      source_id: null,
      stable_source_id_present: false,
    },
  ];
  assert.throws(() => apizzaMatchingV1SchemaValidators[
    `${APIZZA_MATCH_DECISIONS_SCHEMA.name}@${APIZZA_MATCH_DECISIONS_SCHEMA.version}`
  ]!(contradictoryDecisions as unknown as CanonicalJson), /identities must have identical content/);
});
