import {
  JSON_FILE_SNAPSHOT_ADAPTER,
  computeJsonFileSnapshotReaderBindingDigest,
  computeJsonFileSnapshotSourceInstanceDigest,
  createJsonFileEphemeralSnapshotSourcePlugin,
  type JsonFileSnapshotResource,
} from "@map-pipeline/adapter-files";
import {
  POSTGRES_READONLY_ADAPTER,
  computePostgresSnapshotReaderBindingDigest,
  computePostgresSourceInstanceDigest,
  createPostgresSnapshotSourcePlugin,
  type PostgresSnapshotResource,
} from "@map-pipeline/adapter-postgres";
import {
  PIPELINE_API_VERSION,
  canonicalize,
  computeHostPolicyDigest,
  computePluginCatalogDigest,
  computeProfilePolicyDigest,
  digest,
  type CanonicalJson,
  type CanonicalJsonValidator,
  type HostPolicyManifest,
  type PipelineDefinition,
  type ProfileDeclaration,
  type PreviewSourceDatasetProvenance,
  type StagePluginManifest,
} from "@map-pipeline/core";
import {
  createShadowExecutionLock,
  type ShadowExecutionLock,
  type ShadowSourceReadGrant,
} from "@map-pipeline/executor";
import { definePlugin, type StagePlugin } from "@map-pipeline/sdk";

import { APIZZA_SOURCE_CANDIDATE_SCHEMA } from "./candidate-v1.js";
import {
  apizzaFsqPreviewSchemaValidators,
  normalizeFsqRowsV1,
} from "./fsq-preview.js";
import { APIZZA_FSQ_RELEASE_ROWS_SCHEMA } from "./fsq-release-v1.js";
import {
  APIZZA_CANONICAL_MATCH_SNAPSHOT_SCHEMA,
  APIZZA_MATCH_DECISIONS_SCHEMA,
  APIZZA_MATCH_REPORT_SCHEMA,
  APIZZA_MATCHING_V1_MAX_CANDIDATES,
  APIZZA_MATCHING_V1_MAX_CANONICAL_ROWS,
  apizzaMatchingV1Manifest,
  apizzaMatchingV1SchemaValidators,
  createApizzaMatchingV1Plugin,
  matchApizzaCandidatesV1,
} from "./matching-v1.js";

export const APIZZA_FSQ_SHADOW_SOURCE_URI =
  "file-snapshot://pipeline-input/apizza-fsq-os-places-release-v1";
export const APIZZA_CANONICAL_SHADOW_SOURCE_URI =
  "postgres-view://pipeline-input/apizza-canonical-match-v1";
export const APIZZA_FSQ_SHADOW_REPORT_SCHEMA = {
  name: "apizza.fsq-shadow-report",
  version: 1,
} as const;

const FSQ_SOURCE_STAGE_ID = "fsq-source";
const NORMALIZE_STAGE_ID = "normalize";
const CANONICAL_SOURCE_STAGE_ID = "canonical-source";
const MATCH_STAGE_ID = "match";
const VERIFY_STAGE_ID = "verify";
const FSQ_POLICY_ID = "shadow:apizza-fsq-os-places-flatfile-v1";
const CANONICAL_POLICY_ID = "shadow:apizza-canonical-read-v1";

const sourceResources = {
  admissionGroup: "apizza-fsq-shadow",
  maxCpuUnits: 1,
  maxRssBytes: 536_870_912,
  maxChildProcesses: 0,
  maxWallTimeMs: 120_000,
  maxArtifactBytes: 16_777_216,
  minFreeDiskBytes: 2_147_483_648,
} as const;

const transformResources = {
  admissionGroup: "apizza-fsq-shadow",
  maxCpuUnits: 2,
  maxRssBytes: 1_073_741_824,
  maxChildProcesses: 0,
  maxWallTimeMs: 300_000,
  maxArtifactBytes: 134_217_728,
  minFreeDiskBytes: 2_147_483_648,
} as const;

const verifyResources = {
  ...transformResources,
  maxCpuUnits: 1,
} as const;

function lock(name: string, digit: string) {
  return {
    packageName: name,
    packageVersion: "0.0.0-shadow-v1",
    pluginApiVersion: PIPELINE_API_VERSION,
    integrity: `sha256:${digit.repeat(64)}`,
    configSchema: { name: `${name}.shadow-v1-config`, version: 1 },
    configSchemaDigest: `sha256:${digit.repeat(64)}`,
  };
}

const fsqSourceManifest: StagePluginManifest = {
  id: "apizza-fsq-ephemeral-source-v1",
  lock: lock("@map-pipeline/adapter-files", "5"),
  inputs: {},
  outputs: {
    rows: {
      schema: APIZZA_FSQ_RELEASE_ROWS_SCHEMA,
      cardinality: "many",
      partitioning: "by_partition",
      ordering: "canonical",
      artifactPolicy: "forbidden",
    },
  },
  sourceAdapter: JSON_FILE_SNAPSHOT_ADAPTER,
  effects: ["artifact.read"],
  delivery: "none",
};

const normalizeManifest: StagePluginManifest = {
  id: "apizza-fsq-normalize-v1",
  lock: lock("@map-pipeline/profile-apizzamichigan", "6"),
  inputs: {
    rows: {
      schema: APIZZA_FSQ_RELEASE_ROWS_SCHEMA,
      cardinality: "many",
      partitioning: "by_partition",
      ordering: "canonical",
      artifactPolicy: "forbidden",
    },
  },
  outputs: {
    candidates: {
      schema: APIZZA_SOURCE_CANDIDATE_SCHEMA,
      cardinality: "many",
      partitioning: "by_partition",
      ordering: "canonical",
      artifactPolicy: "required",
    },
  },
  sourceAdapter: null,
  effects: ["artifact.write"],
  delivery: "none",
};

const canonicalSourceManifest: StagePluginManifest = {
  id: "apizza-canonical-postgres-source-v1",
  lock: lock("@map-pipeline/adapter-postgres", "7"),
  inputs: {},
  outputs: {
    canonical: {
      schema: APIZZA_CANONICAL_MATCH_SNAPSHOT_SCHEMA,
      cardinality: "many",
      partitioning: "by_partition",
      ordering: "canonical",
      artifactPolicy: "required",
    },
  },
  sourceAdapter: POSTGRES_READONLY_ADAPTER,
  effects: ["network.read", "artifact.write"],
  delivery: "none",
};

const verifyManifest: StagePluginManifest = {
  id: "apizza-fsq-shadow-verify-v1",
  lock: lock("@map-pipeline/profile-apizzamichigan", "8"),
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
    decisions: {
      schema: APIZZA_MATCH_DECISIONS_SCHEMA,
      cardinality: "many",
      partitioning: "by_partition",
      ordering: "canonical",
      artifactPolicy: "required",
    },
    matchReport: {
      schema: APIZZA_MATCH_REPORT_SCHEMA,
      cardinality: "one",
      partitioning: "by_partition",
      ordering: "canonical",
      artifactPolicy: "required",
    },
  },
  outputs: {
    report: {
      schema: APIZZA_FSQ_SHADOW_REPORT_SCHEMA,
      cardinality: "one",
      partitioning: "by_partition",
      ordering: "canonical",
      artifactPolicy: "required",
    },
  },
  sourceAdapter: null,
  effects: ["artifact.write"],
  delivery: "verified_receipt",
};

export const apizzaFsqShadowV1Catalog: Readonly<Record<string, StagePluginManifest>> =
  Object.freeze({
    [fsqSourceManifest.id]: fsqSourceManifest,
    [normalizeManifest.id]: normalizeManifest,
    [canonicalSourceManifest.id]: canonicalSourceManifest,
    [apizzaMatchingV1Manifest.id]: apizzaMatchingV1Manifest,
    [verifyManifest.id]: verifyManifest,
  });

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isCanonicalHttpsUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" &&
    parsed.toString() === value &&
    !parsed.username &&
    !parsed.password &&
    !parsed.port &&
    !parsed.search &&
    !parsed.hash;
}

const validateShadowReport: CanonicalJsonValidator = (value) => {
  assertRecord(value, "APizza FSQ shadow report");
  if (
    !exactKeys(value, [
      "version",
      "profile",
      "source",
      "partition",
      "authority",
      "verification",
      "legacy_parity",
      "source_policy_assertion_digest",
      "source_policy_verification",
      "source_terms_ref",
      "evaluation_time",
      "runtime_policy_digest",
      "fsq_source_attestation_digest",
      "canonical_source_attestation_digest",
      "decisions_content_digest",
      "decisions_manifest_digest",
      "match_report_content_digest",
      "match_report_manifest_digest",
      "candidate_rows",
      "decision_rows",
      "canonical_snapshot_rows",
      "match_report_reconciled",
      "product_writes",
    ]) ||
    value.version !== 1 ||
    value.profile !== "apizzamichigan" ||
    value.source !== "fsq_os_places" ||
    typeof value.partition !== "string" ||
    !value.partition ||
    value.authority !== "read_only_shadow" ||
    value.verification !== "internal_contracts_only" ||
    value.legacy_parity !== "not_evaluated" ||
    typeof value.source_policy_assertion_digest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(value.source_policy_assertion_digest) ||
    value.source_policy_verification !== "unverified_operator_assertion" ||
    typeof value.source_terms_ref !== "string" ||
    !isCanonicalHttpsUrl(value.source_terms_ref) ||
    typeof value.evaluation_time !== "string" ||
    Number.isNaN(Date.parse(value.evaluation_time)) ||
    new Date(value.evaluation_time).toISOString() !== value.evaluation_time ||
    ![value.runtime_policy_digest, value.fsq_source_attestation_digest,
      value.canonical_source_attestation_digest, value.decisions_content_digest,
      value.decisions_manifest_digest, value.match_report_content_digest,
      value.match_report_manifest_digest]
      .every((item) => typeof item === "string" && /^sha256:[a-f0-9]{64}$/.test(item)) ||
    !Number.isSafeInteger(value.candidate_rows) || Number(value.candidate_rows) < 0 ||
    !Number.isSafeInteger(value.decision_rows) || Number(value.decision_rows) < 0 ||
    !Number.isSafeInteger(value.canonical_snapshot_rows) ||
    Number(value.canonical_snapshot_rows) < 0 ||
    value.match_report_reconciled !== true ||
    value.product_writes !== 0 ||
    value.candidate_rows !== value.decision_rows
  ) {
    throw new TypeError("APizza FSQ shadow report does not match v1");
  }
};

export const apizzaFsqShadowV1SchemaValidators: Readonly<
  Record<string, CanonicalJsonValidator>
> = Object.freeze({
  ...apizzaFsqPreviewSchemaValidators,
  ...apizzaMatchingV1SchemaValidators,
  [`${APIZZA_FSQ_SHADOW_REPORT_SCHEMA.name}@${APIZZA_FSQ_SHADOW_REPORT_SCHEMA.version}`]:
    validateShadowReport,
});

interface NormalizeConfig {
  evaluationTime: string;
  fallbackRetrievedAt: string;
  sourceLicense: string;
  sourceAttribution: string;
}

const normalizePlugin = definePlugin<NormalizeConfig>({
  manifest: normalizeManifest,
  async run(context, inputs, config) {
    const rows = await context.broker.readDatasetJson(inputs.rows!);
    if (!Array.isArray(rows)) throw new TypeError("FSQ release rows must be an array");
    const candidates = normalizeFsqRowsV1(
      rows as Array<Record<string, unknown>>,
      {
        runId: context.runId,
        stageId: NORMALIZE_STAGE_ID,
        partition: context.partition,
        pluginVersion: normalizeManifest.lock.packageVersion,
        evaluationTime: config.evaluationTime,
        fallbackRetrievedAt: config.fallbackRetrievedAt,
        license: config.sourceLicense,
        attribution: config.sourceAttribution,
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
    return {
      outputs: { candidates: output },
      metrics: { candidates: candidates.length },
    };
  },
});

const verifyPlugin = definePlugin<{
  sourcePolicyAssertionDigest: string;
  sourceTermsRef: string;
  evaluationTime: string;
}>({
  manifest: verifyManifest,
  async run(context, inputs, config) {
    const candidates = await context.broker.readDatasetJson(inputs.candidates!);
    const canonicalSnapshot = await context.broker.readDatasetJson(inputs.canonical!);
    const decisions = await context.broker.readDatasetJson(inputs.decisions!);
    const matchReport = await context.broker.readDatasetJson(inputs.matchReport!);
    if (!Array.isArray(candidates)) throw new TypeError("Candidates must be an array");
    assertRecord(canonicalSnapshot, "APizza canonical snapshot");
    if (!Array.isArray(canonicalSnapshot.rows)) {
      throw new TypeError("APizza canonical snapshot rows must be an array");
    }
    if (!Array.isArray(decisions)) throw new TypeError("Match decisions must be an array");
    assertRecord(matchReport, "APizza match report");
    const candidateRows = Number(matchReport.candidate_rows);
    const decisionRows = Number(matchReport.decision_rows);
    const routeCounts = Object.fromEntries([
      "ready_for_match",
      "closed_evidence_candidate",
      "filtered_non_pizza",
      "excluded_unusable",
      "excluded_out_of_scope",
    ].map((route) => [route, decisions.filter((decision) =>
      (decision as { candidate_route?: unknown }).candidate_route === route).length]));
    const dispositionCount = (disposition: string) => decisions.filter((decision) =>
      (decision as { disposition?: unknown }).disposition === disposition).length;
    const legacyActiveMatchesWithSourceId = decisions.filter((decision) => {
      const value = decision as {
        candidate_route?: unknown;
        disposition?: unknown;
        stable_source_id_present?: unknown;
      };
      return value.candidate_route === "ready_for_match" &&
        value.disposition === "matched_existing" &&
        value.stable_source_id_present === true;
    }).length;
    const candidatesInput = inputs.candidates!;
    const canonicalInput = inputs.canonical!;
    const decisionsInput = inputs.decisions!;
    const reportInput = inputs.matchReport!;
    if (
      candidatesInput.kind !== "artifact" ||
      candidatesInput.provenance.kind !== "internal" ||
      canonicalInput.kind !== "artifact" ||
      canonicalInput.provenance.kind !== "preview_source" ||
      decisionsInput.kind !== "artifact" ||
      decisionsInput.provenance.kind !== "internal" ||
      reportInput.kind !== "artifact" ||
      reportInput.provenance.kind !== "internal"
    ) {
      throw new TypeError("APizza shadow verifier requires internal artifact inputs");
    }
    const candidateSources = candidatesInput.provenance.sourceProvenance ?? [];
    const canonicalSources = [canonicalInput.provenance];
    const decisionsSources = decisionsInput.provenance.sourceProvenance ?? [];
    const reportSources = reportInput.provenance.sourceProvenance ?? [];
    if (canonicalize(decisionsSources as unknown as CanonicalJson) !==
      canonicalize(reportSources as unknown as CanonicalJson)) {
      throw new TypeError("APizza shadow outputs do not share exact source provenance");
    }
    const fsqSource = candidateSources.find((source): source is PreviewSourceDatasetProvenance =>
      source.kind === "preview_source" &&
      source.producingStageId === FSQ_SOURCE_STAGE_ID &&
      source.sourceAdapter === JSON_FILE_SNAPSHOT_ADAPTER &&
      source.resourceUri === APIZZA_FSQ_SHADOW_SOURCE_URI &&
      source.snapshot.contractName === "apizza-fsq-release-rows" &&
      source.snapshot.contractVersion === 1);
    const canonicalSource = canonicalSources.find(
      (source): source is PreviewSourceDatasetProvenance =>
      source.kind === "preview_source" &&
      source.producingStageId === CANONICAL_SOURCE_STAGE_ID &&
      source.sourceAdapter === POSTGRES_READONLY_ADAPTER &&
      source.resourceUri === APIZZA_CANONICAL_SHADOW_SOURCE_URI &&
      source.snapshot.contractName === "apizza-canonical-match" &&
      source.snapshot.contractVersion === 1,
    );
    const matchedFsqSource = decisionsSources.find((source) =>
      source.kind === "preview_source" && source.producingStageId === FSQ_SOURCE_STAGE_ID);
    const matchedCanonicalSource = decisionsSources.find((source) =>
      source.kind === "preview_source" && source.producingStageId === CANONICAL_SOURCE_STAGE_ID);
    const expectedMatcherParents = [
      candidatesInput.brokerHandle,
      canonicalInput.brokerHandle,
    ].sort();
    const sameMatcherParents = (parentHandles: string[]) =>
      canonicalize([...parentHandles].sort() as CanonicalJson) ===
        canonicalize(expectedMatcherParents as CanonicalJson);
    const canonicalById = new Map(canonicalSnapshot.rows.map((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row) ||
          typeof row.canonical_place_id !== "string") return ["", null] as const;
      return [row.canonical_place_id, row] as const;
    }));
    const referenceReconciles = (reference: unknown): boolean => {
      if (reference === null) return true;
      if (!reference || typeof reference !== "object" || Array.isArray(reference) ||
          typeof (reference as Record<string, unknown>).canonical_place_id !== "string") {
        return false;
      }
      const checked = reference as Record<string, unknown>;
      const canonical = canonicalById.get(checked.canonical_place_id as string);
      return Boolean(canonical &&
        checked.name === canonical.name &&
        checked.google_place_id === canonical.google_place_id);
    };
    const identitiesReconcile = candidates.every((candidate, index) => {
      const decision = decisions[index];
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) ||
          !candidate.payload || typeof candidate.payload !== "object" ||
          Array.isArray(candidate.payload) ||
          !decision || typeof decision !== "object" || Array.isArray(decision)) return false;
      return candidate.sourceRecordKey === decision.source_record_key &&
        candidate.observationId === decision.observation_id &&
        candidate.payload.route === decision.candidate_route &&
        candidate.payload.source_id === decision.source_id &&
        decision.stable_source_id_present === Boolean(candidate.payload.source_id) &&
        referenceReconciles(decision.best_match) &&
        referenceReconciles(decision.nearest_place);
    });
    const recomputed = matchApizzaCandidatesV1(
      candidates as never,
      canonicalSnapshot as never,
      { partition: context.partition, config: {} },
    );
    if (
      candidatesInput.recordCount !== candidates.length ||
      canonicalInput.recordCount !== canonicalSnapshot.rows.length ||
      decisions.length !== decisionRows ||
      decisionsInput.recordCount !== decisions.length ||
      reportInput.recordCount !== 1 ||
      candidateRows !== decisionRows ||
      candidateRows !== candidates.length ||
      !identitiesReconcile ||
      canonicalize(decisions) !==
        canonicalize(recomputed.decisions as unknown as CanonicalJson) ||
      canonicalize(matchReport as CanonicalJson) !==
        canonicalize(recomputed.report as unknown as CanonicalJson) ||
      Number(matchReport.canonical_snapshot_rows) !== canonicalSnapshot.rows.length ||
      canonicalize(routeCounts as CanonicalJson) !==
        canonicalize(matchReport.candidate_route_counts as CanonicalJson) ||
      routeCounts.ready_for_match !== matchReport.active_candidates_compared ||
      routeCounts.closed_evidence_candidate !== matchReport.closed_candidates_compared ||
      dispositionCount("matched_existing") !== matchReport.matched_existing_places ||
      dispositionCount("ambiguous_review") !== matchReport.ambiguous_review_candidates ||
      dispositionCount("likely_new") !== matchReport.likely_new_unmatched_candidates ||
      dispositionCount("closed_evidence") !== matchReport.closed_signals_matched ||
      dispositionCount("closed_evidence_dropped") !== matchReport.closed_evidence_dropped ||
      legacyActiveMatchesWithSourceId !== matchReport.legacy_active_matches_with_source_id ||
      matchReport.partition !== context.partition ||
      !/^sha256:[a-f0-9]{64}$/.test(config.sourcePolicyAssertionDigest) ||
      !isCanonicalHttpsUrl(config.sourceTermsRef) ||
      Number.isNaN(Date.parse(config.evaluationTime)) ||
      new Date(config.evaluationTime).toISOString() !== config.evaluationTime ||
      candidateSources.length !== 1 ||
      canonicalSources.length !== 1 ||
      decisionsSources.length !== 2 ||
      !fsqSource ||
      !canonicalSource ||
      fsqSource.recordCount !== candidates.length ||
      canonicalSource.recordCount !== canonicalSnapshot.rows.length ||
      !matchedFsqSource ||
      !matchedCanonicalSource ||
      canonicalize(fsqSource as unknown as CanonicalJson) !==
        canonicalize(matchedFsqSource as unknown as CanonicalJson) ||
      canonicalize(canonicalSource as unknown as CanonicalJson) !==
        canonicalize(matchedCanonicalSource as unknown as CanonicalJson) ||
      !sameMatcherParents(decisionsInput.provenance.parentHandles) ||
      !sameMatcherParents(reportInput.provenance.parentHandles) ||
      fsqSource.runtimePolicyDigest !== canonicalSource.runtimePolicyDigest
    ) {
      throw new TypeError("APizza shadow inputs do not reconcile");
    }
    const report = {
      version: 1,
      profile: "apizzamichigan",
      source: "fsq_os_places",
      partition: context.partition,
      authority: "read_only_shadow",
      verification: "internal_contracts_only",
      legacy_parity: "not_evaluated",
      source_policy_assertion_digest: config.sourcePolicyAssertionDigest,
      source_policy_verification: "unverified_operator_assertion",
      source_terms_ref: config.sourceTermsRef,
      evaluation_time: config.evaluationTime,
      runtime_policy_digest: fsqSource.runtimePolicyDigest,
      fsq_source_attestation_digest: digest(fsqSource as unknown as CanonicalJson),
      canonical_source_attestation_digest: digest(canonicalSource as unknown as CanonicalJson),
      decisions_content_digest: decisionsInput.contentDigest,
      decisions_manifest_digest: decisionsInput.manifestDigest,
      match_report_content_digest: reportInput.contentDigest,
      match_report_manifest_digest: reportInput.manifestDigest,
      candidate_rows: candidateRows,
      decision_rows: decisionRows,
      canonical_snapshot_rows: Number(matchReport.canonical_snapshot_rows),
      match_report_reconciled: true,
      product_writes: 0,
    } as const;
    const staged = await context.broker.stageDerivedJson({
      outputPort: "report",
      value: report,
    });
    const { output, receipt } = await context.broker.commitStagedOutput({
      stagedArtifact: staged,
      outputPort: "report",
      effectClass: "artifact.write",
      resourceUri: "preview://apizzamichigan/fsq-shadow/report",
      operation: "create",
      idempotencyKey: `${context.runId}:fsq-shadow-report`,
      targetVersion: "apizza.fsq-shadow-report@1",
    });
    return {
      outputs: { report: output },
      metrics: { candidates: candidateRows, decisions: decisionRows },
      deliveryReceipts: [receipt],
    };
  },
});

export const apizzaFsqShadowV1Plugins: Readonly<Record<string, StagePlugin>> =
  Object.freeze({
    [fsqSourceManifest.id]: createJsonFileEphemeralSnapshotSourcePlugin(fsqSourceManifest),
    [normalizeManifest.id]: normalizePlugin,
    [canonicalSourceManifest.id]: createPostgresSnapshotSourcePlugin(canonicalSourceManifest),
    [apizzaMatchingV1Manifest.id]: createApizzaMatchingV1Plugin(),
    [verifyManifest.id]: verifyPlugin,
  });

export interface ApizzaFsqShadowV1DefinitionInput {
  evaluationTime: string;
  fallbackRetrievedAt: string;
  sourceLicense: string;
  sourceAttribution: string;
  sourcePolicyAssertionDigest: string;
  sourceTermsRef: string;
  fsqChildIds: readonly string[];
  maxFsqRecords?: number;
}

function assertCanonicalInstant(value: string, label: string): void {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
}

export function createApizzaFsqShadowV1Definition(
  input: ApizzaFsqShadowV1DefinitionInput,
): PipelineDefinition {
  assertCanonicalInstant(input.evaluationTime, "evaluationTime");
  assertCanonicalInstant(input.fallbackRetrievedAt, "fallbackRetrievedAt");
  if (!input.sourceLicense.trim() || !input.sourceAttribution.trim()) {
    throw new TypeError("FSQ shadow definition requires explicit license and attribution text");
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(input.sourcePolicyAssertionDigest)) {
    throw new TypeError("FSQ shadow definition requires a source-policy assertion digest");
  }
  if (!isCanonicalHttpsUrl(input.sourceTermsRef)) {
    throw new TypeError("FSQ shadow definition requires a canonical HTTPS source terms URL");
  }
  if (
    input.fsqChildIds.length === 0 ||
    new Set(input.fsqChildIds).size !== input.fsqChildIds.length ||
    input.fsqChildIds.some((childId) => !childId || childId.trim() !== childId)
  ) {
    throw new TypeError("FSQ shadow definition requires exact, unique release child IDs");
  }
  const maxFsqRecords = input.maxFsqRecords ?? APIZZA_MATCHING_V1_MAX_CANDIDATES;
  if (
    !Number.isSafeInteger(maxFsqRecords) ||
    maxFsqRecords < 1 ||
    maxFsqRecords > APIZZA_MATCHING_V1_MAX_CANDIDATES
  ) {
    throw new TypeError(
      `maxFsqRecords must be from 1 through ${APIZZA_MATCHING_V1_MAX_CANDIDATES}`,
    );
  }
  return {
    apiVersion: PIPELINE_API_VERSION,
    kind: "Pipeline",
    metadata: { name: "apizza-fsq-read-only-shadow", version: 1 },
    profile: "apizzamichigan",
    partitions: ["US"],
    stages: [
      {
        id: FSQ_SOURCE_STAGE_ID,
        uses: fsqSourceManifest.id,
        sourceBindings: [{
          policyId: FSQ_POLICY_ID,
          effectClass: "artifact.read",
          resourceUri: APIZZA_FSQ_SHADOW_SOURCE_URI,
          operations: ["snapshot"],
          outputPorts: ["rows"],
          artifactClass: "raw",
          childIds: [...input.fsqChildIds],
        }],
        with: { resourceUri: APIZZA_FSQ_SHADOW_SOURCE_URI, outputPort: "rows" },
        resources: { ...sourceResources },
        requestedEffects: [{
          effectClass: "artifact.read",
          resourceUri: APIZZA_FSQ_SHADOW_SOURCE_URI,
          operations: ["snapshot"],
          maxRecords: maxFsqRecords,
        }],
      },
      {
        id: NORMALIZE_STAGE_ID,
        uses: normalizeManifest.id,
        inputs: { rows: `${FSQ_SOURCE_STAGE_ID}.rows` },
        with: {
          evaluationTime: input.evaluationTime,
          fallbackRetrievedAt: input.fallbackRetrievedAt,
          sourceLicense: input.sourceLicense,
          sourceAttribution: input.sourceAttribution,
        },
        resources: { ...transformResources },
        requestedEffects: [{
          effectClass: "artifact.write",
          resourceUri: "preview://apizzamichigan/fsq-shadow/candidates",
          operations: ["create"],
          maxRecords: maxFsqRecords,
        }],
      },
      {
        id: CANONICAL_SOURCE_STAGE_ID,
        uses: canonicalSourceManifest.id,
        sourceBindings: [{
          policyId: CANONICAL_POLICY_ID,
          effectClass: "network.read",
          resourceUri: APIZZA_CANONICAL_SHADOW_SOURCE_URI,
          operations: ["snapshot"],
          outputPorts: ["canonical"],
          artifactClass: "derived",
          childIds: [],
        }],
        with: { resourceUri: APIZZA_CANONICAL_SHADOW_SOURCE_URI, outputPort: "canonical" },
        resources: { ...transformResources },
        requestedEffects: [
          {
            effectClass: "network.read",
            resourceUri: APIZZA_CANONICAL_SHADOW_SOURCE_URI,
            operations: ["snapshot"],
            maxRecords: APIZZA_MATCHING_V1_MAX_CANONICAL_ROWS,
          },
          {
            effectClass: "artifact.write",
            resourceUri: "preview://apizzamichigan/fsq-shadow/canonical",
            operations: ["create"],
            maxRecords: APIZZA_MATCHING_V1_MAX_CANONICAL_ROWS,
          },
        ],
      },
      {
        id: MATCH_STAGE_ID,
        uses: apizzaMatchingV1Manifest.id,
        inputs: {
          candidates: `${NORMALIZE_STAGE_ID}.candidates`,
          canonical: `${CANONICAL_SOURCE_STAGE_ID}.canonical`,
        },
        with: {},
        resources: { ...transformResources },
        requestedEffects: [{
          effectClass: "artifact.write",
          resourceUri: "preview://apizzamichigan/fsq-shadow/matches",
          operations: ["create"],
          maxRecords: maxFsqRecords + 1,
        }],
      },
      {
        id: VERIFY_STAGE_ID,
        uses: verifyManifest.id,
        inputs: {
          candidates: `${NORMALIZE_STAGE_ID}.candidates`,
          canonical: `${CANONICAL_SOURCE_STAGE_ID}.canonical`,
          decisions: `${MATCH_STAGE_ID}.decisions`,
          matchReport: `${MATCH_STAGE_ID}.report`,
        },
        with: {
          sourcePolicyAssertionDigest: input.sourcePolicyAssertionDigest,
          sourceTermsRef: input.sourceTermsRef,
          evaluationTime: input.evaluationTime,
        },
        resources: { ...verifyResources },
        requestedEffects: [{
          effectClass: "artifact.write",
          resourceUri: "preview://apizzamichigan/fsq-shadow/report",
          operations: ["create"],
          maxRecords: 1,
        }],
      },
    ],
    requiredSinks: [VERIFY_STAGE_ID],
    optionalSinks: [],
  };
}

export const apizzaFsqShadowV1HostPolicy: HostPolicyManifest = {
  id: "apizza-fsq-read-only-shadow-v1",
  version: 1,
  limits: {
    maxCpuUnits: 2,
    maxRssBytes: 1_073_741_824,
    maxChildProcesses: 0,
    minFreeDiskBytes: 2_147_483_648,
  },
  admissionGroups: {
    "apizza-fsq-shadow": { maxConcurrency: 1 },
  },
};

const APIZZA_FSQ_SHADOW_PROFILE_POLICY_DIGEST =
  "sha256:442cb3324743cfe8607cdfe4f54c7f84d57653c2be0d7c54a341e1682de22eaf";
const APIZZA_FSQ_SHADOW_CATALOG_DIGEST =
  "sha256:485664321200bcb33d24d5da799bca12f879d3f7394e1a38c7d4cb7f5fa6044c";
const APIZZA_FSQ_SHADOW_HOST_POLICY_DIGEST =
  "sha256:b45ac6afbb41d08093188c5a368465b3f5932a142a129a2bb1ffc262ec172c4b";

function assertApizzaFsqShadowV1DefinitionIdentity(definition: PipelineDefinition): void {
  const stageIdentity = definition.stages.map((stage) => ({
    id: stage.id,
    uses: stage.uses,
    sourceBindings: (stage.sourceBindings ?? []).map((binding) => ({
      policyId: binding.policyId,
      effectClass: binding.effectClass,
      resourceUri: binding.resourceUri,
      operations: [...binding.operations],
      outputPorts: [...binding.outputPorts],
      artifactClass: binding.artifactClass,
    })),
  }));
  const expectedStageIdentity = [
    {
      id: FSQ_SOURCE_STAGE_ID,
      uses: fsqSourceManifest.id,
      sourceBindings: [{
        policyId: FSQ_POLICY_ID,
        effectClass: "artifact.read",
        resourceUri: APIZZA_FSQ_SHADOW_SOURCE_URI,
        operations: ["snapshot"],
        outputPorts: ["rows"],
        artifactClass: "raw",
      }],
    },
    { id: NORMALIZE_STAGE_ID, uses: normalizeManifest.id, sourceBindings: [] },
    {
      id: CANONICAL_SOURCE_STAGE_ID,
      uses: canonicalSourceManifest.id,
      sourceBindings: [{
        policyId: CANONICAL_POLICY_ID,
        effectClass: "network.read",
        resourceUri: APIZZA_CANONICAL_SHADOW_SOURCE_URI,
        operations: ["snapshot"],
        outputPorts: ["canonical"],
        artifactClass: "derived",
      }],
    },
    { id: MATCH_STAGE_ID, uses: apizzaMatchingV1Manifest.id, sourceBindings: [] },
    { id: VERIFY_STAGE_ID, uses: verifyManifest.id, sourceBindings: [] },
  ];
  if (
    definition.apiVersion !== PIPELINE_API_VERSION ||
    definition.kind !== "Pipeline" ||
    definition.profile !== "apizzamichigan" ||
    definition.metadata.name !== "apizza-fsq-read-only-shadow" ||
    definition.metadata.version !== 1 ||
    canonicalize(definition.partitions ?? []) !== canonicalize(["US"]) ||
    canonicalize(definition.requiredSinks) !== canonicalize([VERIFY_STAGE_ID]) ||
    canonicalize(definition.optionalSinks) !== canonicalize([]) ||
    canonicalize(stageIdentity as unknown as CanonicalJson) !==
      canonicalize(expectedStageIdentity as unknown as CanonicalJson)
  ) {
    throw new TypeError("APizza FSQ shadow definition identity has drifted");
  }
}

export function createApizzaFsqShadowV1ExecutionLock(input: {
  definition: PipelineDefinition;
  profile: ProfileDeclaration;
  deploymentIdentity: string;
}): Readonly<ShadowExecutionLock> {
  assertApizzaFsqShadowV1DefinitionIdentity(input.definition);
  if (
    input.profile.id !== "apizzamichigan" ||
    computeProfilePolicyDigest(input.profile) !== APIZZA_FSQ_SHADOW_PROFILE_POLICY_DIGEST ||
    computePluginCatalogDigest(apizzaFsqShadowV1Catalog) !== APIZZA_FSQ_SHADOW_CATALOG_DIGEST ||
    computeHostPolicyDigest(apizzaFsqShadowV1HostPolicy) !== APIZZA_FSQ_SHADOW_HOST_POLICY_DIGEST
  ) {
    throw new TypeError("APizza FSQ shadow profile, catalog, or host policy has drifted");
  }
  return createShadowExecutionLock({
    definition: input.definition,
    catalog: apizzaFsqShadowV1Catalog,
    profile: input.profile,
    hostPolicy: apizzaFsqShadowV1HostPolicy,
    deploymentIdentity: input.deploymentIdentity,
  });
}

export function createApizzaFsqShadowV1ReadGrants(input: {
  definition: PipelineDefinition;
  fsqResource: JsonFileSnapshotResource;
  canonicalResource: PostgresSnapshotResource;
}): readonly ShadowSourceReadGrant[] {
  assertApizzaFsqShadowV1DefinitionIdentity(input.definition);
  if (
    input.fsqResource.resourceUri !== APIZZA_FSQ_SHADOW_SOURCE_URI ||
    input.fsqResource.schema.name !== APIZZA_FSQ_RELEASE_ROWS_SCHEMA.name ||
    input.fsqResource.schema.version !== APIZZA_FSQ_RELEASE_ROWS_SCHEMA.version
  ) {
    throw new TypeError("FSQ host resource does not match the APizza shadow contract");
  }
  if (
    input.canonicalResource.resourceUri !== APIZZA_CANONICAL_SHADOW_SOURCE_URI ||
    input.canonicalResource.schema.name !== APIZZA_CANONICAL_MATCH_SNAPSHOT_SCHEMA.name ||
    input.canonicalResource.schema.version !== APIZZA_CANONICAL_MATCH_SNAPSHOT_SCHEMA.version
  ) {
    throw new TypeError("Canonical host resource does not match the APizza shadow contract");
  }
  const fsqBinding = input.definition.stages
    .find((stage) => stage.id === FSQ_SOURCE_STAGE_ID)?.sourceBindings?.[0];
  const canonicalBinding = input.definition.stages
    .find((stage) => stage.id === CANONICAL_SOURCE_STAGE_ID)?.sourceBindings?.[0];
  if (
    !fsqBinding ||
    fsqBinding.policyId !== FSQ_POLICY_ID ||
    fsqBinding.resourceUri !== input.fsqResource.resourceUri ||
    fsqBinding.childIds.length !== input.fsqResource.childIds.length ||
    [...fsqBinding.childIds].sort().some(
      (childId, index) => childId !== [...input.fsqResource.childIds].sort()[index],
    ) ||
    !canonicalBinding ||
    canonicalBinding.policyId !== CANONICAL_POLICY_ID ||
    canonicalBinding.resourceUri !== input.canonicalResource.resourceUri
  ) {
    throw new TypeError("Shadow definition and host resources do not share exact source bindings");
  }
  const fsqMaxRecords = input.definition.stages
    .find((stage) => stage.id === FSQ_SOURCE_STAGE_ID)?.requestedEffects?.[0]?.maxRecords;
  const canonicalMaxRecords = input.definition.stages
    .find((stage) => stage.id === CANONICAL_SOURCE_STAGE_ID)?.requestedEffects?.find(
      (effect) => effect.effectClass === "network.read",
    )?.maxRecords;
  if (!fsqMaxRecords || !canonicalMaxRecords) {
    throw new TypeError("Shadow definition lacks bounded source reads");
  }
  return Object.freeze([
    {
      stageId: FSQ_SOURCE_STAGE_ID,
      sourceAdapter: JSON_FILE_SNAPSHOT_ADAPTER,
      policyId: FSQ_POLICY_ID,
      effectClass: "artifact.read" as const,
      resourceUri: input.fsqResource.resourceUri,
      operations: [input.fsqResource.operation],
      partitions: [...input.fsqResource.partitions],
      maxRecords: fsqMaxRecords,
      snapshot: {
        consistency: "immutable" as const,
        sourceInstanceDigest: computeJsonFileSnapshotSourceInstanceDigest(
          input.fsqResource.rootPath,
        ),
        readerBindingDigest: computeJsonFileSnapshotReaderBindingDigest(input.fsqResource),
        cursorSchema: null,
        contractName: input.fsqResource.contract.name,
        contractVersion: input.fsqResource.contract.version,
        contractDigest: input.fsqResource.contract.digest,
      },
    },
    {
      stageId: CANONICAL_SOURCE_STAGE_ID,
      sourceAdapter: POSTGRES_READONLY_ADAPTER,
      policyId: CANONICAL_POLICY_ID,
      effectClass: "network.read" as const,
      resourceUri: input.canonicalResource.resourceUri,
      operations: [input.canonicalResource.operation],
      partitions: [...input.canonicalResource.partitions],
      maxRecords: canonicalMaxRecords,
      snapshot: {
        consistency: "repeatable_read" as const,
        sourceInstanceDigest: computePostgresSourceInstanceDigest(
          input.canonicalResource.databaseInstanceId,
        ),
        readerBindingDigest: computePostgresSnapshotReaderBindingDigest(
          input.canonicalResource,
        ),
        cursorSchema: { ...input.canonicalResource.contract.cursorSchema },
        contractName: input.canonicalResource.contract.name,
        contractVersion: input.canonicalResource.contract.version,
        contractDigest: input.canonicalResource.contract.digest,
      },
    },
  ]);
}
