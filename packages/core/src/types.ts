export const PIPELINE_API_VERSION = "mapdata.pipeline/v1alpha1" as const;

export type PipelineMode = "validate" | "plan" | "preview" | "apply";

export type EffectClass =
  | "network.read"
  | "artifact.read"
  | "artifact.write"
  | "state.write"
  | "evidence.write"
  | "review.write"
  | "canonical.write"
  | "public.write";

export type ArtifactPolicy =
  | "required"
  | "derived_only"
  | "restricted"
  | "forbidden";

export interface SchemaRef {
  name: string;
  version: number;
}

export interface PortDeclaration {
  schema: SchemaRef;
  cardinality: "one" | "many";
  partitioning: "global" | "by_partition";
  ordering: "canonical" | "irrelevant";
  artifactPolicy: ArtifactPolicy;
  required?: boolean;
}

export interface PluginLock {
  packageName: string;
  packageVersion: string;
  pluginApiVersion: typeof PIPELINE_API_VERSION;
  integrity: string;
  executableDigest?: string;
  configSchema: SchemaRef;
  configSchemaDigest: string;
}

export interface StagePluginManifest {
  id: string;
  lock: PluginLock;
  inputs: Record<string, PortDeclaration>;
  outputs: Record<string, PortDeclaration>;
  policyBinding: "none" | "source";
  effects: EffectClass[];
  delivery: "none" | "verified_receipt";
  secretRefs?: string[];
}

export interface EffectRequestDeclaration {
  effectClass: EffectClass;
  resourceUri: string;
  operations: string[];
  maxRecords: number;
  verification?: "none" | "post_read";
}

export interface EffectAuthorization {
  profile: string;
  stageId: string;
  deploymentIdentity: string;
  effectClass: EffectClass;
  resourceUri: string;
  operations: string[];
  maxRecords: number;
  verification?: "none" | "post_read";
}

export interface ResourceReservation {
  admissionGroup: string;
  maxCpuUnits: number;
  maxRssBytes: number;
  maxChildProcesses: number;
  maxWallTimeMs: number;
  maxArtifactBytes: number;
  minFreeDiskBytes: number;
}

export interface StageDefinition {
  id: string;
  uses: string;
  inputs?: Record<string, string>;
  sourcePolicyIds?: string[];
  with?: Record<string, unknown>;
  resources: ResourceReservation;
  requestedEffects?: EffectRequestDeclaration[];
}

export interface PipelineDefinition {
  apiVersion: typeof PIPELINE_API_VERSION;
  kind: "Pipeline";
  metadata: {
    name: string;
    version: number;
  };
  profile: string;
  stages: StageDefinition[];
  requiredSinks: string[];
  optionalSinks: string[];
}

export interface DeploymentManifest {
  profile: string;
  deploymentIdentity: string;
  enabled: boolean;
  pluginLockDigest: string;
  targetContractVersion: number;
  targetContractDigest: string;
  effectAuthorizations: EffectAuthorization[];
  hostPolicyDigest: string;
  secretProvider: "test_stub" | "keychain" | "file" | "injected_environment";
}

export interface HostPolicyManifest {
  id: string;
  version: number;
  limits: {
    maxCpuUnits: number;
    maxRssBytes: number;
    maxChildProcesses: number;
    minFreeDiskBytes: number;
  };
  admissionGroups: Record<string, { maxConcurrency: number }>;
}

export interface RecordEnvelope<T = unknown> {
  sourceRecordKey: string;
  observationId: string;
  source: {
    name: string;
    namespace: string;
    externalId: string;
    retrievedAt: string;
    observedAt?: string;
    sourceUrl?: string;
    license?: string;
    attribution?: string;
  };
  schema: SchemaRef;
  partition: string;
  payload: T;
  lineage: Array<{
    runId: string;
    stageId: string;
    plugin: string;
    pluginVersion: string;
    inputArtifact?: string;
  }>;
}

export interface DatasetRef {
  kind: "artifact";
  artifactPolicy: Exclude<ArtifactPolicy, "forbidden">;
  manifestDigest: string;
  contentDigest: string;
  schema: SchemaRef;
  recordCount: number;
  uri: string;
}

export interface EphemeralDatasetHandle {
  kind: "ephemeral";
  artifactPolicy: "forbidden";
  brokerHandle: string;
  schema: SchemaRef;
}

export type DatasetHandle = DatasetRef | EphemeralDatasetHandle;

export interface DeliveryReceipt {
  idempotencyKey: string;
  payloadHash: string;
  targetVersion: string;
  outcome: "created" | "updated" | "no_op" | "conflict";
  verifiedAt: string;
}

export interface EffectRequest {
  effectClass: EffectClass;
  resourceUri: string;
  operation: string;
  recordCount: number;
}

export interface SourcePolicyDeclaration {
  id: string;
  adapter: string;
  namespace: string;
  artifactPolicy: ArtifactPolicy;
  authority: "discovery_only" | "official" | "review_decision";
  policyStatus: "pending" | "approved";
  termsRef: string | null;
  retentionDays: number | null;
  upstreamTermsRefs: string[];
  provisionalRetention: {
    postApprovalArtifactPolicy: Exclude<ArtifactPolicy, "forbidden">;
    rawMaxDays: number;
    derivedMaxDays: number;
    reviewEvidenceAfterTerminalDays: number;
    auditMetadata: "durable_minimal";
    upstreamTermsMode: "source" | "per_child";
  };
  allowedFields: string[];
  redistribution: "forbidden" | "approved";
}

interface ProfileBase {
  id: string;
  policyVersion: number;
  sources: SourcePolicyDeclaration[];
  targetContract: {
    ownerRepository: string;
    contractName: string;
    supportedVersions: number[];
    digest: string | null;
  };
  pluginLockDigest: string | null;
  invariants: string[];
}

export interface InertProfileDeclaration extends ProfileBase {
  deploymentEnabled: false;
  effectPolicy: [];
}

export interface EffectPolicy {
  stageId: string;
  effectClass: EffectClass;
  resourceUri: string;
  operations: string[];
  maxRecords: number;
  verification?: "none" | "post_read";
}

export interface ActiveProfileDeclaration extends ProfileBase {
  deploymentEnabled: true;
  pluginLockDigest: string;
  effectPolicy: EffectPolicy[];
  targetContract: ProfileBase["targetContract"] & { digest: string };
}

export type ProfileDeclaration =
  | InertProfileDeclaration
  | ActiveProfileDeclaration;
