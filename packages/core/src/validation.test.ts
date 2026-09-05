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
    sourceAdapter: "synthetic",
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
    outputs: {
      report: {
        ...recordsPort,
        schema: { name: "synthetic.preview-report", version: 1 },
      },
    },
    sourceAdapter: null,
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
        sourceBindings: [
          {
            policyId: "synthetic-source-v1",
            effectClass: "artifact.read",
            resourceUri: "fixture://synthetic/source",
            operations: ["read"],
            outputPorts: ["records"],
            artifactClass: "raw",
            childIds: [],
          },
        ],
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

test("write effects require a compatible subject-bearing port", () => {
  const noOutputCatalog = structuredClone(catalog);
  noOutputCatalog["synthetic-sink"]!.outputs = {};
  assert(
    validateDefinition(definition(), noOutputCatalog).some((issue) =>
      issue.message.includes("output write effects require"),
    ),
  );

  const noInputDefinition = definition();
  const noInputSink = noInputDefinition.stages[1]!;
  noInputSink.inputs = {};
  noInputSink.requestedEffects = [
    {
      effectClass: "canonical.write",
      resourceUri: "postgres://synthetic/records",
      operations: ["upsert"],
      maxRecords: 10,
    },
  ];
  const consumerCatalog = structuredClone(catalog);
  consumerCatalog["synthetic-sink"]!.effects = ["canonical.write"];
  assert(
    validateDefinition(noInputDefinition, consumerCatalog).some((issue) =>
      issue.message.includes("consumer write effects require"),
    ),
  );
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

test("rejects unlabeled, duplicate, and resource-mismatched source outputs", () => {
  const unlabeledCatalog = structuredClone(catalog);
  unlabeledCatalog["synthetic-source"]!.outputs.metadata = {
    ...recordsPort,
    schema: { name: "synthetic.metadata", version: 1 },
  };
  const unlabeledIssues = validateDefinition(definition(), unlabeledCatalog);
  assert(
    unlabeledIssues.some((issue) =>
      issue.message.includes("metadata is not policy-bound"),
    ),
  );

  const duplicated = definition();
  duplicated.stages[0]!.sourceBindings!.push({
    ...structuredClone(duplicated.stages[0]!.sourceBindings![0]!),
    outputPorts: ["records"],
  });
  assert(
    validateDefinition(duplicated, catalog).some((issue) =>
      issue.message.includes("bound more than once"),
    ),
  );

  const wrongResource = definition();
  wrongResource.stages[0]!.sourceBindings![0]!.resourceUri =
    "fixture://synthetic/different";
  assert(
    validateDefinition(wrongResource, catalog).some((issue) =>
      issue.message.includes("exactly one read effect"),
    ),
  );
});

test("rejects every extra source read that lacks its own binding", () => {
  const extraRead = definition();
  extraRead.stages[0]!.requestedEffects!.push({
    effectClass: "artifact.read",
    resourceUri: "fixture://synthetic/unlicensed-extra",
    operations: ["read"],
    maxRecords: 1,
  });
  assert(
    validateDefinition(extraRead, catalog).some((issue) =>
      issue.message.includes("covered by exactly one source binding"),
    ),
  );
});

test("a read-capable plugin cannot evade policy by declaring itself non-source", () => {
  const disguisedCatalog = structuredClone(catalog);
  disguisedCatalog["synthetic-source"]!.sourceAdapter = null;
  const issues = validateDefinition(definition(), disguisedCatalog);
  assert(
    issues.some((issue) =>
      issue.message.includes("must declare their exact source adapter"),
    ),
  );
  assert(
    issues.some((issue) =>
      issue.message.includes("not allowed for a non-source plugin"),
    ),
  );
});

test("source acquisition cannot consume and launder pipeline parents", () => {
  const launderingCatalog = structuredClone(catalog);
  launderingCatalog["synthetic-source"]!.inputs.parent = {
    ...recordsPort,
    required: false,
  };
  assert(
    validateDefinition(definition(), launderingCatalog).some((issue) =>
      issue.message.includes("use a transform stage"),
    ),
  );
});
