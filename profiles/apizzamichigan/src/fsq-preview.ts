import {
  PIPELINE_API_VERSION,
  canonicalize,
  createObservationId,
  createSourceRecordKey,
  digest,
  type CanonicalJson,
  type CanonicalJsonValidator,
  type HostPolicyManifest,
  type PipelineDefinition,
  type RecordEnvelope,
  type StagePluginManifest,
} from "@map-pipeline/core";
import { createJsonFixtureSourcePlugin } from "@map-pipeline/adapter-files";
import { definePlugin, type StagePlugin } from "@map-pipeline/sdk";
import {
  APIZZA_SOURCE_CANDIDATE_SCHEMA,
  classifyApizzaCandidateRouteV1,
  normalizeApizzaCandidateTextV1 as normalizeText,
  type ApizzaCandidateRouteV1,
} from "./candidate-v1.js";
import {
  APIZZA_FSQ_RELEASE_ROWS_SCHEMA,
  validateApizzaFsqReleaseRowsV1,
} from "./fsq-release-v1.js";

const RAW_SCHEMA = { name: "apizza.fsq.synthetic-document", version: 1 } as const;
const CANDIDATE_SCHEMA = APIZZA_SOURCE_CANDIDATE_SCHEMA;
const REPORT_SCHEMA = { name: "apizza.preview-report", version: 1 } as const;
const FIXTURE_URI = "fixture://synthetic/apizza-fsq-records";

const resources = {
  admissionGroup: "fixture-preview",
  maxCpuUnits: 1,
  maxRssBytes: 134_217_728,
  maxChildProcesses: 0,
  maxWallTimeMs: 30_000,
  maxArtifactBytes: 1_048_576,
  minFreeDiskBytes: 268_435_456,
};

function lock(name: string, digit: string) {
  return {
    packageName: name,
    packageVersion: "0.0.0-preview",
    pluginApiVersion: PIPELINE_API_VERSION,
    integrity: `sha256:${digit.repeat(64)}`,
    configSchema: { name: `${name}.config`, version: 1 },
    configSchemaDigest: `sha256:${digit.repeat(64)}`,
  };
}

export const apizzaFsqPreviewCatalog: Readonly<Record<string, StagePluginManifest>> = {
  "fixture-json-source": {
    id: "fixture-json-source",
    lock: lock("@map-pipeline/adapter-files", "1"),
    inputs: {},
    outputs: {
      records: {
        schema: RAW_SCHEMA,
        cardinality: "one",
        partitioning: "by_partition",
        ordering: "canonical",
        artifactPolicy: "required",
      },
    },
    sourceAdapter: "files",
    effects: ["artifact.read", "artifact.write"],
    delivery: "none",
  },
  "apizza-fsq-normalize": {
    id: "apizza-fsq-normalize",
    lock: lock("@map-pipeline/profile-apizzamichigan", "2"),
    inputs: {
      records: {
        schema: RAW_SCHEMA,
        cardinality: "one",
        partitioning: "by_partition",
        ordering: "canonical",
        artifactPolicy: "required",
      },
    },
    outputs: {
      candidates: {
        schema: CANDIDATE_SCHEMA,
        cardinality: "many",
        partitioning: "by_partition",
        ordering: "canonical",
        artifactPolicy: "required",
      },
    },
    sourceAdapter: null,
    effects: ["artifact.write"],
    delivery: "none",
  },
  "apizza-preview-report": {
    id: "apizza-preview-report",
    lock: lock("@map-pipeline/profile-apizzamichigan", "3"),
    inputs: {
      candidates: {
        schema: CANDIDATE_SCHEMA,
        cardinality: "many",
        partitioning: "by_partition",
        ordering: "canonical",
        artifactPolicy: "required",
      },
    },
    outputs: {
      report: {
        schema: REPORT_SCHEMA,
        cardinality: "one",
        partitioning: "by_partition",
        ordering: "canonical",
        artifactPolicy: "required",
      },
    },
    sourceAdapter: null,
    effects: ["artifact.write"],
    delivery: "verified_receipt",
  },
};

export const apizzaFsqPreviewDefinition: PipelineDefinition = {
  apiVersion: PIPELINE_API_VERSION,
  kind: "Pipeline",
  metadata: { name: "apizza-fsq-fixture-preview", version: 1 },
  profile: "apizzamichigan",
  partitions: ["US"],
  stages: [
    {
      id: "source",
      uses: "fixture-json-source",
      sourceBindings: [{
        policyId: "fixture:apizza-fsq-synthetic-v1",
        effectClass: "artifact.read",
        resourceUri: FIXTURE_URI,
        operations: ["read"],
        outputPorts: ["records"],
        artifactClass: "raw",
        childIds: [],
      }],
      with: { resourceUri: FIXTURE_URI, outputPort: "records" },
      resources: { ...resources },
      requestedEffects: [
        {
          effectClass: "artifact.read",
          resourceUri: FIXTURE_URI,
          operations: ["read"],
          maxRecords: 10,
        },
        {
          effectClass: "artifact.write",
          resourceUri: "preview://apizzamichigan/fsq/source",
          operations: ["create"],
          maxRecords: 10,
        },
      ],
    },
    {
      id: "normalize",
      uses: "apizza-fsq-normalize",
      inputs: { records: "source.records" },
      with: { evaluationTime: "2026-09-06T00:00:00.000Z" },
      resources: { ...resources },
      requestedEffects: [{
        effectClass: "artifact.write",
        resourceUri: "preview://apizzamichigan/fsq/candidates",
        operations: ["create"],
        maxRecords: 10,
      }],
    },
    {
      id: "report",
      uses: "apizza-preview-report",
      inputs: { candidates: "normalize.candidates" },
      resources: { ...resources },
      requestedEffects: [{
        effectClass: "artifact.write",
        resourceUri: "preview://apizzamichigan/fsq/report",
        operations: ["create"],
        maxRecords: 10,
      }],
    },
  ],
  requiredSinks: ["report"],
  optionalSinks: [],
};

type SyntheticFsqRow = Record<string, unknown>;

interface FixtureDocument {
  fixtureId: string;
  license: string;
  synthetic: boolean;
  rows: SyntheticFsqRow[];
}

export type CandidateRoute = ApizzaCandidateRouteV1;

export interface ApizzaFsqCandidatePayloadV1 {
  source: "fsq_os_places";
  source_label: "Foursquare OS Places";
  source_id: string | null;
  name: string | null;
  lat: number | null;
  lng: number | null;
  address: string | null;
  locality: string | null;
  region: string | null;
  postcode: string | null;
  country: string | null;
  website: string | null;
  phone: string | null;
  source_url: string | null;
  confidence: number;
  is_closed: boolean;
  categories: string[];
  spider: null;
  route: CandidateRoute;
}

type CandidatePayload = ApizzaFsqCandidatePayloadV1;

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isFiniteNumberOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

const CANDIDATE_ROUTES = new Set<CandidateRoute>([
  "ready_for_match",
  "closed_evidence_candidate",
  "filtered_non_pizza",
  "excluded_unusable",
  "excluded_out_of_scope",
]);

const validateRawDocument: CanonicalJsonValidator = (value) => {
  assertRecord(value, "FSQ document");
  if (
    !hasExactKeys(value, ["fixtureId", "license", "synthetic", "rows"]) ||
    typeof value.fixtureId !== "string" ||
    typeof value.license !== "string" ||
    value.synthetic !== true ||
    !Array.isArray(value.rows) ||
    value.rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))
  ) {
    throw new TypeError("FSQ document does not match the synthetic document contract");
  }
};

export const validateApizzaSourceCandidatesV1: CanonicalJsonValidator = (value) => {
  if (!Array.isArray(value)) throw new TypeError("Candidate output must be an array");
  let partition: string | null = null;
  let priorKey: [string, string] | null = null;
  let priorCanonical: string | null = null;
  for (const candidate of value) {
    assertRecord(candidate, "Candidate");
    assertRecord(candidate.source, "Candidate source");
    assertRecord(candidate.schema, "Candidate schema");
    assertRecord(candidate.payload, "Candidate payload");
    if (
      !hasExactKeys(candidate, [
        "sourceRecordKey", "observationId", "source", "schema", "partition", "payload", "lineage",
      ]) ||
      typeof candidate.sourceRecordKey !== "string" ||
      !/^srk_[a-f0-9]{64}$/.test(candidate.sourceRecordKey) ||
      typeof candidate.observationId !== "string" ||
      !/^obs_[a-f0-9]{64}$/.test(candidate.observationId) ||
      !hasExactKeys(candidate.source, [
        "name", "namespace", "externalId", "retrievedAt", "license", "attribution",
      ]) ||
      candidate.source.name !== "fsq_os_places" ||
      candidate.source.namespace !== "foursquare" ||
      typeof candidate.source.externalId !== "string" ||
      !candidate.source.externalId ||
      typeof candidate.source.retrievedAt !== "string" ||
      Number.isNaN(Date.parse(candidate.source.retrievedAt)) ||
      typeof candidate.source.license !== "string" ||
      typeof candidate.source.attribution !== "string" ||
      !hasExactKeys(candidate.schema, ["name", "version"]) ||
      candidate.schema.name !== CANDIDATE_SCHEMA.name ||
      candidate.schema.version !== CANDIDATE_SCHEMA.version ||
      typeof candidate.partition !== "string" ||
      !candidate.partition ||
      !hasExactKeys(candidate.payload, [
        "source", "source_label", "source_id", "name", "lat", "lng", "address",
        "locality", "region", "postcode", "country", "website", "phone", "source_url",
        "confidence", "is_closed", "categories", "spider", "route",
      ]) ||
      candidate.payload.source !== "fsq_os_places" ||
      candidate.payload.source_label !== "Foursquare OS Places" ||
      !isStringOrNull(candidate.payload.source_id) ||
      !isStringOrNull(candidate.payload.name) ||
      !isFiniteNumberOrNull(candidate.payload.lat) ||
      (candidate.payload.lat !== null &&
        (candidate.payload.lat < -90 || candidate.payload.lat > 90)) ||
      !isFiniteNumberOrNull(candidate.payload.lng) ||
      (candidate.payload.lng !== null &&
        (candidate.payload.lng < -180 || candidate.payload.lng > 180)) ||
      !isStringOrNull(candidate.payload.address) ||
      !isStringOrNull(candidate.payload.locality) ||
      !isStringOrNull(candidate.payload.region) ||
      !isStringOrNull(candidate.payload.postcode) ||
      !isStringOrNull(candidate.payload.country) ||
      !isStringOrNull(candidate.payload.website) ||
      !isStringOrNull(candidate.payload.phone) ||
      !isStringOrNull(candidate.payload.source_url) ||
      typeof candidate.payload.confidence !== "number" ||
      !Number.isFinite(candidate.payload.confidence) ||
      typeof candidate.payload.is_closed !== "boolean" ||
      !Array.isArray(candidate.payload.categories) ||
      candidate.payload.categories.some((category) => typeof category !== "string") ||
      candidate.payload.spider !== null ||
      typeof candidate.payload.route !== "string" ||
      !CANDIDATE_ROUTES.has(candidate.payload.route as CandidateRoute) ||
      !Array.isArray(candidate.lineage) ||
      candidate.lineage.length === 0
    ) {
      throw new TypeError("Candidate does not match the envelope contract");
    }
    for (const entry of candidate.lineage) {
      assertRecord(entry, "Candidate lineage entry");
      const keys = Object.keys(entry);
      if (
        keys.some((key) => !["runId", "stageId", "plugin", "pluginVersion", "inputArtifact"].includes(key)) ||
        !["runId", "stageId", "plugin", "pluginVersion"].every((key) => keys.includes(key)) ||
        typeof entry.runId !== "string" || !entry.runId ||
        typeof entry.stageId !== "string" || !entry.stageId ||
        typeof entry.plugin !== "string" || !entry.plugin ||
        typeof entry.pluginVersion !== "string" || !entry.pluginVersion ||
        (entry.inputArtifact !== undefined && typeof entry.inputArtifact !== "string")
      ) {
        throw new TypeError("Candidate lineage does not match its contract");
      }
    }
    const { route, ...payloadWithoutRoute } = candidate.payload;
    if (route !== classifyApizzaCandidateRouteV1(
      payloadWithoutRoute as Omit<CandidatePayload, "route">,
    )) {
      throw new TypeError("Candidate route contradicts its payload");
    }
    if (partition !== null && candidate.partition !== partition) {
      throw new TypeError("Candidate output cannot mix partitions");
    }
    partition = candidate.partition;
    const currentKey: [string, string] = [candidate.sourceRecordKey, candidate.observationId];
    const currentCanonical = canonicalize(candidate as CanonicalJson);
    if (priorKey && (
      Buffer.compare(Buffer.from(currentKey[0], "utf8"), Buffer.from(priorKey[0], "utf8")) < 0 ||
      (currentKey[0] === priorKey[0] &&
        Buffer.compare(Buffer.from(currentKey[1], "utf8"), Buffer.from(priorKey[1], "utf8")) < 0)
    )) {
      throw new TypeError("Candidates must be canonically ordered by source record and observation ID");
    }
    if (
      priorKey &&
      currentKey[0] === priorKey[0] &&
      currentKey[1] === priorKey[1] &&
      currentCanonical !== priorCanonical
    ) {
      throw new TypeError("Duplicate candidate identities must have identical content");
    }
    priorKey = currentKey;
    priorCanonical = currentCanonical;
  }
};

const validateReport: CanonicalJsonValidator = (value) => {
  assertRecord(value, "Preview report");
  if (value.routeCounts && typeof value.routeCounts === "object" && !Array.isArray(value.routeCounts)) {
    for (const [route, count] of Object.entries(value.routeCounts)) {
      if (!CANDIDATE_ROUTES.has(route as CandidateRoute) || !Number.isSafeInteger(count) || Number(count) < 0) {
        throw new TypeError("Preview report route counts are invalid");
      }
    }
  }
  if (
    !hasExactKeys(value, [
      "version", "profile", "source", "partition", "candidateCount", "routeCounts", "sourceRecordKeys",
    ]) ||
    value.version !== 1 ||
    value.profile !== "apizzamichigan" ||
    value.source !== "fsq_os_places" ||
    typeof value.partition !== "string" ||
    !Number.isSafeInteger(value.candidateCount) || Number(value.candidateCount) < 0 ||
    !Array.isArray(value.sourceRecordKeys) ||
    value.sourceRecordKeys.some((key) => typeof key !== "string" || !/^srk_[a-f0-9]{64}$/.test(key)) ||
    value.sourceRecordKeys.length !== value.candidateCount ||
    !value.routeCounts ||
    typeof value.routeCounts !== "object" ||
    Array.isArray(value.routeCounts)
  ) {
    throw new TypeError("Preview report does not match its contract");
  }
  const total = Object.values(value.routeCounts).reduce<number>(
    (sum, count) => sum + Number(count),
    0,
  );
  if (total !== value.candidateCount) {
    throw new TypeError("Preview report route counts do not equal candidateCount");
  }
};

export const apizzaFsqPreviewSchemaValidators: Readonly<
  Record<string, CanonicalJsonValidator>
> = Object.freeze({
  [`${RAW_SCHEMA.name}@${RAW_SCHEMA.version}`]: validateRawDocument,
  [`${APIZZA_FSQ_RELEASE_ROWS_SCHEMA.name}@${APIZZA_FSQ_RELEASE_ROWS_SCHEMA.version}`]:
    validateApizzaFsqReleaseRowsV1,
  [`${CANDIDATE_SCHEMA.name}@${CANDIDATE_SCHEMA.version}`]: validateApizzaSourceCandidatesV1,
  [`${REPORT_SCHEMA.name}@${REPORT_SCHEMA.version}`]: validateReport,
});

function caseMap(row: SyntheticFsqRow): Map<string, unknown> {
  return new Map(
    Object.entries(row).map(([key, value]) => [key.toLowerCase(), value]),
  );
}

function valueFor(row: Map<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (row.has(key.toLowerCase())) return row.get(key.toLowerCase());
  }
  return null;
}

function valuesFor(row: Map<string, unknown>, keys: string[]): unknown[] {
  return keys
    .filter((key) => row.has(key.toLowerCase()))
    .map((key) => row.get(key.toLowerCase()));
}

function parseMaybeJson(value: unknown): unknown {
  if (Array.isArray(value) || (value && typeof value === "object")) return value;
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith("[") && !trimmed.startsWith("{"))) {
    return value;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function flattenStrings(value: unknown): string[] {
  const parsed = parseMaybeJson(value);
  if (parsed == null) return [];
  if (Array.isArray(parsed)) return parsed.flatMap(flattenStrings);
  if (typeof parsed === "object") return Object.values(parsed).flatMap(flattenStrings);
  return String(parsed).split(/[|;,]/).map((item) => item.trim()).filter(Boolean);
}

function firstString(value: unknown): string | null {
  return flattenStrings(value)[0] || (value ? String(value) : null);
}

function stringOrNull(value: unknown): string | null {
  return value == null ? null : String(value);
}

function isClosedDateValue(value: unknown, evaluationTimeMs: number): boolean {
  const text = String(value ?? "").trim();
  if (!text || ["null", "none", "unknown", "n/a", "not available"].includes(text.toLowerCase())) {
    return false;
  }
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) || parsed <= evaluationTimeMs;
}

function finite(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function legacyNormalizedPayload(
  row: SyntheticFsqRow,
  evaluationTimeMs: number,
): Omit<CandidatePayload, "route"> {
  const mapped = caseMap(row);
  const rawClosed = valueFor(mapped, ["date_closed"]);
  const categories = [
    ...valuesFor(mapped, [
      "fsq_category_labels",
      "category_labels",
      "categories",
      "category_name",
      "category",
      "fsq_category_ids",
    ]).flatMap(flattenStrings),
    ...flattenStrings(row.categories),
    ...flattenStrings(row.taxonomy),
  ];
  const website = firstString(valueFor(mapped, ["website"]));
  const flags = flattenStrings(valueFor(mapped, ["unresolved_flags"]))
    .map(normalizeText);
  return {
    source: "fsq_os_places",
    source_label: "Foursquare OS Places",
    source_id: firstString(valueFor(mapped, ["fsq_place_id", "fsq_id", "id"])),
    name: stringOrNull(valueFor(mapped, [
      "name",
      "label",
      "title",
      "business_name",
      "facility_name",
      "dba",
      "trade_name",
    ])),
    lat: finite(valueFor(mapped, ["latitude", "lat"])),
    lng: finite(valueFor(mapped, ["longitude", "lng", "lon"])),
    address: stringOrNull(valueFor(mapped, [
      "address",
      "addr:full",
      "addr:street_address",
      "street_address",
      "address1",
      "location_address",
    ])),
    locality: stringOrNull(valueFor(mapped, [
      "locality",
      "city",
      "addr:city",
      "municipality",
    ])),
    region: stringOrNull(valueFor(mapped, ["region", "state", "addr:state", "province"])),
    postcode: stringOrNull(valueFor(mapped, ["postcode", "postal_code", "zip", "addr:postcode"])),
    country: stringOrNull(valueFor(mapped, ["country", "addr:country"])),
    website,
    phone: firstString(valueFor(mapped, ["tel", "phone"])),
    source_url: website,
    confidence: 0,
    is_closed: isClosedDateValue(rawClosed, evaluationTimeMs) ||
      flags.some((flag) => ["closed", "delete", "doesnt exist"].includes(flag)),
    categories,
    spider: null,
  };
}

export function normalizeSyntheticFsqDocument(
  document: FixtureDocument,
  context: {
    runId: string;
    stageId: string;
    partition: string;
    pluginVersion: string;
    evaluationTime: string;
  },
): Array<RecordEnvelope<CandidatePayload>> {
  if (!document.synthetic || !Array.isArray(document.rows)) {
    throw new TypeError("FSQ fixture document must be explicitly synthetic");
  }
  return normalizeFsqRowsV1(document.rows, {
    ...context,
    fallbackRetrievedAt: "2026-09-06T00:00:00.000Z",
    license: document.license,
    attribution: "Generated synthetic fixture; no Foursquare records included",
  });
}

export function normalizeFsqRowsV1(
  rows: readonly Record<string, unknown>[],
  context: {
    runId: string;
    stageId: string;
    partition: string;
    pluginVersion: string;
    evaluationTime: string;
    fallbackRetrievedAt: string;
    license: string;
    attribution: string;
  },
): Array<RecordEnvelope<ApizzaFsqCandidatePayloadV1>> {
  if (!Array.isArray(rows) || rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))) {
    throw new TypeError("FSQ release rows must be an array of objects");
  }
  const evaluationTimeMs = Date.parse(context.evaluationTime);
  if (
    Number.isNaN(evaluationTimeMs) ||
    new Date(evaluationTimeMs).toISOString() !== context.evaluationTime
  ) {
    throw new TypeError("FSQ evaluationTime must be a canonical ISO timestamp");
  }
  const fallbackRetrievedAtMs = Date.parse(context.fallbackRetrievedAt);
  if (
    Number.isNaN(fallbackRetrievedAtMs) ||
    new Date(fallbackRetrievedAtMs).toISOString() !== context.fallbackRetrievedAt
  ) {
    throw new TypeError("FSQ fallbackRetrievedAt must be a canonical ISO timestamp");
  }
  if (!context.license || !context.attribution) {
    throw new TypeError("FSQ normalization requires explicit license and attribution text");
  }
  return rows.map((row) => {
    const payloadWithoutRoute = legacyNormalizedPayload(row, evaluationTimeMs);
    const sourceId = payloadWithoutRoute.source_id;
    const payload: CandidatePayload = {
      ...payloadWithoutRoute,
      route: classifyApizzaCandidateRouteV1(payloadWithoutRoute),
    };
    const identity = sourceId ?? `fallback-v1:${digest({
      name: normalizeText(payload.name),
      lat: payload.lat,
      lng: payload.lng,
      address: normalizeText(payload.address),
      locality: normalizeText(payload.locality),
      region: normalizeText(payload.region),
      postcode: normalizeText(payload.postcode),
      country: normalizeText(payload.country),
    })}`;
    const sourceRecordKey = createSourceRecordKey({
      profile: "apizzamichigan",
      sourceNamespace: "foursquare",
      externalId: identity,
    });
    return {
      sourceRecordKey,
      observationId: createObservationId({
        sourceRecordKey,
        payload: row as CanonicalJson,
      }),
      source: {
        name: "fsq_os_places",
        namespace: "foursquare",
        externalId: identity,
        retrievedAt: stringOrNull(row.retrieved_at) ?? context.fallbackRetrievedAt,
        license: context.license,
        attribution: context.attribution,
      },
      schema: CANDIDATE_SCHEMA,
      partition: context.partition,
      payload,
      lineage: [{
        runId: context.runId,
        stageId: context.stageId,
        plugin: "apizza-fsq-normalize",
        pluginVersion: context.pluginVersion,
      }],
    };
  }).sort((left, right) =>
    Buffer.compare(Buffer.from(left.sourceRecordKey, "utf8"), Buffer.from(right.sourceRecordKey, "utf8")) ||
    Buffer.compare(Buffer.from(left.observationId, "utf8"), Buffer.from(right.observationId, "utf8")));
}

const normalizePlugin = definePlugin<{ evaluationTime: string }>({
  manifest: apizzaFsqPreviewCatalog["apizza-fsq-normalize"]!,
  async run(context, inputs, config) {
    const document = await context.broker.readDatasetJson(inputs.records!);
    const candidates = normalizeSyntheticFsqDocument(
      document as unknown as FixtureDocument,
      {
        runId: context.runId,
        stageId: "normalize",
        partition: context.partition,
        pluginVersion: "0.0.0-preview",
        evaluationTime: config.evaluationTime,
      },
    );
    const staged = await context.broker.stageDerivedJson({
      outputPort: "candidates",
      value: candidates as unknown as CanonicalJson,
    });
    const output = await context.broker.finalizeDerivedArtifact({
      stagedArtifact: staged,
      outputPort: "candidates",
    });
    const routes = candidates.reduce<Record<string, number>>((counts, candidate) => {
      counts[candidate.payload.route] = (counts[candidate.payload.route] ?? 0) + 1;
      return counts;
    }, {});
    return {
      outputs: { candidates: output },
      metrics: { candidates: candidates.length, ...routes },
    };
  },
});

const reportPlugin = definePlugin({
  manifest: apizzaFsqPreviewCatalog["apizza-preview-report"]!,
  async run(context, inputs) {
    const candidates = await context.broker.readDatasetJson(inputs.candidates!);
    if (!Array.isArray(candidates)) throw new TypeError("Candidate input must be an array");
    const routeCounts = candidates.reduce<Record<string, number>>((counts, candidate) => {
      const route = String((candidate as { payload?: { route?: unknown } }).payload?.route ?? "unknown");
      counts[route] = (counts[route] ?? 0) + 1;
      return counts;
    }, {});
    const report = {
      version: 1,
      profile: "apizzamichigan",
      source: "fsq_os_places",
      partition: context.partition,
      candidateCount: candidates.length,
      routeCounts,
      sourceRecordKeys: candidates.map((candidate) =>
        String((candidate as { sourceRecordKey?: unknown }).sourceRecordKey ?? ""),
      ),
    };
    const staged = await context.broker.stageDerivedJson({
      outputPort: "report",
      value: report,
    });
    const { output, receipt } = await context.broker.commitStagedOutput({
      stagedArtifact: staged,
      outputPort: "report",
      effectClass: "artifact.write",
      resourceUri: "preview://apizzamichigan/fsq/report",
      operation: "create",
      idempotencyKey: `${context.runId}:report`,
      targetVersion: "preview-report@1",
    });
    return {
      outputs: { report: output },
      metrics: { candidates: candidates.length },
      deliveryReceipts: [receipt],
    };
  },
});

export const apizzaFsqPreviewPlugins: Readonly<Record<string, StagePlugin>> = {
  "fixture-json-source": createJsonFixtureSourcePlugin(
    apizzaFsqPreviewCatalog["fixture-json-source"]!,
  ),
  "apizza-fsq-normalize": normalizePlugin,
  "apizza-preview-report": reportPlugin,
};

export const apizzaPreviewHostPolicy: HostPolicyManifest = {
  id: "local-fixture-preview",
  version: 1,
  limits: {
    maxCpuUnits: 2,
    maxRssBytes: 536_870_912,
    maxChildProcesses: 0,
    minFreeDiskBytes: 268_435_456,
  },
  admissionGroups: {
    "fixture-preview": { maxConcurrency: 1 },
  },
};
