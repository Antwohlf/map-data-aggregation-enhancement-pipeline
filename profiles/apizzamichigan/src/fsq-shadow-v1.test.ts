import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  JSON_FILE_SNAPSHOT_ADAPTER,
  JsonFileSnapshotResourceReader,
  type JsonFileSnapshotResource,
} from "@map-pipeline/adapter-files";
import {
  POSTGRES_READONLY_ADAPTER,
  computePostgresSnapshotReaderBindingDigest,
  computePostgresSourceInstanceDigest,
  type PostgresSnapshotResource,
} from "@map-pipeline/adapter-postgres";
import { FilesystemJsonArtifactStore } from "@map-pipeline/artifacts-filesystem";
import {
  digest,
  validateDefinition,
  type CanonicalJson,
  type ResourceReader,
} from "@map-pipeline/core";
import { ReadOnlyShadowExecutor } from "@map-pipeline/executor";
import { definePlugin } from "@map-pipeline/sdk";
import { SqliteRunStateStore } from "@map-pipeline/state-sqlite";

import {
  APIZZA_CANONICAL_SHADOW_SOURCE_URI,
  APIZZA_FSQ_SHADOW_SOURCE_URI,
  apizzaFsqShadowV1Catalog,
  apizzaFsqShadowV1HostPolicy,
  apizzaFsqShadowV1Plugins,
  apizzaFsqShadowV1SchemaValidators,
  createApizzaFsqShadowV1Definition,
  createApizzaFsqShadowV1ReadGrants,
} from "./fsq-shadow-v1.js";
import { validateApizzaFsqReleaseRowsV1 } from "./fsq-release-v1.js";
import {
  apizzaMatchingV1Manifest,
  matchApizzaCandidatesV1,
} from "./matching-v1.js";

const TEST_POLICY_ASSERTION_DIGEST = `sha256:${"9".repeat(64)}`;
const FSQ_CONTRACT_DIGEST = `sha256:${"a".repeat(64)}`;
const CANONICAL_CONTRACT_DIGEST = `sha256:${"b".repeat(64)}`;
const VIEW_DEFINITION = [
  "SELECT id::text AS canonical_place_id, name::text AS name,",
  "address::text AS address, state::text AS state,",
  "google_place_id::text AS google_place_id, website_url::text AS website_url,",
  "phone::text AS phone, lat::double precision AS lat, lng::double precision AS lng",
  "FROM public.pizza_places",
].join(" ");

function fsqRows(rawOnlySentinel = "raw-only-sentinel"): CanonicalJson {
  return [
    {
      fsq_place_id: "test-fsq-1",
      name: "Test Detroit Pizza",
      latitude: 42.3314,
      longitude: -83.0458,
      address: "100 Test Avenue",
      locality: "Detroit",
      region: "MI",
      postcode: "48226",
      country: "US",
      tel: "+1 313 555 0100",
      website: "https://pizza.test.example",
      fsq_category_ids: ["13064"],
      fsq_category_labels: ["Pizzeria"],
      date_closed: null,
      unresolved_flags: [rawOnlySentinel],
    },
    {
      fsq_place_id: "test-fsq-2",
      name: "Closed Test Pizza",
      latitude: 42.34,
      longitude: -83.05,
      address: null,
      locality: "Detroit",
      region: "MI",
      postcode: null,
      country: "US",
      tel: null,
      website: null,
      fsq_category_ids: ["13064"],
      fsq_category_labels: ["Pizza Place"],
      date_closed: "2026-08-01",
      unresolved_flags: [],
    },
  ];
}

function canonicalResource(): PostgresSnapshotResource {
  return {
    resourceUri: APIZZA_CANONICAL_SHADOW_SOURCE_URI,
    operation: "snapshot",
    partitions: ["US"],
    databaseName: "pizza_enrichment",
    databaseRole: "map_pipeline_apizza_shadow_reader",
    databaseContractOwner: "map_pipeline_contract_owner",
    databaseInstanceId: "018f4c5e-7a6b-7def-8abc-1234567890ab",
    databaseIdentityRelation: { schema: "pipeline_control", name: "database_identity" },
    schema: { name: "apizza.canonical-match-snapshot", version: 1 },
    contract: {
      name: "apizza-canonical-match",
      version: 1,
      digest: CANONICAL_CONTRACT_DIGEST,
      viewDefinitionDigest: digest({ viewDefinition: VIEW_DEFINITION }),
      cursorSchema: { name: "apizza.canonical-place-id-cursor", version: 1 },
    },
    relation: { schema: "pipeline_input", name: "apizza_canonical_match_v1" },
    columns: [
      "canonical_place_id",
      "name",
      "address",
      "state",
      "google_place_id",
      "website_url",
      "phone",
      "lat",
      "lng",
    ],
    columnTypes: {
      canonical_place_id: "text",
      name: "text",
      address: "text",
      state: "text",
      google_place_id: "text",
      website_url: "text",
      phone: "text",
      lat: "double precision",
      lng: "double precision",
    },
    columnNullability: {
      canonical_place_id: false,
      name: true,
      address: true,
      state: true,
      google_place_id: true,
      website_url: true,
      phone: true,
      lat: false,
      lng: false,
    },
    orderBy: ["canonical_place_id"],
  };
}

function canonicalReader(resource: PostgresSnapshotResource): ResourceReader {
  return {
    async read(input) {
      assert.equal(input.resourceUri, resource.resourceUri);
      assert.equal(input.operation, "snapshot");
      assert.equal(input.partition, "US");
      return {
        value: {
          version: 1,
          rows: [
            {
              canonical_place_id: "canonical-1",
              name: "Test Detroit Pizza",
              address: "100 Test Avenue",
              state: "MI",
              google_place_id: null,
              website_url: "https://pizza.test.example",
              phone: "+1 313 555 0100",
              lat: 42.3314,
              lng: -83.0458,
            },
            {
              canonical_place_id: "canonical-2",
              name: "Closed Test Pizza",
              address: null,
              state: "MI",
              google_place_id: null,
              website_url: null,
              phone: null,
              lat: 42.34,
              lng: -83.05,
            },
          ],
        },
        observedChildIds: [],
        schema: { ...resource.schema },
        snapshot: {
          snapshotId: "100:200:",
          sourceInstanceDigest: computePostgresSourceInstanceDigest(resource.databaseInstanceId),
          readerBindingDigest: computePostgresSnapshotReaderBindingDigest(resource),
          capturedAt: "2026-09-06T12:00:00.000Z",
          consistency: "repeatable_read",
          cursorSchema: { ...resource.contract.cursorSchema },
          startExclusive: null,
          endInclusive: ["canonical-2"],
          complete: true,
          contractName: resource.contract.name,
          contractVersion: resource.contract.version,
          contractDigest: resource.contract.digest,
        },
      };
    },
  };
}

async function retainedContents(root: string): Promise<string> {
  const paths = await readdir(root, { recursive: true });
  const chunks: string[] = [];
  for (const relativePath of paths) {
    const path = join(root, relativePath);
    try {
      chunks.push((await readFile(path)).toString("utf8"));
    } catch {
      // Directory or concurrently absent staging entry.
    }
  }
  return chunks.join("\n");
}

test("runs the complete two-source shadow without retaining raw FSQ rows", async () => {
  const inputRoot = await mkdtemp(join(tmpdir(), "apizza-fsq-shadow-input-"));
  const runtimeRoot = await mkdtemp(join(tmpdir(), "apizza-fsq-shadow-runtime-"));
  const rawOnlySentinel = "raw-only-sentinel-never-retained";
  const rows = fsqRows(rawOnlySentinel);
  const bytes = JSON.stringify(rows);
  const contentDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const fsqResource: JsonFileSnapshotResource = {
    resourceUri: APIZZA_FSQ_SHADOW_SOURCE_URI,
    operation: "snapshot",
    partitions: ["US"],
    rootPath: inputRoot,
    relativePath: "fsq-release.json",
    schema: { name: "apizza.fsq-release-rows", version: 1 },
    contract: {
      name: "apizza-fsq-release-rows",
      version: 1,
      digest: FSQ_CONTRACT_DIGEST,
    },
    expectedContentDigest: contentDigest,
    childIds: ["release:synthetic-test-only"],
  };
  const canonical = canonicalResource();
  const definition = createApizzaFsqShadowV1Definition({
    evaluationTime: "2026-09-06T00:00:00.000Z",
    fallbackRetrievedAt: "2026-09-06T00:00:00.000Z",
    sourceLicense: "synthetic-test-only",
    sourceAttribution: "Synthetic test data; no Foursquare records included",
    sourcePolicyAssertionDigest: TEST_POLICY_ASSERTION_DIGEST,
    sourceTermsRef: "https://example.test/synthetic-source-terms",
    fsqChildIds: fsqResource.childIds,
  });
  const sourceReadGrants = createApizzaFsqShadowV1ReadGrants({
    definition,
    fsqResource,
    canonicalResource: canonical,
  });
  const expectedRuntimePolicyDigest = digest({
    kind: "read_only_shadow",
    deploymentIdentity: "test-apizza-fsq-shadow",
    allowedPartitions: ["US"],
    sourceReadGrants: sourceReadGrants.map((grant) => ({
      ...grant,
      operations: [...grant.operations],
    })),
    definition,
    catalog: apizzaFsqShadowV1Catalog,
    hostPolicy: apizzaFsqShadowV1HostPolicy,
  } as unknown as CanonicalJson);
  const state = new SqliteRunStateStore(join(runtimeRoot, "state.sqlite"));
  try {
    await writeFile(join(inputRoot, fsqResource.relativePath), bytes);
    assert.deepEqual(validateDefinition(definition, apizzaFsqShadowV1Catalog), []);
    const executor = new ReadOnlyShadowExecutor({
      definition,
      catalog: apizzaFsqShadowV1Catalog,
      plugins: apizzaFsqShadowV1Plugins,
      readers: {
        [JSON_FILE_SNAPSHOT_ADAPTER]: new JsonFileSnapshotResourceReader({
          resources: [fsqResource],
        }),
        [POSTGRES_READONLY_ADAPTER]: canonicalReader(canonical),
      },
      schemaValidators: apizzaFsqShadowV1SchemaValidators,
      artifactStore: new FilesystemJsonArtifactStore(join(runtimeRoot, "artifacts")),
      stateStore: state,
      hostPolicy: apizzaFsqShadowV1HostPolicy,
      observedFreeDiskBytes: async () => 10_000_000_000,
      deploymentIdentity: "test-apizza-fsq-shadow",
      allowedPartitions: ["US"],
      sourceReadGrants,
      now: () => new Date("2026-09-06T12:00:00.000Z"),
    });
    const result = await executor.run({ partition: "US", runId: "complete-shadow-test" });

    assert.equal(result.status, "succeeded");
    assert.equal(result.runtimeClass, "read_only_shadow");
    assert.deepEqual(result.stages.map((stage) => stage.stageId), [
      "fsq-source",
      "normalize",
      "canonical-source",
      "match",
      "verify",
    ]);
    assert.deepEqual(result.stages[0]!.outputs.rows, {
      brokerHandle: result.stages[0]!.outputs.rows!.brokerHandle,
      recordCount: 2,
    });
    assert.match(result.stages[0]!.outputs.rows!.brokerHandle, /^ephemeral:/);
    const objectFiles = await readdir(join(runtimeRoot, "artifacts", "objects"));
    const manifestFiles = await readdir(join(runtimeRoot, "artifacts", "manifests"));
    assert.equal(objectFiles.length, 5);
    assert.equal(manifestFiles.length, 5);

    const retained = await retainedContents(runtimeRoot);
    assert.equal(retained.includes(rawOnlySentinel), false);
    assert.equal(retained.includes('"unresolved_flags"'), false);

    const candidateManifestDigest = result.stages[1]!.outputs.candidates!.manifestDigest!;
    const candidateManifest = JSON.parse(await readFile(join(
      runtimeRoot,
      "artifacts",
      "manifests",
      `${candidateManifestDigest.slice("sha256:".length)}.json`,
    ), "utf8")) as {
      provenance: {
        sourceProvenance: Array<{
          producingStageId: string;
          runtimePolicyDigest: string;
          snapshot: { snapshotId: string };
        }>;
      };
    };
    assert.deepEqual(
      candidateManifest.provenance.sourceProvenance.map((source) => source.producingStageId),
      ["fsq-source"],
    );
    assert.equal(
      candidateManifest.provenance.sourceProvenance[0]!.runtimePolicyDigest,
      expectedRuntimePolicyDigest,
    );
    assert.equal(candidateManifest.provenance.sourceProvenance[0]!.snapshot.snapshotId, contentDigest);

    const matchReportUri = result.stages[3]!.outputs.report!.uri;
    assert.ok(matchReportUri);
    const matchReport = JSON.parse(await readFile(new URL(matchReportUri), "utf8")) as {
      active_candidates_compared: number;
      closed_candidates_compared: number;
      closed_signals_matched: number;
    };
    assert.equal(matchReport.active_candidates_compared, 1);
    assert.equal(matchReport.closed_candidates_compared, 1);
    assert.equal(matchReport.closed_signals_matched, 1);

    const matchManifestDigest = result.stages[3]!.outputs.decisions!.manifestDigest!;
    const matchManifest = JSON.parse(await readFile(join(
      runtimeRoot,
      "artifacts",
      "manifests",
      `${matchManifestDigest.slice("sha256:".length)}.json`,
    ), "utf8")) as {
      provenance: { sourceProvenance: Array<{ producingStageId: string }> };
    };
    assert.deepEqual(
      matchManifest.provenance.sourceProvenance
        .map((source) => source.producingStageId)
        .sort(),
      ["canonical-source", "fsq-source"],
    );
  } finally {
    state.close();
    await rm(inputRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("rejects undeclared FSQ fields before any raw artifact is written", async () => {
  const inputRoot = await mkdtemp(join(tmpdir(), "apizza-fsq-shadow-invalid-input-"));
  const runtimeRoot = await mkdtemp(join(tmpdir(), "apizza-fsq-shadow-invalid-runtime-"));
  const secret = "private-email-never-persisted@example.test";
  const invalidRows = [{ ...(fsqRows() as Array<Record<string, CanonicalJson>>)[0]!, private_email: secret }];
  const bytes = JSON.stringify(invalidRows);
  const fsqResource: JsonFileSnapshotResource = {
    resourceUri: APIZZA_FSQ_SHADOW_SOURCE_URI,
    operation: "snapshot",
    partitions: ["US"],
    rootPath: inputRoot,
    relativePath: "fsq-release.json",
    schema: { name: "apizza.fsq-release-rows", version: 1 },
    contract: { name: "apizza-fsq-release-rows", version: 1, digest: FSQ_CONTRACT_DIGEST },
    expectedContentDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    childIds: ["release:synthetic-invalid-test"],
  };
  const canonical = canonicalResource();
  const definition = createApizzaFsqShadowV1Definition({
    evaluationTime: "2026-09-06T00:00:00.000Z",
    fallbackRetrievedAt: "2026-09-06T00:00:00.000Z",
    sourceLicense: "synthetic-test-only",
    sourceAttribution: "Synthetic test data; no Foursquare records included",
    sourcePolicyAssertionDigest: TEST_POLICY_ASSERTION_DIGEST,
    sourceTermsRef: "https://example.test/synthetic-source-terms",
    fsqChildIds: fsqResource.childIds,
  });
  const state = new SqliteRunStateStore(join(runtimeRoot, "state.sqlite"));
  try {
    await writeFile(join(inputRoot, fsqResource.relativePath), bytes);
    const executor = new ReadOnlyShadowExecutor({
      definition,
      catalog: apizzaFsqShadowV1Catalog,
      plugins: apizzaFsqShadowV1Plugins,
      readers: {
        [JSON_FILE_SNAPSHOT_ADAPTER]: new JsonFileSnapshotResourceReader({ resources: [fsqResource] }),
        [POSTGRES_READONLY_ADAPTER]: canonicalReader(canonical),
      },
      schemaValidators: apizzaFsqShadowV1SchemaValidators,
      artifactStore: new FilesystemJsonArtifactStore(join(runtimeRoot, "artifacts")),
      stateStore: state,
      hostPolicy: apizzaFsqShadowV1HostPolicy,
      observedFreeDiskBytes: async () => 10_000_000_000,
      deploymentIdentity: "test-apizza-fsq-shadow-invalid",
      allowedPartitions: ["US"],
      sourceReadGrants: createApizzaFsqShadowV1ReadGrants({
        definition,
        fsqResource,
        canonicalResource: canonical,
      }),
    });
    await assert.rejects(
      () => executor.run({ partition: "US", runId: "invalid-shadow-test" }),
      /bounded v1 projection/,
    );
    assert.deepEqual(await readdir(join(runtimeRoot, "artifacts", "objects")), []);
    assert.deepEqual(await readdir(join(runtimeRoot, "artifacts", "manifests")), []);
    assert.equal((await retainedContents(runtimeRoot)).includes(secret), false);
  } finally {
    state.close();
    await rm(inputRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("the terminal verifier rejects schema-valid matcher semantic tampering", async () => {
  const inputRoot = await mkdtemp(join(tmpdir(), "apizza-fsq-shadow-tamper-input-"));
  const runtimeRoot = await mkdtemp(join(tmpdir(), "apizza-fsq-shadow-tamper-runtime-"));
  const rows = fsqRows();
  const bytes = JSON.stringify(rows);
  const fsqResource: JsonFileSnapshotResource = {
    resourceUri: APIZZA_FSQ_SHADOW_SOURCE_URI,
    operation: "snapshot",
    partitions: ["US"],
    rootPath: inputRoot,
    relativePath: "fsq-release.json",
    schema: { name: "apizza.fsq-release-rows", version: 1 },
    contract: { name: "apizza-fsq-release-rows", version: 1, digest: FSQ_CONTRACT_DIGEST },
    expectedContentDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    childIds: ["release:synthetic-tamper-test"],
  };
  const canonical = canonicalResource();
  const definition = createApizzaFsqShadowV1Definition({
    evaluationTime: "2026-09-06T00:00:00.000Z",
    fallbackRetrievedAt: "2026-09-06T00:00:00.000Z",
    sourceLicense: "synthetic-test-only",
    sourceAttribution: "Synthetic test data; no Foursquare records included",
    sourcePolicyAssertionDigest: TEST_POLICY_ASSERTION_DIGEST,
    sourceTermsRef: "https://example.test/synthetic-source-terms",
    fsqChildIds: fsqResource.childIds,
  });
  const tamperingMatcher = definePlugin({
    manifest: apizzaMatchingV1Manifest,
    async run(context, inputs, config) {
      const candidates = await context.broker.readDatasetJson(inputs.candidates!);
      const snapshot = await context.broker.readDatasetJson(inputs.canonical!);
      const result = matchApizzaCandidatesV1(
        candidates as never,
        snapshot as never,
        { partition: context.partition, config: config as never },
      );
      const decisions = structuredClone(result.decisions);
      const report = structuredClone(result.report);
      const first = decisions[0]!;
      assert.ok(first.best_match);
      assert.ok(first.nearest_place);
      first.best_match = {
        canonical_place_id: "canonical-2",
        name: "Closed Test Pizza",
        google_place_id: null,
        distance_m: 50,
        name_score: 0.6,
        identifier_match: { website: false, phone: false, exact: false },
        match_method: "strong_spatial_name",
      };
      first.nearest_place = {
        canonical_place_id: "canonical-2",
        name: "Closed Test Pizza",
        google_place_id: null,
        distance_m: 40,
        name_score: 0.6,
      };
      const stagedDecisions = await context.broker.stageDerivedJson({
        outputPort: "decisions",
        value: decisions as unknown as CanonicalJson,
      });
      const decisionOutput = await context.broker.finalizeDerivedArtifact({
        stagedArtifact: stagedDecisions,
        outputPort: "decisions",
      });
      const stagedReport = await context.broker.stageDerivedJson({
        outputPort: "report",
        value: report as unknown as CanonicalJson,
      });
      const reportOutput = await context.broker.finalizeDerivedArtifact({
        stagedArtifact: stagedReport,
        outputPort: "report",
      });
      return {
        outputs: { decisions: decisionOutput, report: reportOutput },
        metrics: { tampered: 1 },
      };
    },
  });
  const state = new SqliteRunStateStore(join(runtimeRoot, "state.sqlite"));
  try {
    await writeFile(join(inputRoot, fsqResource.relativePath), bytes);
    const executor = new ReadOnlyShadowExecutor({
      definition,
      catalog: apizzaFsqShadowV1Catalog,
      plugins: {
        ...apizzaFsqShadowV1Plugins,
        [apizzaMatchingV1Manifest.id]: tamperingMatcher,
      },
      readers: {
        [JSON_FILE_SNAPSHOT_ADAPTER]: new JsonFileSnapshotResourceReader({
          resources: [fsqResource],
        }),
        [POSTGRES_READONLY_ADAPTER]: canonicalReader(canonical),
      },
      schemaValidators: apizzaFsqShadowV1SchemaValidators,
      artifactStore: new FilesystemJsonArtifactStore(join(runtimeRoot, "artifacts")),
      stateStore: state,
      hostPolicy: apizzaFsqShadowV1HostPolicy,
      observedFreeDiskBytes: async () => 10_000_000_000,
      deploymentIdentity: "test-apizza-fsq-shadow-tamper",
      allowedPartitions: ["US"],
      sourceReadGrants: createApizzaFsqShadowV1ReadGrants({
        definition,
        fsqResource,
        canonicalResource: canonical,
      }),
    });
    await assert.rejects(
      () => executor.run({ partition: "US", runId: "tampered-shadow-test" }),
      /shadow inputs do not reconcile/,
    );
  } finally {
    state.close();
    await rm(inputRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("the shadow definition has no product, review, evidence, or state writer", () => {
  const definition = createApizzaFsqShadowV1Definition({
    evaluationTime: "2026-09-06T00:00:00.000Z",
    fallbackRetrievedAt: "2026-09-06T00:00:00.000Z",
    sourceLicense: "synthetic-test-only",
    sourceAttribution: "Synthetic test data; no Foursquare records included",
    sourcePolicyAssertionDigest: TEST_POLICY_ASSERTION_DIGEST,
    sourceTermsRef: "https://example.test/synthetic-source-terms",
    fsqChildIds: ["release:synthetic-test-only"],
  });
  const effects = definition.stages.flatMap((stage) => stage.requestedEffects ?? []);
  assert.equal(
    effects.some((effect) => [
      "canonical.write",
      "public.write",
      "review.write",
      "evidence.write",
      "state.write",
    ].includes(effect.effectClass)),
    false,
  );
  assert.equal(
    effects.filter((effect) => effect.effectClass === "artifact.write")
      .every((effect) => effect.resourceUri.startsWith("preview://")),
    true,
  );
  assert.equal(
    apizzaFsqShadowV1Catalog["apizza-fsq-ephemeral-source-v1"]!
      .outputs.rows!.artifactPolicy,
    "forbidden",
  );
});

test("the shadow definition rejects non-canonical or credential-bearing terms URLs", () => {
  const base = {
    evaluationTime: "2026-09-06T00:00:00.000Z",
    fallbackRetrievedAt: "2026-09-06T00:00:00.000Z",
    sourceLicense: "synthetic-test-only",
    sourceAttribution: "Synthetic test data; no Foursquare records included",
    sourcePolicyAssertionDigest: TEST_POLICY_ASSERTION_DIGEST,
    fsqChildIds: ["release:synthetic-test-only"],
  } as const;
  for (const sourceTermsRef of [
    "http://example.test/terms",
    "https://user@example.test/terms",
    "https://example.test:8443/terms",
    "https://example.test/terms?token=secret",
    "https://example.test/terms#fragment",
  ]) {
    assert.throws(
      () => createApizzaFsqShadowV1Definition({ ...base, sourceTermsRef }),
      /canonical HTTPS source terms URL/,
    );
  }
});

test("the FSQ release projection rejects unsafe shapes and geographic values", () => {
  const valid = structuredClone(fsqRows()) as Array<Record<string, CanonicalJson>>;
  assert.doesNotThrow(() => validateApizzaFsqReleaseRowsV1(valid));
  for (const [label, mutate] of [
    ["unknown field", (row: Record<string, CanonicalJson>) => { row.email = "private@example.test"; }],
    ["latitude", (row: Record<string, CanonicalJson>) => { row.latitude = 90.0001; }],
    ["longitude", (row: Record<string, CanonicalJson>) => { row.longitude = -180.0001; }],
    ["date", (row: Record<string, CanonicalJson>) => { row.date_closed = "09/06/2026"; }],
    ["category shape", (row: Record<string, CanonicalJson>) => { row.fsq_category_ids = [1]; }],
    ["oversized text", (row: Record<string, CanonicalJson>) => { row.name = "x".repeat(1_025); }],
    ["private venue", (row: Record<string, CanonicalJson>) => {
      row.unresolved_flags = ["privatevenue"];
    }],
    ["removal", (row: Record<string, CanonicalJson>) => {
      row.unresolved_flags = ["doesn't exist"];
    }],
  ] as const) {
    const invalid = structuredClone(valid);
    mutate(invalid[0]!);
    assert.throws(
      () => validateApizzaFsqReleaseRowsV1(invalid),
      /bounded v1 projection/,
      label,
    );
  }
});
