import assert from "node:assert/strict";
import test from "node:test";

import {
  ApplyNotReadyError,
  assertBrokerAuditDataset,
  assertApplyReady,
  computeDefinitionDigest,
  computeHostPolicyDigest,
  computePluginCatalogDigest,
  computeProfilePolicyDigest,
  createApplyAuthorizationContext,
} from "./readiness.js";
import {
  BROKER_AUDIT_FIELDS,
  BROKER_AUDIT_SCHEMA,
  PIPELINE_API_VERSION,
  type ActiveProfileDeclaration,
  type DatasetRef,
  type DeploymentManifest,
  type HostPolicyManifest,
  type PipelineDefinition,
  type SourcePolicyDeclaration,
  type SourceBinding,
  type StagePluginManifest,
} from "./types.js";

const contractDigest = `sha256:${"b".repeat(64)}`;
const resourceUri = "postgres://synthetic/projects";
const sourceSchema = { name: "synthetic.source.records", version: 1 };

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
    sourceAdapter: null,
    effects: ["canonical.write", "public.write"],
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
        {
          effectClass: "public.write",
          resourceUri: "postgres://synthetic/public-projects",
          operations: ["upsert"],
          maxRecords: 10,
          verification: "post_read",
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
      attributionRef: "synthetic:test-attribution",
      retentionDays: 0,
      resourceUris: [],
      allowedSchemas: [],
      upstreamTerms: [],
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
    {
      stageId: "sink",
      effectClass: "public.write",
      resourceUri: "postgres://synthetic/public-projects",
      operations: ["upsert"],
      maxRecords: 10,
      verification: "post_read",
    },
  ],
};

const deployment: DeploymentManifest = {
  profile: "synthetic-active",
  deploymentIdentity: "synthetic-apply-test",
  enabled: true,
  definitionDigest: computeDefinitionDigest(definition),
  profilePolicyDigest: computeProfilePolicyDigest(profile),
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
    {
      profile: "synthetic-active",
      stageId: "sink",
      deploymentIdentity: "synthetic-apply-test",
      effectClass: "public.write",
      resourceUri: "postgres://synthetic/public-projects",
      operations: ["upsert"],
      maxRecords: 10,
      verification: "post_read",
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
  assert.doesNotThrow(() => assertApplyReady(sourceBoundInputs()));
});

test("apply readiness rejects a deployment grant outside profile policy", () => {
  const changedProfile: ActiveProfileDeclaration = {
    ...profile,
    effectPolicy: [],
  };
  const changedDeployment = {
    ...deployment,
    profilePolicyDigest: computeProfilePolicyDigest(changedProfile),
  };
  assert.throws(
    () =>
      assertApplyReady({
        definition,
        catalog,
        profile: changedProfile,
        deployment: changedDeployment,
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

test("deployment pins the exact definition and profile policy", () => {
  const changedDefinition = structuredClone(definition);
  changedDefinition.metadata.version += 1;
  assert.throws(
    () =>
      assertApplyReady({
        definition: changedDefinition,
        catalog,
        profile,
        deployment,
        hostPolicy,
      }),
    ApplyNotReadyError,
  );

  const changedProfile = structuredClone(profile);
  changedProfile.policyVersion += 1;
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

test("authorization context snapshots verified host inputs", () => {
  const ready = sourceBoundInputs();
  const mutableCatalog = structuredClone(ready.catalog);
  const mutableDeployment = structuredClone(ready.deployment);
  const mutableHostPolicy = structuredClone(ready.hostPolicy);
  const context = createApplyAuthorizationContext({
    definition: structuredClone(ready.definition),
    catalog: mutableCatalog,
    profile: structuredClone(ready.profile),
    deployment: mutableDeployment,
    hostPolicy: mutableHostPolicy,
  });

  mutableCatalog["synthetic-write-sink"]!.effects = [];
  mutableDeployment.effectAuthorizations = [];
  mutableHostPolicy.limits.maxCpuUnits = 100;
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
    attributionRef: "policy:synthetic-attribution",
    retentionDays: 30,
    resourceUris: [sourceResourceUri],
    allowedSchemas: [sourceSchema],
    upstreamTerms: [],
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

function sourceBoundInputs(
  source: SourcePolicyDeclaration = approvedSource(),
  bindingOverrides: Partial<SourceBinding> = {},
) {
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
    outputs: {
      records: {
        schema: sourceSchema,
        cardinality: "many",
        partitioning: "by_partition",
        ordering: "canonical",
        artifactPolicy: source.artifactPolicy,
      },
    },
    sourceAdapter: source.adapter,
    effects: ["network.read"],
    delivery: "none",
  };
  const sinkManifest = structuredClone(catalog["synthetic-write-sink"]!);
  sinkManifest.inputs.records = sourceManifest.outputs.records!;
  sinkManifest.outputs.enriched = {
    ...sourceManifest.outputs.records!,
    schema: { name: "synthetic.enriched.records", version: 1 },
  };
  const sourceCatalog = {
    ...catalog,
    [sinkManifest.id]: sinkManifest,
    [sourceManifest.id]: sourceManifest,
  };
  const sourceDefinition = structuredClone(definition);
  sourceDefinition.stages[0]!.inputs = { records: "source.records" };
  sourceDefinition.stages.unshift({
    id: "source",
    uses: sourceManifest.id,
    sourceBindings: [
      {
        policyId: source.id,
        effectClass: "network.read",
        resourceUri: sourceResourceUri,
        operations: ["read"],
        outputPorts: ["records"],
        artifactClass: "raw",
        childIds: [],
        ...bindingOverrides,
      },
    ],
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
    attributionRef: null,
    retentionDays: null,
    resourceUris: [],
    allowedSchemas: [],
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
    definitionDigest: computeDefinitionDigest(sourceDefinition),
    profilePolicyDigest: computeProfilePolicyDigest(sourceProfile),
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

test("per-child terms cover every observed child exactly by identity", () => {
  const source = approvedSource({
    adapter: "all-the-places",
    artifactPolicy: "derived_only",
    retentionDays: 30,
    upstreamTerms: [
      { childId: "spider-a", termsRef: "policy:spider-a" },
      { childId: "spider-b", termsRef: "policy:spider-b" },
    ],
    provisionalRetention: {
      ...approvedSource().provisionalRetention,
      postApprovalArtifactPolicy: "derived_only",
      rawMaxDays: 0,
      upstreamTermsMode: "per_child",
    },
  });
  assert.doesNotThrow(() =>
    assertApplyReady(
      sourceBoundInputs(source, {
        artifactClass: "derived",
        childIds: ["spider-a", "spider-b"],
      }),
    ),
  );

  const missingTerms = structuredClone(source);
  missingTerms.upstreamTerms.pop();
  assert.throws(
    () =>
      assertApplyReady(
        sourceBoundInputs(missingTerms, {
          artifactClass: "derived",
          childIds: ["spider-a", "spider-b"],
        }),
      ),
    ApplyNotReadyError,
  );
  assert.throws(
    () =>
      assertApplyReady(
        sourceBoundInputs(source, {
          artifactClass: "derived",
          childIds: ["spider-a", "unknown-spider"],
        }),
      ),
    ApplyNotReadyError,
  );
});

test("all provisional ceilings are validated even when the binding uses another class", () => {
  for (const changedField of [
    "derivedMaxDays",
    "reviewEvidenceAfterTerminalDays",
  ] as const) {
    const source = approvedSource({
      provisionalRetention: {
        ...approvedSource().provisionalRetention,
        [changedField]: 31,
      },
    });
    assert.throws(
      () => assertApplyReady(sourceBoundInputs(source)),
      ApplyNotReadyError,
    );
  }
});

test("source adapter and policy resource must match the stage exactly", () => {
  const adapterMismatch = sourceBoundInputs();
  adapterMismatch.catalog["synthetic-network-source"]!.sourceAdapter = "arcgis";
  const changedDigest = computePluginCatalogDigest(adapterMismatch.catalog);
  adapterMismatch.profile.pluginLockDigest = changedDigest;
  adapterMismatch.deployment.pluginLockDigest = changedDigest;
  adapterMismatch.deployment.profilePolicyDigest = computeProfilePolicyDigest(
    adapterMismatch.profile,
  );
  assert.throws(
    () => assertApplyReady(adapterMismatch),
    ApplyNotReadyError,
  );

  const resourceMismatch = approvedSource({
    resourceUris: ["https://source.example.invalid/different"],
  });
  assert.throws(
    () => assertApplyReady(sourceBoundInputs(resourceMismatch)),
    ApplyNotReadyError,
  );
});

test("active profile source IDs and namespaces must remain unique", () => {
  const duplicateId = sourceBoundInputs();
  duplicateId.profile.sources.push({
    ...structuredClone(duplicateId.profile.sources[0]!),
    namespace: "duplicate-id-namespace",
  });
  duplicateId.deployment.profilePolicyDigest = computeProfilePolicyDigest(
    duplicateId.profile,
  );
  assert.throws(() => assertApplyReady(duplicateId), ApplyNotReadyError);

  const duplicateNamespace = sourceBoundInputs();
  duplicateNamespace.profile.sources.push({
    ...structuredClone(duplicateNamespace.profile.sources[0]!),
    id: "duplicate-namespace-id",
  });
  duplicateNamespace.deployment.profilePolicyDigest = computeProfilePolicyDigest(
    duplicateNamespace.profile,
  );
  assert.throws(
    () => assertApplyReady(duplicateNamespace),
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
  inputs.definition.stages[0]!.sourceBindings![0]!.policyId = "taco-osm-v1";
  inputs.deployment.definitionDigest = computeDefinitionDigest(inputs.definition);
  assert.throws(() => assertApplyReady(inputs), ApplyNotReadyError);
});

test("official website output is derived evidence, never a raw artifact", () => {
  const website = approvedSource({
    adapter: "official-website",
    artifactPolicy: "derived_only",
    provisionalRetention: {
      ...approvedSource().provisionalRetention,
      postApprovalArtifactPolicy: "derived_only",
      rawMaxDays: 0,
    },
  });
  assert.doesNotThrow(() =>
    assertApplyReady(
      sourceBoundInputs(website, { artifactClass: "derived" }),
    ),
  );
  assert.throws(
    () => assertApplyReady(sourceBoundInputs(website, { artifactClass: "raw" })),
    ApplyNotReadyError,
  );
  const durableLaundering = sourceBoundInputs(website, {
    artifactClass: "derived",
  });
  durableLaundering.definition.stages[0]!.sourceBindings![0]!.artifactClass =
    "audit_metadata" as never;
  durableLaundering.deployment.definitionDigest = computeDefinitionDigest(
    durableLaundering.definition,
  );
  assert.throws(
    () => assertApplyReady(durableLaundering),
    ApplyNotReadyError,
  );
});

function sourceDataset(
  inputs: ReturnType<typeof sourceBoundInputs>,
  source: SourcePolicyDeclaration,
): DatasetRef {
  const profilePolicyDigest = computeProfilePolicyDigest(inputs.profile);
  return {
    kind: "artifact",
    brokerHandle: "broker:artifact:1",
    artifactPolicy: source.artifactPolicy,
    artifactClass: inputs.definition.stages[0]!.sourceBindings![0]!.artifactClass,
    manifestDigest: `sha256:${"1".repeat(64)}`,
    contentDigest: `sha256:${"2".repeat(64)}`,
    schema: sourceSchema,
    fields: ["id"],
    recordCount: 1,
    uri: "artifact://sha256/example",
    retentionStartedAt: "2098-12-01T00:00:00.000Z",
    expiresAt: "2098-12-31T00:00:00.000Z",
    restrictions: {
      sourcePolicies: [
        {
          profileId: inputs.profile.id,
          profilePolicyVersion: inputs.profile.policyVersion,
          profilePolicyDigest,
          sourcePolicyId: source.id,
        },
      ],
      redistribution: source.redistribution,
      attributionRefs: [source.attributionRef!],
    },
    provenance: {
      kind: "source",
      producingStageId: "source",
      profileId: inputs.profile.id,
      profilePolicyVersion: inputs.profile.policyVersion,
      profilePolicyDigest,
      sourcePolicyId: source.id,
      sourceAdapter: source.adapter,
      effectClass: "network.read",
      resourceUri: sourceResourceUri,
      operations: ["read"],
      outputPort: "records",
      childIds: inputs.definition.stages[0]!.sourceBindings![0]!.childIds,
    },
  } as unknown as DatasetRef;
}

test("stage invocations pin the exact declared input-port handle set", () => {
  const source = approvedSource();
  const inputs = sourceBoundInputs(source);
  const sinkManifest = inputs.catalog["synthetic-write-sink"]!;
  sinkManifest.inputs.secondary = sinkManifest.inputs.records!;
  inputs.definition.stages[1]!.inputs!.secondary = "source.records";
  const pluginDigest = computePluginCatalogDigest(inputs.catalog);
  inputs.profile.pluginLockDigest = pluginDigest;
  inputs.deployment.pluginLockDigest = pluginDigest;
  inputs.deployment.definitionDigest = computeDefinitionDigest(inputs.definition);
  inputs.deployment.profilePolicyDigest = computeProfilePolicyDigest(inputs.profile);

  const context = createApplyAuthorizationContext(inputs);
  const parent = sourceDataset(inputs, source);
  assert.throws(
    () =>
      context.beginStageInvocation({
        runId: "run-exact-inputs",
        stageRunId: "stage-run-missing-input",
        stageId: "sink",
        inputs: { records: parent },
        registry: { verifyDataset: () => true },
      }),
    ApplyNotReadyError,
  );
  assert.doesNotThrow(() =>
    context.beginStageInvocation({
      runId: "run-exact-inputs",
      stageRunId: "stage-run-exact-inputs",
      stageId: "sink",
      inputs: { records: parent, secondary: parent },
      registry: { verifyDataset: () => true },
    }),
  );
  assert.throws(
    () =>
      context.beginStageInvocation({
        runId: "run-exact-inputs",
        stageRunId: "stage-run-extra-input",
        stageId: "sink",
        inputs: { records: parent, secondary: parent, extra: parent },
        registry: { verifyDataset: () => true },
      }),
    ApplyNotReadyError,
  );
  const wrongOutput = structuredClone(parent);
  wrongOutput.brokerHandle = "broker:artifact:wrong-output";
  if (wrongOutput.provenance.kind === "source") {
    wrongOutput.provenance.outputPort = "wrong";
  }
  assert.throws(
    () =>
      context.beginStageInvocation({
        runId: "run-exact-inputs",
        stageRunId: "stage-run-wrong-output",
        stageId: "sink",
        inputs: { records: parent, secondary: wrongOutput },
        registry: { verifyDataset: () => true },
      }),
    ApplyNotReadyError,
  );
});

test("authorization context validates broker provenance, registry, and policy snapshot", () => {
  const source = approvedSource();
  const inputs = sourceBoundInputs(source);
  const context = createApplyAuthorizationContext(inputs);
  const dataset = sourceDataset(inputs, source);
  const invocation = context.beginStageInvocation({
    runId: "run-source-output",
    stageRunId: "stage-run-source-output",
    stageId: "source",
    inputs: {},
    registry: { verifyDataset: () => true },
  });
  const validate = (candidate: DatasetRef, registered = true) =>
    context.validateStageOutputs({
      invocation,
      outputs: { records: candidate },
      registry: { verifyDataset: () => registered },
    });

  assert.doesNotThrow(() => validate(dataset));

  const mismatched = structuredClone(dataset);
  if (mismatched.provenance.kind === "source") {
    mismatched.provenance.resourceUri = "https://source.example.invalid/other";
  }
  assert.throws(() => validate(mismatched), ApplyNotReadyError);

  const overRetained = structuredClone(dataset);
  overRetained.expiresAt = "2099-01-01T00:00:00.000Z";
  assert.throws(() => validate(overRetained), ApplyNotReadyError);
  assert.throws(() => validate(dataset, false), ApplyNotReadyError);

  const wrongSchema = structuredClone(dataset);
  wrongSchema.schema = { name: "website.raw-body", version: 1 };
  assert.throws(() => validate(wrongSchema), ApplyNotReadyError);

  const unobservedChild = structuredClone(dataset);
  if (unobservedChild.provenance.kind === "source") {
    unobservedChild.provenance.childIds = ["undeclared-spider"];
  }
  assert.throws(() => validate(unobservedChild), ApplyNotReadyError);

  const crossProfileReplay = structuredClone(dataset);
  if (crossProfileReplay.provenance.kind === "source") {
    crossProfileReplay.provenance.profileId = "tacoboutmichigan";
  }
  crossProfileReplay.restrictions.sourcePolicies[0]!.profileId =
    "tacoboutmichigan";
  assert.throws(() => validate(crossProfileReplay), ApplyNotReadyError);

  assert.throws(
    () =>
      context.validateStageOutputs({
        invocation,
        outputs: { records: dataset, quarantine: dataset },
        registry: { verifyDataset: () => true },
      }),
    ApplyNotReadyError,
  );

  inputs.profile.sources[0]!.allowedFields = ["malicious-post-context-swap"];
  assert.doesNotThrow(() => validate(dataset));
});

test("producer and state writes require one-shot invocation-bound subjects", () => {
  const inputs = sourceBoundInputs();
  const sourceStage = inputs.definition.stages[0]!;
  const sourceManifest = inputs.catalog["synthetic-network-source"]!;
  const derivedStage = inputs.definition.stages[1]!;
  const derivedManifest = inputs.catalog["synthetic-write-sink"]!;
  const artifactResource = "artifact://synthetic/source-records";
  const derivedArtifactResource = "artifact://synthetic/enriched-records";
  const stateResource = "state://synthetic/checkpoints";
  sourceManifest.effects.push("artifact.write", "state.write");
  derivedManifest.effects.push("artifact.write");
  sourceStage.requestedEffects!.push(
    {
      effectClass: "artifact.write",
      resourceUri: artifactResource,
      operations: ["persist"],
      maxRecords: 10,
    },
    {
      effectClass: "state.write",
      resourceUri: stateResource,
      operations: ["commit"],
      maxRecords: 1,
    },
  );
  derivedStage.requestedEffects!.push({
    effectClass: "artifact.write",
    resourceUri: derivedArtifactResource,
    operations: ["persist"],
    maxRecords: 10,
  });
  inputs.profile.effectPolicy.push(
    {
      stageId: "source",
      effectClass: "artifact.write",
      resourceUri: artifactResource,
      operations: ["persist"],
      maxRecords: 10,
    },
    {
      stageId: "source",
      effectClass: "state.write",
      resourceUri: stateResource,
      operations: ["commit"],
      maxRecords: 1,
    },
    {
      stageId: "sink",
      effectClass: "artifact.write",
      resourceUri: derivedArtifactResource,
      operations: ["persist"],
      maxRecords: 10,
    },
  );
  inputs.deployment.effectAuthorizations.push(
    {
      profile: inputs.profile.id,
      stageId: "source",
      deploymentIdentity: inputs.deployment.deploymentIdentity,
      effectClass: "artifact.write",
      resourceUri: artifactResource,
      operations: ["persist"],
      maxRecords: 10,
    },
    {
      profile: inputs.profile.id,
      stageId: "source",
      deploymentIdentity: inputs.deployment.deploymentIdentity,
      effectClass: "state.write",
      resourceUri: stateResource,
      operations: ["commit"],
      maxRecords: 1,
    },
    {
      profile: inputs.profile.id,
      stageId: "sink",
      deploymentIdentity: inputs.deployment.deploymentIdentity,
      effectClass: "artifact.write",
      resourceUri: derivedArtifactResource,
      operations: ["persist"],
      maxRecords: 10,
    },
  );
  const pluginDigest = computePluginCatalogDigest(inputs.catalog);
  inputs.profile.pluginLockDigest = pluginDigest;
  inputs.deployment.pluginLockDigest = pluginDigest;
  inputs.deployment.definitionDigest = computeDefinitionDigest(inputs.definition);
  inputs.deployment.profilePolicyDigest = computeProfilePolicyDigest(inputs.profile);

  const context = createApplyAuthorizationContext(inputs);
  const invocation = context.beginStageInvocation({
    runId: "run-output-effects",
    stageRunId: "stage-run-output-effects",
    stageId: "source",
    inputs: {},
    registry: { verifyDataset: () => true },
  });
  const outputSubject = context.bindOutputMutationSubject({
    invocation,
    outputPort: "records",
    stagedArtifactHandle: "broker:staged:source-records",
    authoritativeRecordCount: 1,
  });
  const outputAttempt = {
    invocation,
    stageId: "source",
    effectClass: "artifact.write" as const,
    resourceUri: artifactResource,
    operation: "persist",
    subject: outputSubject,
  };
  assert.doesNotThrow(() =>
    context.authorizeEffect(outputAttempt, { verifyDataset: () => false }),
  );
  assert.throws(
    () => context.authorizeEffect(outputAttempt, { verifyDataset: () => true }),
    ApplyNotReadyError,
  );

  const stateSubject = context.bindStateMutationSubject({
    invocation,
    proposalDigest: `sha256:${"8".repeat(64)}`,
    authoritativeRecordCount: 1,
  });
  const stateAttempt = {
    invocation,
    stageId: "source",
    effectClass: "state.write" as const,
    resourceUri: stateResource,
    operation: "commit",
    subject: stateSubject,
  };
  assert.doesNotThrow(() =>
    context.authorizeEffect(stateAttempt, { verifyDataset: () => false }),
  );
  assert.throws(
    () => context.authorizeEffect(stateAttempt, { verifyDataset: () => true }),
    ApplyNotReadyError,
  );

  context.closeStageInvocation(invocation);
  assert.throws(
    () =>
      context.authorizeEffect(
        {
          invocation,
          stageId: "source",
          effectClass: "network.read",
          resourceUri: sourceResourceUri,
          operation: "read",
          authoritativeRecordCount: 1,
        },
        { verifyDataset: () => true },
      ),
    ApplyNotReadyError,
  );
  assert.throws(
    () =>
      context.beginStageInvocation({
        runId: "run-output-effects",
        stageRunId: "stage-run-output-effects",
        stageId: "source",
        inputs: {},
        registry: { verifyDataset: () => true },
      }),
    ApplyNotReadyError,
  );

  const parent = sourceDataset(inputs, inputs.profile.sources[0]!);
  const derivedInvocation = context.beginStageInvocation({
    runId: "run-output-effects",
    stageRunId: "stage-run-derived-output-effect",
    stageId: "sink",
    inputs: { records: parent },
    registry: { verifyDataset: () => true },
  });
  const derivedOutputSubject = context.bindOutputMutationSubject({
    invocation: derivedInvocation,
    outputPort: "enriched",
    stagedArtifactHandle: "broker:staged:enriched-records",
    authoritativeRecordCount: 1,
  });
  assert.doesNotThrow(() =>
    context.authorizeEffect(
      {
        invocation: derivedInvocation,
        stageId: "sink",
        effectClass: "artifact.write",
        resourceUri: derivedArtifactResource,
        operation: "persist",
        subject: derivedOutputSubject,
      },
      { verifyDataset: () => false },
    ),
  );
  context.closeStageInvocation(derivedInvocation);
});

test("derived outputs preserve ancestry, strictest expiry, and redistribution", () => {
  const source = approvedSource();
  const inputs = sourceBoundInputs(source);
  const context = createApplyAuthorizationContext(inputs);
  const parent = sourceDataset(inputs, source);
  const invocation = context.beginStageInvocation({
    runId: "run-derived-output",
    stageRunId: "stage-run-derived-output",
    stageId: "sink",
    inputs: { records: parent },
    registry: { verifyDataset: () => true },
  });
  const derived = {
    ...structuredClone(parent),
    brokerHandle: "broker:artifact:derived",
    artifactClass: "derived",
    schema: { name: "synthetic.enriched.records", version: 1 },
    provenance: {
      kind: "internal",
      producingStageId: "sink",
      outputPort: "enriched",
      parentHandles: [parent.brokerHandle],
    },
  } as DatasetRef;

  assert.doesNotThrow(() =>
    context.validateStageOutputs({
      invocation,
      outputs: { enriched: derived },
      registry: { verifyDataset: () => true },
    }),
  );
  const overRetained = structuredClone(derived);
  overRetained.expiresAt = "2099-01-01T00:00:00.000Z";
  assert.throws(
    () =>
      context.validateStageOutputs({
        invocation,
        outputs: { enriched: overRetained },
        registry: { verifyDataset: () => true },
      }),
    ApplyNotReadyError,
  );
  const lostAttribution = structuredClone(derived);
  lostAttribution.restrictions.attributionRefs = [];
  assert.throws(
    () =>
      context.validateStageOutputs({
        invocation,
        outputs: { enriched: lostAttribution },
        registry: { verifyDataset: () => true },
      }),
    ApplyNotReadyError,
  );

  assert.throws(
    () =>
      context.authorizeEffect(
        {
          invocation,
          stageId: "sink",
          effectClass: "public.write",
          resourceUri: "postgres://synthetic/public-projects",
          operation: "upsert",
          subject: derived,
        },
        { verifyDataset: () => true },
      ),
    ApplyNotReadyError,
  );

});

test("current frozen source policy overrides a forged approved aggregate", () => {
  const source = approvedSource({ redistribution: "forbidden" });
  const inputs = sourceBoundInputs(source);
  const context = createApplyAuthorizationContext(inputs);
  const dataset = sourceDataset(inputs, source);
  dataset.restrictions.redistribution = "approved";
  const invocation = context.beginStageInvocation({
    runId: "run-frozen-policy",
    stageRunId: "stage-run-frozen-policy",
    stageId: "sink",
    inputs: { records: dataset },
    registry: { verifyDataset: () => true },
  });
  assert.throws(
    () =>
      context.authorizeEffect(
        {
          invocation,
          stageId: "sink",
          effectClass: "public.write",
          resourceUri: "postgres://synthetic/public-projects",
          operation: "upsert",
          subject: dataset,
        },
        { verifyDataset: () => true },
      ),
    ApplyNotReadyError,
  );
});

test("public writes accept only registered redistribution-approved subjects", () => {
  const source = approvedSource({ redistribution: "approved" });
  const inputs = sourceBoundInputs(source);
  const context = createApplyAuthorizationContext(inputs);
  const dataset = sourceDataset(inputs, source);
  const invocation = context.beginStageInvocation({
    runId: "run-public-write",
    stageRunId: "stage-run-public-write",
    stageId: "sink",
    inputs: { records: dataset },
    registry: { verifyDataset: () => true },
  });
  assert.doesNotThrow(() =>
    context.authorizeEffect(
      {
        invocation,
        stageId: "sink",
        effectClass: "public.write",
        resourceUri: "postgres://synthetic/public-projects",
        operation: "upsert",
        subject: dataset,
      },
      { verifyDataset: () => true },
    ),
  );
  assert.throws(
    () =>
      context.authorizeEffect(
        {
          invocation,
          stageId: "sink",
          effectClass: "public.write",
          resourceUri: "postgres://synthetic/public-projects",
          operation: "upsert",
          subject: dataset,
        },
        { verifyDataset: () => false },
      ),
    ApplyNotReadyError,
  );

  const unrelated = structuredClone(dataset);
  unrelated.brokerHandle = "broker:artifact:unrelated";
  assert.throws(
    () =>
      context.authorizeEffect(
        {
          invocation,
          stageId: "sink",
          effectClass: "public.write",
          resourceUri: "postgres://synthetic/public-projects",
          operation: "upsert",
          subject: unrelated,
        },
        { verifyDataset: () => true },
      ),
    ApplyNotReadyError,
  );

  const malformedExpiry = structuredClone(dataset);
  malformedExpiry.expiresAt = "not-a-timestamp";
  assert.throws(
    () =>
      context.beginStageInvocation({
        runId: "run-public-write",
        stageRunId: "stage-run-malformed-expiry",
        stageId: "sink",
        inputs: { records: malformedExpiry },
        registry: { verifyDataset: () => true },
      }),
    ApplyNotReadyError,
  );

  const expired = structuredClone(dataset);
  expired.retentionStartedAt = "1999-12-01T00:00:00.000Z";
  expired.expiresAt = "1999-12-31T00:00:00.000Z";
  assert.throws(
    () =>
      context.beginStageInvocation({
        runId: "run-public-write",
        stageRunId: "stage-run-expired-input",
        stageId: "sink",
        inputs: { records: expired },
        registry: { verifyDataset: () => true },
      }),
    ApplyNotReadyError,
  );

  const crossProfile = structuredClone(dataset);
  crossProfile.restrictions.sourcePolicies[0]!.profileId = "another-profile";
  assert.throws(
    () =>
      context.beginStageInvocation({
        runId: "run-public-write",
        stageRunId: "stage-run-cross-profile",
        stageId: "sink",
        inputs: { records: crossProfile },
        registry: { verifyDataset: () => true },
      }),
    ApplyNotReadyError,
  );
});

test("only the fixed broker audit schema may be durable without expiry", () => {
  const audit = {
    kind: "artifact",
    brokerHandle: "broker:audit:1",
    artifactPolicy: "restricted",
    artifactClass: "audit_metadata",
    manifestDigest: `sha256:${"3".repeat(64)}`,
    contentDigest: `sha256:${"4".repeat(64)}`,
    schema: BROKER_AUDIT_SCHEMA,
    fields: [...BROKER_AUDIT_FIELDS],
    recordCount: 1,
    uri: "artifact://audit/1",
    retentionStartedAt: "2026-09-04T00:00:00.000Z",
    expiresAt: null,
    restrictions: {
      sourcePolicies: [],
      redistribution: "forbidden",
      attributionRefs: [],
    },
    provenance: {
      kind: "broker_audit",
      runId: "run-1",
      stageId: "source",
    },
  } as unknown as DatasetRef;
  assert.doesNotThrow(() =>
    assertBrokerAuditDataset({
      dataset: audit,
      registry: { verifyDataset: () => true },
    }),
  );
  const relabeledSource = structuredClone(audit);
  relabeledSource.schema = sourceSchema;
  relabeledSource.fields = ["id"];
  assert.throws(
    () =>
      assertBrokerAuditDataset({
        dataset: relabeledSource,
        registry: { verifyDataset: () => true },
      }),
    ApplyNotReadyError,
  );
});
