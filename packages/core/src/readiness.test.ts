import assert from "node:assert/strict";
import test from "node:test";

import {
  ApplyNotReadyError,
  assertApplyReady,
  computeHostPolicyDigest,
  computePluginCatalogDigest,
  createApplyAuthorizationContext,
} from "./readiness.js";
import {
  PIPELINE_API_VERSION,
  type ActiveProfileDeclaration,
  type DeploymentManifest,
  type HostPolicyManifest,
  type PipelineDefinition,
  type SourcePolicyDeclaration,
  type StagePluginManifest,
} from "./types.js";

const contractDigest = `sha256:${"b".repeat(64)}`;
const resourceUri = "postgres://synthetic/projects";

const catalog: Record<string, StagePluginManifest> = {
  "synthetic-write-sink": {
    id: "synthetic-write-sink",
    lock: {
      packageName: "@map-pipeline/synthetic-write-sink",
      packageVersion: "0.0.0-test",
      pluginApiVersion: PIPELINE_API_VERSION,
      integrity: `sha256:${"c".repeat(64)}`,
      configSchema: { name: "synthetic.write.config", version: 1 },
      configSchemaDigest: `sha256:${"d".repeat(64)}`,
    },
    inputs: {},
    outputs: {},
    policyBinding: "none",
    effects: ["canonical.write"],
    delivery: "verified_receipt",
  },
};

const pluginLockDigest = computePluginCatalogDigest(catalog);

const definition: PipelineDefinition = {
  apiVersion: PIPELINE_API_VERSION,
  kind: "Pipeline",
  metadata: { name: "synthetic-apply", version: 1 },
  profile: "synthetic-active",
  stages: [
    {
      id: "sink",
      uses: "synthetic-write-sink",
      resources: {
        admissionGroup: "database-write",
        maxCpuUnits: 1,
        maxRssBytes: 1_000_000,
        maxChildProcesses: 0,
        maxWallTimeMs: 30_000,
        maxArtifactBytes: 0,
        minFreeDiskBytes: 1_000_000,
      },
      requestedEffects: [
        {
          effectClass: "canonical.write",
          resourceUri,
          operations: ["upsert"],
          maxRecords: 10,
        },
      ],
    },
  ],
  requiredSinks: ["sink"],
  optionalSinks: [],
};

const profile: ActiveProfileDeclaration = {
  id: "synthetic-active",
  policyVersion: 1,
  deploymentEnabled: true,
  pluginLockDigest,
  sources: [
    {
      id: "synthetic-source-v1",
      adapter: "files",
      namespace: "synthetic",
      artifactPolicy: "forbidden",
      authority: "official",
      policyStatus: "approved",
      termsRef: "synthetic:test-only",
      retentionDays: 0,
      upstreamTermsRefs: [],
      provisionalRetention: {
        postApprovalArtifactPolicy: "derived_only",
        rawMaxDays: 0,
        derivedMaxDays: 30,
        reviewEvidenceAfterTerminalDays: 30,
        auditMetadata: "durable_minimal",
        upstreamTermsMode: "source",
      },
      allowedFields: ["id"],
      redistribution: "approved",
    },
  ],
  targetContract: {
    ownerRepository: "synthetic",
    contractName: "synthetic-write-contract",
    supportedVersions: [1],
    digest: contractDigest,
  },
  invariants: [],
  effectPolicy: [
    {
      stageId: "sink",
      effectClass: "canonical.write",
      resourceUri,
      operations: ["upsert"],
      maxRecords: 10,
    },
  ],
};

const deployment: DeploymentManifest = {
  profile: "synthetic-active",
  deploymentIdentity: "synthetic-apply-test",
  enabled: true,
  pluginLockDigest,
  targetContractVersion: 1,
  targetContractDigest: contractDigest,
  effectAuthorizations: [
    {
      profile: "synthetic-active",
      stageId: "sink",
      deploymentIdentity: "synthetic-apply-test",
      effectClass: "canonical.write",
      resourceUri,
      operations: ["upsert"],
      maxRecords: 10,
    },
  ],
  hostPolicyDigest: "",
  secretProvider: "keychain",
};

const hostPolicy: HostPolicyManifest = {
  id: "synthetic-test-host",
  version: 1,
  limits: {
    maxCpuUnits: 2,
    maxRssBytes: 2_000_000,
    maxChildProcesses: 1,
    minFreeDiskBytes: 1_000_000,
  },
  admissionGroups: { "database-write": { maxConcurrency: 1 } },
};

deployment.hostPolicyDigest = computeHostPolicyDigest(hostPolicy);

test("apply readiness joins definition, profile, lock, contract, and deployment", () => {
  assert.doesNotThrow(() =>
    assertApplyReady({
      definition,
      catalog,
      profile,
      deployment,
      hostPolicy,
    }),
  );
});

test("apply readiness rejects a deployment grant outside profile policy", () => {
  const changedProfile: ActiveProfileDeclaration = {
    ...profile,
    effectPolicy: [],
  };
  assert.throws(
    () =>
      assertApplyReady({
        definition,
        catalog,
        profile: changedProfile,
        deployment,
        hostPolicy,
      }),
    ApplyNotReadyError,
  );
});

test("apply readiness computes the catalog digest rather than trusting a claim", () => {
  const tamperedCatalog = structuredClone(catalog);
  tamperedCatalog["synthetic-write-sink"]!.lock.packageVersion = "tampered";
  assert.throws(
    () =>
      assertApplyReady({
        definition,
        catalog: tamperedCatalog,
        profile,
        deployment,
        hostPolicy,
      }),
    ApplyNotReadyError,
  );
});

test("authorization context snapshots verified inputs", () => {
  const mutableCatalog = structuredClone(catalog);
  const mutableDeployment = structuredClone(deployment);
  const mutableHostPolicy = structuredClone(hostPolicy);
  const context = createApplyAuthorizationContext({
    definition: structuredClone(definition),
    catalog: mutableCatalog,
    profile: structuredClone(profile),
    deployment: mutableDeployment,
    hostPolicy: mutableHostPolicy,
  });

  mutableCatalog["synthetic-write-sink"]!.effects = [];
  mutableDeployment.effectAuthorizations = [];
  mutableHostPolicy.limits.maxCpuUnits = 100;
  assert.doesNotThrow(() =>
    context.authorizeEffect({
      stageId: "sink",
      effectClass: "canonical.write",
      resourceUri,
      operation: "upsert",
      authoritativeRecordCount: 10,
    }),
  );
  assert.throws(() =>
    context.authorizeEffect({
      stageId: "sink",
      effectClass: "canonical.write",
      resourceUri,
      operation: "upsert",
      authoritativeRecordCount: 11,
    }),
  );
  assert.equal(
    context.evaluateAdmission({
      active: [],
      candidate: {
        admissionGroup: "database-write",
        maxCpuUnits: 3,
        maxRssBytes: 1,
        maxChildProcesses: 0,
        maxWallTimeMs: 1,
        maxArtifactBytes: 0,
        minFreeDiskBytes: 1,
      },
      observedFreeDiskBytes: 1_000_000,
    }).admitted,
    false,
  );
  assert(Object.isFrozen(context));
});

const sourceResourceUri = "https://source.example.invalid/records";

function approvedSource(
  overrides: Partial<SourcePolicyDeclaration> = {},
): SourcePolicyDeclaration {
  return {
    id: "apizza-osm-v1",
    adapter: "osm",
    namespace: "openstreetmap",
    artifactPolicy: "required",
    authority: "discovery_only",
    policyStatus: "approved",
    termsRef: "policy:synthetic-source-review",
    retentionDays: 30,
    upstreamTermsRefs: [],
    provisionalRetention: {
      postApprovalArtifactPolicy: "required",
      rawMaxDays: 30,
      derivedMaxDays: 30,
      reviewEvidenceAfterTerminalDays: 30,
      auditMetadata: "durable_minimal",
      upstreamTermsMode: "source",
    },
    allowedFields: ["id"],
    redistribution: "forbidden",
    ...overrides,
  };
}

function sourceBoundInputs(source: SourcePolicyDeclaration = approvedSource()) {
  const sourceManifest: StagePluginManifest = {
    id: "synthetic-network-source",
    lock: {
      packageName: "@map-pipeline/synthetic-network-source",
      packageVersion: "0.0.0-test",
      pluginApiVersion: PIPELINE_API_VERSION,
      integrity: `sha256:${"e".repeat(64)}`,
      configSchema: { name: "synthetic.network.config", version: 1 },
      configSchemaDigest: `sha256:${"f".repeat(64)}`,
    },
    inputs: {},
    outputs: {},
    policyBinding: "source",
    effects: ["network.read"],
    delivery: "none",
  };
  const sourceCatalog = { ...catalog, [sourceManifest.id]: sourceManifest };
  const sourceDefinition = structuredClone(definition);
  sourceDefinition.stages.unshift({
    id: "source",
    uses: sourceManifest.id,
    sourcePolicyIds: [source.id],
    resources: {
      admissionGroup: "source-read",
      maxCpuUnits: 1,
      maxRssBytes: 1,
      maxChildProcesses: 0,
      maxWallTimeMs: 1,
      maxArtifactBytes: 0,
      minFreeDiskBytes: 1,
    },
    requestedEffects: [
      {
        effectClass: "network.read",
        resourceUri: sourceResourceUri,
        operations: ["read"],
        maxRecords: 10,
      },
    ],
  });
  const pendingUnrelated = approvedSource({
    id: "apizza-fsq-v1",
    adapter: "process",
    namespace: "foursquare",
    artifactPolicy: "forbidden",
    policyStatus: "pending",
    termsRef: null,
    retentionDays: null,
    allowedFields: [],
  });
  const sourceProfile: ActiveProfileDeclaration = {
    ...structuredClone(profile),
    pluginLockDigest: computePluginCatalogDigest(sourceCatalog),
    sources: [source, pendingUnrelated],
    effectPolicy: [
      ...profile.effectPolicy,
      {
        stageId: "source",
        effectClass: "network.read",
        resourceUri: sourceResourceUri,
        operations: ["read"],
        maxRecords: 10,
      },
    ],
  };
  const sourceHostPolicy = structuredClone(hostPolicy);
  sourceHostPolicy.admissionGroups["source-read"] = { maxConcurrency: 1 };
  const sourceDeployment: DeploymentManifest = {
    ...structuredClone(deployment),
    pluginLockDigest: sourceProfile.pluginLockDigest,
    hostPolicyDigest: computeHostPolicyDigest(sourceHostPolicy),
    effectAuthorizations: [
      ...deployment.effectAuthorizations,
      {
        profile: sourceProfile.id,
        stageId: "source",
        deploymentIdentity: deployment.deploymentIdentity,
        effectClass: "network.read",
        resourceUri: sourceResourceUri,
        operations: ["read"],
        maxRecords: 10,
      },
    ],
  };
  return {
    definition: sourceDefinition,
    catalog: sourceCatalog,
    profile: sourceProfile,
    deployment: sourceDeployment,
    hostPolicy: sourceHostPolicy,
  };
}

test("only source policies referenced by this pipeline must be approved", () => {
  assert.doesNotThrow(() => assertApplyReady(sourceBoundInputs()));
});

test("referenced pending, over-retained, and unlicensed-child sources fail", () => {
  assert.throws(
    () =>
      assertApplyReady(
        sourceBoundInputs(
          approvedSource({
            policyStatus: "pending",
            termsRef: null,
            retentionDays: null,
            artifactPolicy: "forbidden",
            allowedFields: [],
          }),
        ),
      ),
    ApplyNotReadyError,
  );
  assert.throws(
    () => assertApplyReady(sourceBoundInputs(approvedSource({ retentionDays: 31 }))),
    ApplyNotReadyError,
  );
  assert.throws(
    () =>
      assertApplyReady(
        sourceBoundInputs(
          approvedSource({
            adapter: "files",
            provisionalRetention: {
              ...approvedSource().provisionalRetention,
              upstreamTermsMode: "per_child",
            },
          }),
        ),
      ),
    ApplyNotReadyError,
  );
});

test("website raw retention and cross-profile source IDs fail closed", () => {
  assert.throws(
    () =>
      assertApplyReady(
        sourceBoundInputs(
          approvedSource({ adapter: "official-website" }),
        ),
      ),
    ApplyNotReadyError,
  );
  const inputs = sourceBoundInputs();
  inputs.definition.stages[0]!.sourcePolicyIds = ["taco-osm-v1"];
  assert.throws(() => assertApplyReady(inputs), ApplyNotReadyError);
});
