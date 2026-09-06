import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { FixtureJsonResourceReader } from "@map-pipeline/adapter-files";
import { FilesystemJsonArtifactStore } from "@map-pipeline/artifacts-filesystem";
import {
  type CanonicalJson,
  type DatasetHandle,
  type DatasetRef,
  digest,
  type JsonArtifactStore,
  type PipelineDefinition,
  type ResourceReader,
  type StagePluginManifest,
} from "@map-pipeline/core";
import { PreviewExecutionError, PreviewExecutor } from "@map-pipeline/executor";
import type { StagePlugin } from "@map-pipeline/sdk";
import { SqliteRunStateStore } from "@map-pipeline/state-sqlite";

import {
  apizzaFsqPreviewCatalog,
  apizzaFsqPreviewDefinition,
  apizzaFsqPreviewPlugins,
  apizzaFsqPreviewSchemaValidators,
  apizzaPreviewHostPolicy,
  normalizeSyntheticFsqDocument,
} from "./fsq-preview.js";

test("the mixed-state preview CLI rejects misleading partitions", () => {
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const result = spawnSync(process.execPath, [
    resolve(repositoryRoot, "node_modules/tsx/dist/cli.mjs"),
    resolve(repositoryRoot, "profiles/apizzamichigan/src/run-fsq-preview.ts"),
    "--partition",
    "MI",
  ], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /mixed-state synthetic fixture must use partition US/);
});

test("the exported APizza definition rejects a non-US partition", async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "map-pipeline-preview-partition-"));
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const state = new SqliteRunStateStore(join(runtimeRoot, "state.sqlite"));
  try {
    const executor = new PreviewExecutor({
      definition: apizzaFsqPreviewDefinition,
      catalog: apizzaFsqPreviewCatalog,
      plugins: apizzaFsqPreviewPlugins,
      readers: {
        files: new FixtureJsonResourceReader({
          fixturesRoot: resolve(repositoryRoot, "fixtures"),
          manifestPath: resolve(repositoryRoot, "fixtures", "manifest.json"),
        }),
      },
      artifactStore: new FilesystemJsonArtifactStore(join(runtimeRoot, "objects")),
      stateStore: state,
      schemaValidators: apizzaFsqPreviewSchemaValidators,
      hostPolicy: apizzaPreviewHostPolicy,
      observedFreeDiskBytes: async () => 10_000_000_000,
    });
    await assert.rejects(
      () => executor.run({ partition: "MI", runId: "partition-bypass" }),
      /not allowed by this pipeline definition/,
    );
    assert.equal(state.getRun("partition-bypass"), null);
  } finally {
    state.close();
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("normalizes the synthetic FSQ fixture with stable profile-scoped identities", () => {
  const document = {
    fixtureId: "test",
    license: "CC0-1.0",
    synthetic: true,
    rows: [{
      fsq_place_id: "example-1",
      name: "Example Pizza",
      latitude: 42.3,
      longitude: -83,
      region: "MI",
      categories: ["Pizzeria"],
      retrieved_at: "2026-09-06T00:00:00.000Z",
    }],
  };
  const context = {
    runId: "run-fixture",
    stageId: "normalize",
    partition: "MI",
    pluginVersion: "0.0.0-preview",
    evaluationTime: "2026-09-06T00:00:00.000Z",
  };
  const first = normalizeSyntheticFsqDocument(document, context);
  const second = normalizeSyntheticFsqDocument(document, context);
  assert.deepEqual(first, second);
  assert.equal(first[0]?.payload.route, "ready_for_match");
  assert.equal(first[0]?.payload.source_label, "Foursquare OS Places");
  assert.equal(first[0]?.payload.confidence, 0);
  assert.equal(first[0]?.payload.is_closed, false);
  assert.match(first[0]?.sourceRecordKey ?? "", /^srk_[a-f0-9]{64}$/);
  assert.match(first[0]?.observationId ?? "", /^obs_[a-f0-9]{64}$/);
});

test("identity fallback ignores observation time while observation identity does not", () => {
  const row = {
    name: "Identifier-Free Pizza",
    latitude: 42.3314,
    longitude: -83.0458,
    address: "100 Example Avenue",
    locality: "Detroit",
    region: "MI",
    categories: ["Pizza"],
    retrieved_at: "2026-09-06T00:00:00.000Z",
  };
  const context = {
    runId: "fallback-run",
    stageId: "normalize",
    partition: "US",
    pluginVersion: "0.0.0-preview",
    evaluationTime: "2026-09-06T00:00:00.000Z",
  };
  const [first] = normalizeSyntheticFsqDocument({
    fixtureId: "fallback",
    license: "CC0-1.0",
    synthetic: true,
    rows: [row],
  }, context);
  const [later] = normalizeSyntheticFsqDocument({
    fixtureId: "fallback",
    license: "CC0-1.0",
    synthetic: true,
    rows: [{ ...row, retrieved_at: "2026-09-07T00:00:00.000Z" }],
  }, context);
  assert.equal(first?.sourceRecordKey, later?.sourceRecordKey);
  assert.notEqual(first?.observationId, later?.observationId);
});

test("closed-date routing uses the definition-pinned evaluation time", () => {
  const document = {
    fixtureId: "future-close",
    license: "CC0-1.0",
    synthetic: true,
    rows: [{
      fsq_place_id: "future-close",
      name: "Future Close Pizza",
      latitude: 42.3314,
      longitude: -83.0458,
      region: "MI",
      categories: ["Pizza"],
      date_closed: "2027-01-01T00:00:00.000Z",
    }],
  };
  const base = {
    runId: "future-close-run",
    stageId: "normalize",
    partition: "US",
    pluginVersion: "0.0.0-preview",
  };
  const [before] = normalizeSyntheticFsqDocument(document, {
    ...base,
    evaluationTime: "2026-12-31T23:59:59.000Z",
  });
  const [after] = normalizeSyntheticFsqDocument(document, {
    ...base,
    evaluationTime: "2027-01-01T00:00:00.000Z",
  });
  assert.equal(before?.payload.route, "ready_for_match");
  assert.equal(after?.payload.route, "closed_evidence_candidate");
  assert.equal(before?.observationId, after?.observationId);
});

test("canonical candidate order is stable for duplicate source IDs", () => {
  const rows = [
    {
      fsq_place_id: "duplicate",
      name: "Duplicate Pizza",
      latitude: 42.3314,
      longitude: -83.0458,
      region: "MI",
      categories: ["Pizza"],
      retrieved_at: "2026-09-06T00:00:00.000Z",
    },
    {
      fsq_place_id: "duplicate",
      name: "Duplicate Pizza Updated",
      latitude: 42.3314,
      longitude: -83.0458,
      region: "MI",
      categories: ["Pizza"],
      retrieved_at: "2026-09-07T00:00:00.000Z",
    },
  ];
  const context = {
    runId: "duplicate-run",
    stageId: "normalize",
    partition: "US",
    pluginVersion: "0.0.0-preview",
    evaluationTime: "2026-09-07T00:00:00.000Z",
  };
  const forward = normalizeSyntheticFsqDocument({
    fixtureId: "duplicates",
    license: "CC0-1.0",
    synthetic: true,
    rows,
  }, context);
  const reverse = normalizeSyntheticFsqDocument({
    fixtureId: "duplicates",
    license: "CC0-1.0",
    synthetic: true,
    rows: [...rows].reverse(),
  }, context);
  assert.deepEqual(forward, reverse);
  assert.equal(
    digest(forward as unknown as CanonicalJson),
    digest(reverse as unknown as CanonicalJson),
  );
});

test("preserves the legacy FSQ normalization field contract before matching", () => {
  const document = {
    fixtureId: "legacy-field-contract",
    license: "CC0-1.0",
    synthetic: true,
    rows: [
      {
        fsq_id: "legacy-shaped-1",
        name: "Legacy Shaped Pizza",
        lat: 42.3314,
        lon: -83.0458,
        address: "100 Example Avenue",
        city: "Detroit",
        state: "MI",
        postcode: "48226",
        country: "US",
        category_name: "Pizzeria",
        website: "https://legacy.example",
        tel: "+1 313 555 0100",
        date_closed: null,
        retrieved_at: "2026-09-06T00:00:00.000Z",
      },
    ],
  };
  const [candidate] = normalizeSyntheticFsqDocument(document, {
    runId: "legacy-contract-run",
    stageId: "normalize",
    partition: "MI",
    pluginVersion: "0.0.0-preview",
    evaluationTime: "2026-09-06T00:00:00.000Z",
  });
  assert.deepEqual(candidate?.payload, {
    source: "fsq_os_places",
    source_label: "Foursquare OS Places",
    source_id: "legacy-shaped-1",
    name: "Legacy Shaped Pizza",
    lat: 42.3314,
    lng: -83.0458,
    address: "100 Example Avenue",
    locality: "Detroit",
    region: "MI",
    postcode: "48226",
    country: "US",
    website: "https://legacy.example",
    phone: "+1 313 555 0100",
    source_url: "https://legacy.example",
    confidence: 0,
    is_closed: false,
    categories: ["Pizzeria"],
    spider: null,
    route: "ready_for_match",
  });
});

test("pins legacy pre-match eligibility edge cases and raw observation identity", () => {
  const base = {
    fsq_place_id: "edge",
    name: "Generic Example",
    latitude: 42.3314,
    longitude: -83.0458,
    region: "MI",
    retrieved_at: "2026-09-06T00:00:00.000Z",
  };
  const rows = [
    { ...base, fsq_place_id: "missing-name", name: "", categories: ["Pizzeria"] },
    { ...base, fsq_place_id: "missing-coordinates", latitude: null, longitude: null, categories: ["Pizzeria"] },
    { ...base, fsq_place_id: "closed", name: "Closed Pizzeria", categories: ["Pizzeria"], date_closed: "2025-01-01" },
    { ...base, fsq_place_id: "website-term", website: "https://wood-fired.example" },
    { ...base, fsq_place_id: "category-term", categories: ["Italian Restaurant"] },
    {
      name: "Identifier-Free Pizza",
      latitude: 42.3314,
      longitude: -83.0458,
      region: "MI",
      categories: ["Pizza"],
      retrieved_at: "2026-09-06T00:00:00.000Z",
    },
  ];
  const context = {
    runId: "edge-run",
    stageId: "normalize",
    partition: "US",
    pluginVersion: "0.0.0-preview",
    evaluationTime: "2026-09-06T00:00:00.000Z",
  };
  const candidates = normalizeSyntheticFsqDocument({
    fixtureId: "edge-cases",
    license: "CC0-1.0",
    synthetic: true,
    rows,
  }, context);
  const byId = new Map(candidates.map((candidate) => [candidate.payload.source_id, candidate]));
  assert.equal(byId.get("missing-name")?.payload.route, "excluded_unusable");
  assert.equal(byId.get("missing-coordinates")?.payload.route, "excluded_out_of_scope");
  assert.equal(byId.get("closed")?.payload.route, "closed_evidence_candidate");
  assert.equal(
    candidates.find((candidate) => candidate.payload.name === "Identifier-Free Pizza")?.payload.route,
    "ready_for_match",
  );
  assert.equal(
    candidates.find((candidate) => candidate.payload.source_id === "website-term")?.payload.route,
    "ready_for_match",
  );
  assert.equal(
    candidates.find((candidate) => candidate.payload.source_id === "category-term")?.payload.route,
    "ready_for_match",
  );

  const mapperOnlyChange = normalizeSyntheticFsqDocument({
    fixtureId: "edge-cases",
    license: "CC0-1.0",
    synthetic: true,
    rows,
  }, { ...context, pluginVersion: "different-mapper-version" });
  assert.deepEqual(
    candidates.map((candidate) => candidate.observationId),
    mapperOnlyChange.map((candidate) => candidate.observationId),
  );
});

test("pins the complete synthetic fixture normalization as a golden digest", async () => {
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const document = JSON.parse(
    await readFile(resolve(repositoryRoot, "fixtures/synthetic/apizza-fsq-records.json"), "utf8"),
  );
  const candidates = normalizeSyntheticFsqDocument(document, {
    runId: "golden-run",
    stageId: "normalize",
    partition: "US",
    pluginVersion: "0.0.0-preview",
    evaluationTime: "2026-09-06T00:00:00.000Z",
  });
  assert.equal(
    digest(candidates as unknown as CanonicalJson),
    "sha256:9a7e462464b88cbd9fb216b95a73843f89adea827a6e628ffcc2eb20c26e4a92",
  );
  assert.deepEqual(candidates.map((candidate) => ({
    sourceId: candidate.payload.source_id,
    sourceRecordKey: candidate.sourceRecordKey,
    observationId: candidate.observationId,
    route: candidate.payload.route,
  })), [
    {
      sourceId: "synthetic-fsq-pizza-1",
      sourceRecordKey: "srk_2b9b81c33a21f4c9e380e8ac8f00c1aaf0fe42df251a9f9a1d0ec0b8ddb4c826",
      observationId: "obs_ff199c5d09843ec3b429a3ab55e79012dd27cd0db1a80fd0ba205b5162a8b5eb",
      route: "ready_for_match",
    },
    {
      sourceId: null,
      sourceRecordKey: "srk_7f1586173f3b686c505d2f5058af30b83169f9d2ca94f8f3efca62a32510bff4",
      observationId: "obs_53b66f79d2073879f76c0425deec4566526cd657c980b60918aab7931109001f",
      route: "ready_for_match",
    },
    {
      sourceId: "synthetic-fsq-cafe-1",
      sourceRecordKey: "srk_83b1c33236a304f6995ebbcc33981abb1399232b22a6dfc8a2efc732d9886569",
      observationId: "obs_96416cdfda3949ff922efcbd57f527bc5b19174296f97ef2345ddf3289e989b7",
      route: "filtered_non_pizza",
    },
    {
      sourceId: "synthetic-fsq-pizza-2",
      sourceRecordKey: "srk_85fc46c5272bed458abc3a0f03f0d6e754607f7ef51aadc36ac0d5062657bb90",
      observationId: "obs_952e7c79b5406edbc8f64dd7fdbc77b5c918ba91b137fc1e01f14f18aed2e83e",
      route: "ready_for_match",
    },
  ]);
});

test("executes the APizza fixture preview with durable artifacts and run state", async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "map-pipeline-preview-"));
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const state = new SqliteRunStateStore(join(runtimeRoot, "state.sqlite"));
  try {
    const executor = new PreviewExecutor({
      definition: apizzaFsqPreviewDefinition,
      catalog: apizzaFsqPreviewCatalog,
      plugins: apizzaFsqPreviewPlugins,
      readers: {
        files: new FixtureJsonResourceReader({
          fixturesRoot: resolve(repositoryRoot, "fixtures"),
          manifestPath: resolve(repositoryRoot, "fixtures", "manifest.json"),
        }),
      },
      artifactStore: new FilesystemJsonArtifactStore(join(runtimeRoot, "objects")),
      stateStore: state,
      schemaValidators: apizzaFsqPreviewSchemaValidators,
      hostPolicy: apizzaPreviewHostPolicy,
      observedFreeDiskBytes: async () => 10_000_000_000,
    });
    const report = await executor.run({ partition: "US", runId: "fixture-run" });
    assert.equal(report.status, "succeeded");
    assert.deepEqual(report.stages.map((stage) => stage.stageId), [
      "source",
      "normalize",
      "report",
    ]);
    assert.deepEqual(report.stages[1]?.metrics, {
      candidates: 4,
      filtered_non_pizza: 1,
      ready_for_match: 3,
    });
    assert.equal(report.stages[2]?.deliveryReceipts.length, 1);
    assert.equal(state.getRun("fixture-run")?.status, "succeeded");
    assert.equal(state.listStageAttempts("fixture-run").length, 3);
  } finally {
    state.close();
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("fixture preview rejects network effects before execution", () => {
  const definition = structuredClone(apizzaFsqPreviewDefinition);
  definition.stages[0]!.requestedEffects![0] = {
    effectClass: "network.read",
    resourceUri: "https://example.invalid/records",
    operations: ["read"],
    maxRecords: 1,
  };
  assert.throws(
    () => new PreviewExecutor({
      definition,
      catalog: apizzaFsqPreviewCatalog,
      plugins: apizzaFsqPreviewPlugins,
      readers: {},
      artifactStore: {} as never,
      stateStore: {} as never,
      schemaValidators: apizzaFsqPreviewSchemaValidators,
      hostPolicy: apizzaPreviewHostPolicy,
      observedFreeDiskBytes: async () => 10_000_000_000,
    }),
    PreviewExecutionError,
  );
});

test("fails the durable run when a stage exceeds its artifact-byte reservation", async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "map-pipeline-preview-limit-"));
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const state = new SqliteRunStateStore(join(runtimeRoot, "state.sqlite"));
  try {
    const definition = structuredClone(apizzaFsqPreviewDefinition);
    definition.stages[1]!.resources.maxArtifactBytes = 1;
    const executor = new PreviewExecutor({
      definition,
      catalog: apizzaFsqPreviewCatalog,
      plugins: apizzaFsqPreviewPlugins,
      readers: {
        files: new FixtureJsonResourceReader({
          fixturesRoot: resolve(repositoryRoot, "fixtures"),
          manifestPath: resolve(repositoryRoot, "fixtures", "manifest.json"),
        }),
      },
      artifactStore: new FilesystemJsonArtifactStore(join(runtimeRoot, "objects")),
      stateStore: state,
      schemaValidators: apizzaFsqPreviewSchemaValidators,
      hostPolicy: apizzaPreviewHostPolicy,
      observedFreeDiskBytes: async () => 10_000_000_000,
    });
    await assert.rejects(
      () => executor.run({ partition: "US", runId: "artifact-limit-run" }),
      /Artifact exceeds 1 bytes/,
    );
    assert.equal(state.getRun("artifact-limit-run")?.status, "failed");
    assert.equal(
      state.listStageAttempts("artifact-limit-run")
        .find((attempt) => attempt.stageId === "normalize")?.status,
      "failed",
    );
  } finally {
    state.close();
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("a later plugin cannot read a registered dataset omitted from its input map", async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "map-pipeline-preview-inputs-"));
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const state = new SqliteRunStateStore(join(runtimeRoot, "state.sqlite"));
  let leakedSource: DatasetHandle | undefined;
  try {
    const source = apizzaFsqPreviewPlugins["fixture-json-source"]!;
    const report = apizzaFsqPreviewPlugins["apizza-preview-report"]!;
    const plugins: Record<string, StagePlugin> = {
      ...apizzaFsqPreviewPlugins,
      "fixture-json-source": {
        manifest: source.manifest,
        async run(context, inputs, config) {
          const result = await source.run(context, inputs, config);
          leakedSource = result.outputs.records;
          return result;
        },
      },
      "apizza-preview-report": {
        manifest: report.manifest,
        async run(context) {
          await context.broker.readDatasetJson(leakedSource!);
          throw new Error("cross-stage dataset read unexpectedly succeeded");
        },
      },
    };
    const executor = new PreviewExecutor({
      definition: apizzaFsqPreviewDefinition,
      catalog: apizzaFsqPreviewCatalog,
      plugins,
      readers: {
        files: new FixtureJsonResourceReader({
          fixturesRoot: resolve(repositoryRoot, "fixtures"),
          manifestPath: resolve(repositoryRoot, "fixtures", "manifest.json"),
        }),
      },
      artifactStore: new FilesystemJsonArtifactStore(join(runtimeRoot, "objects")),
      stateStore: state,
      schemaValidators: apizzaFsqPreviewSchemaValidators,
      hostPolicy: apizzaPreviewHostPolicy,
      observedFreeDiskBytes: async () => 10_000_000_000,
    });
    await assert.rejects(
      () => executor.run({ partition: "US", runId: "input-isolation-run" }),
      /not an input of this stage/,
    );
    assert.equal(state.getRun("input-isolation-run")?.status, "failed");
  } finally {
    state.close();
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("source finalization is one-shot under concurrent plugin calls", async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "map-pipeline-preview-once-"));
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const state = new SqliteRunStateStore(join(runtimeRoot, "state.sqlite"));
  const baseStore = new FilesystemJsonArtifactStore(join(runtimeRoot, "objects"));
  let sourceCommitCalls = 0;
  let rejectedFinalizations = 0;
  const artifactStore: JsonArtifactStore = {
    stageJson: (value, options) => baseStore.stageJson(value, options),
    async commitJson(staged, metadata, options) {
      if (metadata.provenance.kind === "source") sourceCommitCalls += 1;
      await new Promise<void>((resolveDelay) => setImmediate(resolveDelay));
      return baseStore.commitJson(staged, metadata, options);
    },
    discard: (staged) => baseStore.discard(staged),
    readJson: (artifact, options) => baseStore.readJson(artifact, options),
  };
  const originalSource = apizzaFsqPreviewPlugins["fixture-json-source"]!;
  const plugins: Record<string, StagePlugin> = {
    ...apizzaFsqPreviewPlugins,
    "fixture-json-source": {
      manifest: originalSource.manifest,
      async run(context) {
        const acquisition = await context.broker.acquire({
          effectClass: "artifact.read",
          resourceUri: "fixture://synthetic/apizza-fsq-records",
          operation: "read",
        });
        const stagedArtifact = await context.broker.stageSourceArtifact({
          acquisition,
          outputPort: "records",
          artifactUri: "fixture://synthetic/apizza-fsq-records",
        });
        const results = await Promise.allSettled([
          context.broker.finalizeSourceArtifactAndCommitAcquisition({
            acquisition,
            stagedArtifact,
            outputPort: "records",
          }),
          context.broker.finalizeSourceArtifactAndCommitAcquisition({
            acquisition,
            stagedArtifact,
            outputPort: "records",
          }),
        ]);
        rejectedFinalizations = results.filter((result) => result.status === "rejected").length;
        const completed = results.find((result) => result.status === "fulfilled");
        if (!completed || completed.status !== "fulfilled") {
          throw new Error("No source finalization succeeded");
        }
        return { outputs: { records: completed.value }, metrics: { records: 4 } };
      },
    },
  };
  try {
    const executor = new PreviewExecutor({
      definition: apizzaFsqPreviewDefinition,
      catalog: apizzaFsqPreviewCatalog,
      plugins,
      readers: {
        files: new FixtureJsonResourceReader({
          fixturesRoot: resolve(repositoryRoot, "fixtures"),
          manifestPath: resolve(repositoryRoot, "fixtures", "manifest.json"),
        }),
      },
      artifactStore,
      stateStore: state,
      schemaValidators: apizzaFsqPreviewSchemaValidators,
      hostPolicy: apizzaPreviewHostPolicy,
      observedFreeDiskBytes: async () => 10_000_000_000,
    });
    await executor.run({ partition: "US", runId: "one-shot-run" });
    assert.equal(sourceCommitCalls, 1);
    assert.equal(rejectedFinalizations, 1);
  } finally {
    state.close();
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("timeout drains a late broker read before failing without artifacts", async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "map-pipeline-preview-timeout-"));
  const state = new SqliteRunStateStore(join(runtimeRoot, "state.sqlite"));
  const artifactRoot = join(runtimeRoot, "artifacts");
  const definition = structuredClone(apizzaFsqPreviewDefinition);
  definition.stages[0]!.resources.maxWallTimeMs = 5;
  const slowReader: ResourceReader = {
    async read() {
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 30));
      return {
        value: {
          fixtureId: "late",
          license: "CC0-1.0",
          synthetic: true,
          rows: [],
        },
        observedChildIds: [],
        schema: { name: "apizza.fsq.synthetic-document", version: 1 },
      };
    },
  };
  try {
    const executor = new PreviewExecutor({
      definition,
      catalog: apizzaFsqPreviewCatalog,
      plugins: apizzaFsqPreviewPlugins,
      readers: { files: slowReader },
      artifactStore: new FilesystemJsonArtifactStore(artifactRoot),
      stateStore: state,
      schemaValidators: apizzaFsqPreviewSchemaValidators,
      hostPolicy: apizzaPreviewHostPolicy,
      observedFreeDiskBytes: async () => 10_000_000_000,
    });
    await assert.rejects(
      () => executor.run({ partition: "US", runId: "timeout-run" }),
      /exceeded 5ms/,
    );
    assert.equal(state.getRun("timeout-run")?.status, "failed");
    assert.deepEqual(await readdir(join(artifactRoot, "objects")), []);
    assert.deepEqual(await readdir(join(artifactRoot, "manifests")), []);
    assert.deepEqual(await readdir(join(artifactRoot, "staging")), []);
  } finally {
    state.close();
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("timeout aborts a delayed artifact commit before durable files appear", async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "map-pipeline-preview-commit-timeout-"));
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const state = new SqliteRunStateStore(join(runtimeRoot, "state.sqlite"));
  const artifactRoot = join(runtimeRoot, "artifacts");
  const baseStore = new FilesystemJsonArtifactStore(artifactRoot);
  const delayedStore: JsonArtifactStore = {
    stageJson: (value, options) => baseStore.stageJson(value, options),
    async commitJson(staged, metadata, options) {
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 30));
      return baseStore.commitJson(staged, metadata, options);
    },
    discard: (staged) => baseStore.discard(staged),
    readJson: (artifact, options) => baseStore.readJson(artifact, options),
  };
  const definition = structuredClone(apizzaFsqPreviewDefinition);
  definition.stages[0]!.resources.maxWallTimeMs = 5;
  try {
    const executor = new PreviewExecutor({
      definition,
      catalog: apizzaFsqPreviewCatalog,
      plugins: apizzaFsqPreviewPlugins,
      readers: {
        files: new FixtureJsonResourceReader({
          fixturesRoot: resolve(repositoryRoot, "fixtures"),
          manifestPath: resolve(repositoryRoot, "fixtures", "manifest.json"),
        }),
      },
      artifactStore: delayedStore,
      stateStore: state,
      schemaValidators: apizzaFsqPreviewSchemaValidators,
      hostPolicy: apizzaPreviewHostPolicy,
      observedFreeDiskBytes: async () => 10_000_000_000,
    });
    await assert.rejects(
      () => executor.run({ partition: "US", runId: "commit-timeout-run" }),
      /exceeded 5ms/,
    );
    assert.equal(state.getRun("commit-timeout-run")?.status, "failed");
    assert.deepEqual(await readdir(join(artifactRoot, "objects")), []);
    assert.deepEqual(await readdir(join(artifactRoot, "manifests")), []);
    assert.deepEqual(await readdir(join(artifactRoot, "staging")), []);
  } finally {
    state.close();
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("one executor instance rejects overlapping runs", async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "map-pipeline-preview-admission-"));
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const state = new SqliteRunStateStore(join(runtimeRoot, "state.sqlite"));
  let releaseDiskCheck: ((bytes: number) => void) | undefined;
  let firstCheck = true;
  try {
    const executor = new PreviewExecutor({
      definition: apizzaFsqPreviewDefinition,
      catalog: apizzaFsqPreviewCatalog,
      plugins: apizzaFsqPreviewPlugins,
      readers: {
        files: new FixtureJsonResourceReader({
          fixturesRoot: resolve(repositoryRoot, "fixtures"),
          manifestPath: resolve(repositoryRoot, "fixtures", "manifest.json"),
        }),
      },
      artifactStore: new FilesystemJsonArtifactStore(join(runtimeRoot, "objects")),
      stateStore: state,
      schemaValidators: apizzaFsqPreviewSchemaValidators,
      hostPolicy: apizzaPreviewHostPolicy,
      observedFreeDiskBytes: () => {
        if (!firstCheck) return Promise.resolve(10_000_000_000);
        firstCheck = false;
        return new Promise<number>((resolveCheck) => {
          releaseDiskCheck = resolveCheck;
        });
      },
    });
    const firstRun = executor.run({ partition: "US", runId: "first-run" });
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    await assert.rejects(
      () => executor.run({ partition: "US", runId: "second-run" }),
      /already has an active run/,
    );
    releaseDiskCheck?.(10_000_000_000);
    await firstRun;
    assert.equal(state.getRun("first-run")?.status, "succeeded");
    assert.equal(state.getRun("second-run"), null);
  } finally {
    releaseDiskCheck?.(10_000_000_000);
    state.close();
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("source payloads must pass the host-owned versioned schema validator", async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "map-pipeline-preview-schema-"));
  const state = new SqliteRunStateStore(join(runtimeRoot, "state.sqlite"));
  const reader: ResourceReader = {
    async read() {
      return {
        value: { not: "an FSQ document" },
        observedChildIds: [],
        schema: { name: "apizza.fsq.synthetic-document", version: 1 },
      };
    },
  };
  try {
    const executor = new PreviewExecutor({
      definition: apizzaFsqPreviewDefinition,
      catalog: apizzaFsqPreviewCatalog,
      plugins: apizzaFsqPreviewPlugins,
      readers: { files: reader },
      artifactStore: new FilesystemJsonArtifactStore(join(runtimeRoot, "objects")),
      stateStore: state,
      schemaValidators: apizzaFsqPreviewSchemaValidators,
      hostPolicy: apizzaPreviewHostPolicy,
      observedFreeDiskBytes: async () => 10_000_000_000,
    });
    await assert.rejects(
      () => executor.run({ partition: "US", runId: "invalid-source-schema" }),
      /failed apizza\.fsq\.synthetic-document@1 validation/,
    );
    assert.equal(state.getRun("invalid-source-schema")?.status, "failed");
  } finally {
    state.close();
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("source schema identity must match the declared output", async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "map-pipeline-preview-schema-id-"));
  const state = new SqliteRunStateStore(join(runtimeRoot, "state.sqlite"));
  const reader: ResourceReader = {
    async read() {
      return {
        value: {
          fixtureId: "wrong-schema",
          license: "CC0-1.0",
          synthetic: true,
          rows: [],
        },
        observedChildIds: [],
        schema: { name: "wrong.document", version: 1 },
      };
    },
  };
  try {
    const executor = new PreviewExecutor({
      definition: apizzaFsqPreviewDefinition,
      catalog: apizzaFsqPreviewCatalog,
      plugins: apizzaFsqPreviewPlugins,
      readers: { files: reader },
      artifactStore: new FilesystemJsonArtifactStore(join(runtimeRoot, "objects")),
      stateStore: state,
      schemaValidators: apizzaFsqPreviewSchemaValidators,
      hostPolicy: apizzaPreviewHostPolicy,
      observedFreeDiskBytes: async () => 10_000_000_000,
    });
    await assert.rejects(
      () => executor.run({ partition: "US", runId: "schema-label-mismatch" }),
      /does not match the reader schema/,
    );
  } finally {
    state.close();
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("source dispatch is bound to the declared adapter identity", async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "map-pipeline-preview-adapter-"));
  const state = new SqliteRunStateStore(join(runtimeRoot, "state.sqlite"));
  const protocolReader: ResourceReader = {
    async read() {
      throw new Error("protocol-keyed reader must not run");
    },
  };
  try {
    const executor = new PreviewExecutor({
      definition: apizzaFsqPreviewDefinition,
      catalog: apizzaFsqPreviewCatalog,
      plugins: apizzaFsqPreviewPlugins,
      readers: { "fixture:": protocolReader },
      artifactStore: new FilesystemJsonArtifactStore(join(runtimeRoot, "objects")),
      stateStore: state,
      schemaValidators: apizzaFsqPreviewSchemaValidators,
      hostPolicy: apizzaPreviewHostPolicy,
      observedFreeDiskBytes: async () => 10_000_000_000,
    });
    await assert.rejects(
      () => executor.run({ partition: "US", runId: "adapter-binding" }),
      /No reader registered for adapter files/,
    );
  } finally {
    state.close();
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("a stage cannot return a prior-stage dataset as its own output", async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "map-pipeline-preview-origin-"));
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const state = new SqliteRunStateStore(join(runtimeRoot, "state.sqlite"));
  const definition = structuredClone(apizzaFsqPreviewDefinition);
  const catalog = structuredClone(apizzaFsqPreviewCatalog);
  catalog["apizza-preview-report"]!.outputs.report =
    structuredClone(catalog["apizza-fsq-normalize"]!.outputs.candidates!);
  const manifest = catalog["apizza-preview-report"]!;
  const plugins = {
    ...apizzaFsqPreviewPlugins,
    "apizza-preview-report": {
      manifest,
      async run(_context, inputs) {
        const output = inputs.candidates!;
        return {
          outputs: { report: output },
          metrics: { candidates: output.recordCount },
          deliveryReceipts: [{
            idempotencyKey: "forged",
            outputPort: "report",
            payloadHash: (output as DatasetRef).contentDigest,
            targetVersion: "forged@1",
            outcome: "created",
            verifiedAt: "2020-01-01T00:00:00.000Z",
          } as never],
        };
      },
    } satisfies StagePlugin,
  };
  try {
    const executor = new PreviewExecutor({
      definition,
      catalog,
      plugins,
      readers: {
        files: new FixtureJsonResourceReader({
          fixturesRoot: resolve(repositoryRoot, "fixtures"),
          manifestPath: resolve(repositoryRoot, "fixtures", "manifest.json"),
        }),
      },
      artifactStore: new FilesystemJsonArtifactStore(join(runtimeRoot, "objects")),
      stateStore: state,
      schemaValidators: apizzaFsqPreviewSchemaValidators,
      hostPolicy: apizzaPreviewHostPolicy,
      observedFreeDiskBytes: async () => 10_000_000_000,
    });
    await assert.rejects(
      () => executor.run({ partition: "US", runId: "origin-bypass" }),
      /failed output accounting/,
    );
  } finally {
    state.close();
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("a required sink cannot fabricate a delivery receipt", async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "map-pipeline-preview-receipt-"));
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const state = new SqliteRunStateStore(join(runtimeRoot, "state.sqlite"));
  const reportManifest = apizzaFsqPreviewCatalog["apizza-preview-report"]!;
  const forgedReport: StagePlugin = {
    manifest: reportManifest,
    async run(context) {
      const staged = await context.broker.stageDerivedJson({
        outputPort: "report",
        value: {
          version: 1,
          profile: "apizzamichigan",
          source: "fsq_os_places",
          partition: context.partition,
          candidateCount: 0,
          routeCounts: {},
          sourceRecordKeys: [],
        },
      });
      const output = await context.broker.finalizeDerivedArtifact({
        stagedArtifact: staged,
        outputPort: "report",
      });
      return {
        outputs: { report: output },
        metrics: { candidates: 0 },
        deliveryReceipts: [{
          idempotencyKey: "forged",
          outputPort: "report",
          payloadHash: output.contentDigest,
          targetVersion: "forged@1",
          outcome: "created",
          verifiedAt: "2020-01-01T00:00:00.000Z",
        } as never],
      };
    },
  };
  try {
    const executor = new PreviewExecutor({
      definition: apizzaFsqPreviewDefinition,
      catalog: apizzaFsqPreviewCatalog,
      plugins: { ...apizzaFsqPreviewPlugins, "apizza-preview-report": forgedReport },
      readers: {
        files: new FixtureJsonResourceReader({
          fixturesRoot: resolve(repositoryRoot, "fixtures"),
          manifestPath: resolve(repositoryRoot, "fixtures", "manifest.json"),
        }),
      },
      artifactStore: new FilesystemJsonArtifactStore(join(runtimeRoot, "objects")),
      stateStore: state,
      schemaValidators: apizzaFsqPreviewSchemaValidators,
      hostPolicy: apizzaPreviewHostPolicy,
      observedFreeDiskBytes: async () => 10_000_000_000,
    });
    await assert.rejects(
      () => executor.run({ partition: "US", runId: "receipt-bypass" }),
      /returned an invalid receipt/,
    );
  } finally {
    state.close();
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("schema validation and persistence use a broker-owned value snapshot", async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "map-pipeline-preview-snapshot-"));
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const artifactStore = new FilesystemJsonArtifactStore(join(runtimeRoot, "objects"));
  const state = new SqliteRunStateStore(join(runtimeRoot, "state.sqlite"));
  const reportManifest = apizzaFsqPreviewCatalog["apizza-preview-report"]!;
  const mutatingReport: StagePlugin = {
    manifest: reportManifest,
    async run(context) {
      const value: Record<string, unknown> = {
        version: 1,
        profile: "apizzamichigan",
        source: "fsq_os_places",
        partition: context.partition,
        candidateCount: 0,
        routeCounts: {},
        sourceRecordKeys: [],
      };
      const staging = context.broker.stageDerivedJson({
        outputPort: "report",
        value: value as CanonicalJson,
      });
      value.version = 999;
      const staged = await staging;
      const committed = await context.broker.commitStagedOutput({
        stagedArtifact: staged,
        outputPort: "report",
        effectClass: "artifact.write",
        resourceUri: "preview://apizzamichigan/fsq/report",
        operation: "create",
        idempotencyKey: `${context.runId}:report`,
        targetVersion: "preview-report@1",
      });
      return {
        outputs: { report: committed.output },
        metrics: { candidates: 0 },
        deliveryReceipts: [committed.receipt],
      };
    },
  };
  try {
    const executor = new PreviewExecutor({
      definition: apizzaFsqPreviewDefinition,
      catalog: apizzaFsqPreviewCatalog,
      plugins: { ...apizzaFsqPreviewPlugins, "apizza-preview-report": mutatingReport },
      readers: {
        files: new FixtureJsonResourceReader({
          fixturesRoot: resolve(repositoryRoot, "fixtures"),
          manifestPath: resolve(repositoryRoot, "fixtures", "manifest.json"),
        }),
      },
      artifactStore,
      stateStore: state,
      schemaValidators: apizzaFsqPreviewSchemaValidators,
      hostPolicy: apizzaPreviewHostPolicy,
      observedFreeDiskBytes: async () => 10_000_000_000,
    });
    const result = await executor.run({ partition: "US", runId: "snapshot-value" });
    const reportUri = result.stages.at(-1)!.outputs.report!.uri;
    const persisted = JSON.parse(await readFile(new URL(reportUri), "utf8"));
    assert.equal(persisted.version, 1);
  } finally {
    state.close();
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("every broker-finalized output must be returned by its stage", async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "map-pipeline-preview-output-accounting-"));
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const state = new SqliteRunStateStore(join(runtimeRoot, "state.sqlite"));
  const catalog = structuredClone(apizzaFsqPreviewCatalog);
  const reportManifest = catalog["apizza-preview-report"]!;
  reportManifest.outputs.unreported = {
    ...structuredClone(reportManifest.outputs.report!),
    required: false,
  };
  const extraOutputReport: StagePlugin = {
    manifest: reportManifest,
    async run(context) {
      const value = {
        version: 1,
        profile: "apizzamichigan",
        source: "fsq_os_places",
        partition: context.partition,
        candidateCount: 0,
        routeCounts: {},
        sourceRecordKeys: [],
      };
      const reportStaged = await context.broker.stageDerivedJson({
        outputPort: "report",
        value,
      });
      const committed = await context.broker.commitStagedOutput({
        stagedArtifact: reportStaged,
        outputPort: "report",
        effectClass: "artifact.write",
        resourceUri: "preview://apizzamichigan/fsq/report",
        operation: "create",
        idempotencyKey: `${context.runId}:report`,
        targetVersion: "preview-report@1",
      });
      const hiddenStaged = await context.broker.stageDerivedJson({
        outputPort: "unreported",
        value,
      });
      await context.broker.finalizeDerivedArtifact({
        stagedArtifact: hiddenStaged,
        outputPort: "unreported",
      });
      return {
        outputs: { report: committed.output },
        metrics: { candidates: 0 },
        deliveryReceipts: [committed.receipt],
      };
    },
  };
  try {
    const executor = new PreviewExecutor({
      definition: apizzaFsqPreviewDefinition,
      catalog,
      plugins: { ...apizzaFsqPreviewPlugins, "apizza-preview-report": extraOutputReport },
      readers: {
        files: new FixtureJsonResourceReader({
          fixturesRoot: resolve(repositoryRoot, "fixtures"),
          manifestPath: resolve(repositoryRoot, "fixtures", "manifest.json"),
        }),
      },
      artifactStore: new FilesystemJsonArtifactStore(join(runtimeRoot, "objects")),
      stateStore: state,
      schemaValidators: apizzaFsqPreviewSchemaValidators,
      hostPolicy: apizzaPreviewHostPolicy,
      observedFreeDiskBytes: async () => 10_000_000_000,
    });
    await assert.rejects(
      () => executor.run({ partition: "US", runId: "output-accounting" }),
      /output accounting/,
    );
    assert.equal(state.getRun("output-accounting")?.status, "failed");
  } finally {
    state.close();
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("concurrent staging cannot exceed one stage artifact reservation", async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "map-pipeline-preview-stage-race-"));
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const artifactRoot = join(runtimeRoot, "objects");
  const state = new SqliteRunStateStore(join(runtimeRoot, "state.sqlite"));
  const normalizeManifest = apizzaFsqPreviewCatalog["apizza-fsq-normalize"]!;
  const racingNormalize: StagePlugin = {
    manifest: normalizeManifest,
    async run(context) {
      const attempts = await Promise.allSettled([
        context.broker.stageDerivedJson({ outputPort: "candidates", value: [] }),
        context.broker.stageDerivedJson({ outputPort: "candidates", value: [] }),
      ]);
      const rejection = attempts.find((attempt) => attempt.status === "rejected");
      if (rejection?.status === "rejected") throw rejection.reason;
      throw new Error("Concurrent staging unexpectedly succeeded");
    },
  };
  try {
    const executor = new PreviewExecutor({
      definition: apizzaFsqPreviewDefinition,
      catalog: apizzaFsqPreviewCatalog,
      plugins: { ...apizzaFsqPreviewPlugins, "apizza-fsq-normalize": racingNormalize },
      readers: {
        files: new FixtureJsonResourceReader({
          fixturesRoot: resolve(repositoryRoot, "fixtures"),
          manifestPath: resolve(repositoryRoot, "fixtures", "manifest.json"),
        }),
      },
      artifactStore: new FilesystemJsonArtifactStore(artifactRoot),
      stateStore: state,
      schemaValidators: apizzaFsqPreviewSchemaValidators,
      hostPolicy: apizzaPreviewHostPolicy,
      observedFreeDiskBytes: async () => 10_000_000_000,
    });
    await assert.rejects(
      () => executor.run({ partition: "US", runId: "stage-race" }),
      /Concurrent artifact staging is not allowed/,
    );
    assert.deepEqual(await readdir(join(artifactRoot, "staging")), []);
  } finally {
    state.close();
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("a plugin returning with an unawaited broker operation fails the run", async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "map-pipeline-preview-unawaited-"));
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const artifactRoot = join(runtimeRoot, "objects");
  const baseStore = new FilesystemJsonArtifactStore(artifactRoot);
  const delayedReadStore: JsonArtifactStore = {
    stageJson: (value, options) => baseStore.stageJson(value, options),
    commitJson: (staged, metadata, options) => baseStore.commitJson(staged, metadata, options),
    discard: (staged) => baseStore.discard(staged),
    async readJson(artifact, options) {
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 30));
      return baseStore.readJson(artifact, options);
    },
  };
  const state = new SqliteRunStateStore(join(runtimeRoot, "state.sqlite"));
  const originalReport = apizzaFsqPreviewPlugins["apizza-preview-report"]!;
  const plugins: Record<string, StagePlugin> = {
    ...apizzaFsqPreviewPlugins,
    "apizza-preview-report": {
      manifest: originalReport.manifest,
      async run(context, inputs, config) {
        const result = await originalReport.run(context, inputs, config);
        void context.broker.readDatasetJson(inputs.candidates!).catch(() => undefined);
        return result;
      },
    },
  };
  try {
    const executor = new PreviewExecutor({
      definition: apizzaFsqPreviewDefinition,
      catalog: apizzaFsqPreviewCatalog,
      plugins,
      readers: {
        files: new FixtureJsonResourceReader({
          fixturesRoot: resolve(repositoryRoot, "fixtures"),
          manifestPath: resolve(repositoryRoot, "fixtures", "manifest.json"),
        }),
      },
      artifactStore: delayedReadStore,
      stateStore: state,
      schemaValidators: apizzaFsqPreviewSchemaValidators,
      hostPolicy: apizzaPreviewHostPolicy,
      observedFreeDiskBytes: async () => 10_000_000_000,
    });
    await assert.rejects(
      () => executor.run({ partition: "US", runId: "unawaited-operation" }),
      /unawaited broker operations/,
    );
    assert.equal(state.getRun("unawaited-operation")?.status, "failed");
    assert.deepEqual(await readdir(join(artifactRoot, "staging")), []);
  } finally {
    state.close();
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("a two-parent transform cannot mutate away lineage", async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "map-pipeline-preview-lineage-"));
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const state = new SqliteRunStateStore(join(runtimeRoot, "state.sqlite"));
  const sourceManifest = apizzaFsqPreviewCatalog["fixture-json-source"]!;
  const reportManifest = apizzaFsqPreviewCatalog["apizza-preview-report"]!;
  const mergeManifest: StagePluginManifest = {
    id: "two-parent-merge",
    lock: {
      ...apizzaFsqPreviewCatalog["apizza-fsq-normalize"]!.lock,
      packageName: "@map-pipeline/test-two-parent-merge",
      integrity: `sha256:${"4".repeat(64)}`,
    },
    inputs: {
      left: sourceManifest.outputs.records!,
      right: sourceManifest.outputs.records!,
    },
    outputs: {
      candidates: apizzaFsqPreviewCatalog["apizza-fsq-normalize"]!.outputs.candidates!,
    },
    sourceAdapter: null,
    effects: ["artifact.write"],
    delivery: "none",
  };
  const sourceTemplate = apizzaFsqPreviewDefinition.stages[0]!;
  const reportTemplate = apizzaFsqPreviewDefinition.stages[2]!;
  const sourceStage = (id: string): PipelineDefinition["stages"][number] => ({
    ...structuredClone(sourceTemplate),
    id,
    requestedEffects: structuredClone(sourceTemplate.requestedEffects!).map((effect) =>
      effect.effectClass === "artifact.write"
        ? { ...effect, resourceUri: `preview://apizzamichigan/fsq/${id}` }
        : effect),
  });
  const definition: PipelineDefinition = {
    ...structuredClone(apizzaFsqPreviewDefinition),
    metadata: { name: "two-parent-lineage-preview", version: 1 },
    stages: [
      sourceStage("source-left"),
      sourceStage("source-right"),
      {
        id: "merge",
        uses: "two-parent-merge",
        inputs: {
          left: "source-left.records",
          right: "source-right.records",
        },
        resources: structuredClone(apizzaFsqPreviewDefinition.stages[1]!.resources),
        requestedEffects: [{
          effectClass: "artifact.write",
          resourceUri: "preview://apizzamichigan/fsq/merge",
          operations: ["create"],
          maxRecords: 10,
        }],
      },
      {
        ...structuredClone(reportTemplate),
        inputs: { candidates: "merge.candidates" },
      },
    ],
  };
  const catalog = {
    "fixture-json-source": sourceManifest,
    "two-parent-merge": mergeManifest,
    "apizza-preview-report": reportManifest,
  };
  let mergedOutput: DatasetRef | undefined;
  let expectedParents: string[] = [];
  const mergePlugin: StagePlugin = {
    manifest: mergeManifest,
    async run(context, inputs) {
      assert(Object.isFrozen(inputs));
      assert.throws(() => {
        delete (inputs as Record<string, DatasetHandle>).left;
      }, TypeError);
      expectedParents = Object.values(inputs).map((dataset) => dataset.brokerHandle).sort();
      await Promise.all([
        context.broker.readDatasetJson(inputs.left!),
        context.broker.readDatasetJson(inputs.right!),
      ]);
      const staged = await context.broker.stageDerivedJson({
        outputPort: "candidates",
        value: [] as CanonicalJson,
      });
      mergedOutput = await context.broker.finalizeDerivedArtifact({
        stagedArtifact: staged,
        outputPort: "candidates",
      });
      return { outputs: { candidates: mergedOutput }, metrics: { candidates: 0 } };
    },
  };
  try {
    const executor = new PreviewExecutor({
      definition,
      catalog,
      plugins: {
        "fixture-json-source": apizzaFsqPreviewPlugins["fixture-json-source"]!,
        "two-parent-merge": mergePlugin,
        "apizza-preview-report": apizzaFsqPreviewPlugins["apizza-preview-report"]!,
      },
      readers: {
        files: new FixtureJsonResourceReader({
          fixturesRoot: resolve(repositoryRoot, "fixtures"),
          manifestPath: resolve(repositoryRoot, "fixtures", "manifest.json"),
        }),
      },
      artifactStore: new FilesystemJsonArtifactStore(join(runtimeRoot, "objects")),
      stateStore: state,
      schemaValidators: apizzaFsqPreviewSchemaValidators,
      hostPolicy: apizzaPreviewHostPolicy,
      observedFreeDiskBytes: async () => 10_000_000_000,
    });
    await executor.run({ partition: "US", runId: "lineage-run" });
    assert(mergedOutput);
    assert.equal(mergedOutput.provenance.kind, "internal");
    if (mergedOutput.provenance.kind !== "internal") return;
    assert.deepEqual([...mergedOutput.provenance.parentHandles].sort(), expectedParents);
    assert.equal(mergedOutput.provenance.parentHandles.length, 2);
  } finally {
    state.close();
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});
