import assert from "node:assert/strict";
import test from "node:test";

import {
  PIPELINE_API_VERSION,
  type PipelineDefinition,
  type StagePluginManifest,
} from "./types.js";
import { validateDefinition } from "./validation.js";

const recordsPort = {
  schema: { name: "synthetic.records", version: 1 },
  cardinality: "many" as const,
  partitioning: "by_partition" as const,
  ordering: "canonical" as const,
  artifactPolicy: "required" as const,
};

const catalog: Record<string, StagePluginManifest> = {
  "synthetic-source": {
    id: "synthetic-source",
    lock: {
      packageName: "@map-pipeline/synthetic-source",
      packageVersion: "0.0.0-test",
      pluginApiVersion: PIPELINE_API_VERSION,
      integrity: `sha256:${"0".repeat(64)}`,
      configSchema: { name: "synthetic.source.config", version: 1 },
      configSchemaDigest: `sha256:${"1".repeat(64)}`,
    },
    inputs: {},
    outputs: { records: recordsPort },
    policyBinding: "source",
    effects: ["artifact.read", "artifact.write"],
    delivery: "none",
  },
  "synthetic-sink": {
    id: "synthetic-sink",
    lock: {
      packageName: "@map-pipeline/synthetic-sink",
      packageVersion: "0.0.0-test",
      pluginApiVersion: PIPELINE_API_VERSION,
      integrity: `sha256:${"2".repeat(64)}`,
      configSchema: { name: "synthetic.sink.config", version: 1 },
      configSchemaDigest: `sha256:${"3".repeat(64)}`,
    },
    inputs: { records: recordsPort },
    outputs: {},
    policyBinding: "none",
    effects: ["artifact.write"],
    delivery: "verified_receipt",
  },
};

function definition(): PipelineDefinition {
  return {
    apiVersion: PIPELINE_API_VERSION,
    kind: "Pipeline",
    metadata: { name: "synthetic-example", version: 1 },
    profile: "synthetic-test",
    stages: [
      {
        id: "source",
        uses: "synthetic-source",
        sourcePolicyIds: ["synthetic-source-v1"],
        resources: {
          admissionGroup: "source-heavy",
          maxCpuUnits: 1,
          maxRssBytes: 134217728,
          maxChildProcesses: 1,
          maxWallTimeMs: 30000,
          maxArtifactBytes: 1048576,
          minFreeDiskBytes: 1073741824,
        },
        requestedEffects: [
          {
            effectClass: "artifact.read",
            resourceUri: "fixture://synthetic/source",
            operations: ["read"],
            maxRecords: 10,
          },
          {
            effectClass: "artifact.write",
            resourceUri: "preview://artifacts/source",
            operations: ["create"],
            maxRecords: 10,
          },
        ],
      },
      {
        id: "sink",
        uses: "synthetic-sink",
        inputs: { records: "source.records" },
        resources: {
          admissionGroup: "artifact-only",
          maxCpuUnits: 1,
          maxRssBytes: 134217728,
          maxChildProcesses: 1,
          maxWallTimeMs: 30000,
          maxArtifactBytes: 1048576,
          minFreeDiskBytes: 1073741824,
        },
        requestedEffects: [
          {
            effectClass: "artifact.write",
            resourceUri: "preview://artifacts/sink",
            operations: ["create"],
            maxRecords: 10,
          },
        ],
      },
    ],
    requiredSinks: ["sink"],
    optionalSinks: [],
  };
}

test("validates an ordered pipeline with explicit effect requests", () => {
  assert.deepEqual(validateDefinition(definition(), catalog), []);
});

test("rejects forward references and missing effect requests", () => {
  const invalid = definition();
  const source = invalid.stages[0];
  assert(source);
  source.inputs = { unexpected: "sink.records" };
  source.requestedEffects = [];

  const issues = validateDefinition(invalid, catalog);
  assert(issues.some((issue) => issue.message.includes("missing a request")));
  assert(issues.some((issue) => issue.message.includes("not declared")));
});

test("rejects artifact-policy mismatch and non-terminal required sinks", () => {
  const invalidCatalog = structuredClone(catalog);
  const source = invalidCatalog["synthetic-source"];
  const sink = invalidCatalog["synthetic-sink"];
  assert(source);
  assert(sink);
  const records = source.outputs.records;
  assert(records);
  sink.inputs.records = { ...records, artifactPolicy: "required" };
  records.artifactPolicy = "forbidden";

  const invalidDefinition = definition();
  invalidDefinition.requiredSinks = ["source"];
  const issues = validateDefinition(invalidDefinition, invalidCatalog);
  assert(issues.some((issue) => issue.message.includes("artifact compatible")));
  assert(issues.some((issue) => issue.message.includes("terminal stage")));
  assert(issues.some((issue) => issue.message.includes("verified receipts")));
});
