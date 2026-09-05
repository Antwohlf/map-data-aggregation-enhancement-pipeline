import type {
  DatasetHandle,
  DatasetRef,
  DeliveryReceipt,
  EffectClass,
  PipelineMode,
  InertProfileDeclaration,
  StagePluginManifest,
} from "@map-pipeline/core";

export interface StageInputs {
  [port: string]: DatasetHandle;
}

export interface StageResult {
  outputs: Record<string, DatasetHandle>;
  metrics: Record<string, number>;
  deliveryReceipts?: DeliveryReceipt[];
}

/**
 * A plugin describes the operation it needs, but never supplies the quantity
 * used for authorization. The broker derives that value from broker-owned
 * dataset metadata or from the completed operation.
 */
type ReadEffectClass = Extract<EffectClass, "network.read" | "artifact.read">;
type MutationEffectClass = Exclude<EffectClass, ReadEffectClass>;
type OutputEffectClass = Extract<
  MutationEffectClass,
  "artifact.write" | "evidence.write" | "review.write"
>;

export interface BrokerReadEffectRequest {
  effectClass: ReadEffectClass;
  resourceUri: string;
  operation: string;
}

export interface BrokerMutationEffectRequest {
  effectClass: Extract<MutationEffectClass, "canonical.write" | "public.write">;
  resourceUri: string;
  operation: string;
  subject: DatasetHandle;
}

declare const ACQUISITION_HANDLE: unique symbol;
declare const STAGED_ARTIFACT_HANDLE: unique symbol;

/** Opaque, registry-backed acquisition whose observed children are broker-owned. */
export interface BrokerAcquisitionHandle {
  readonly [ACQUISITION_HANDLE]: true;
  readonly kind: "broker_acquisition";
  readonly brokerHandle: string;
}

/** Opaque staged bytes and metadata inspected and registered by the broker. */
export interface BrokerStagedArtifactHandle {
  readonly [STAGED_ARTIFACT_HANDLE]: true;
  readonly kind: "broker_staged_artifact";
  readonly brokerHandle: string;
}

export interface StageBroker {
  /**
   * This facade is created for one active stage invocation. Plugins cannot
   * select or replay an authorization invocation on individual calls.
   */
  requestEffect(request: BrokerMutationEffectRequest): Promise<void>;
  /** Performs an authorized read and records its observed child identities. */
  acquire(request: BrokerReadEffectRequest): Promise<BrokerAcquisitionHandle>;
  /**
   * Inspects bytes at the authorized URI, derives schema/fields/digests/count,
   * and registers them against the acquisition and declared output port.
   */
  stageSourceArtifact(input: {
    acquisition: BrokerAcquisitionHandle;
    outputPort: string;
    artifactUri: string;
  }): Promise<BrokerStagedArtifactHandle>;
  /**
   * Finalizes bytes and returns a broker-owned dataset reference. The broker
   * resolves the stage's declared output binding, compares broker-observed
   * children to the policy, stamps provenance and expiry, then commits an
   * acquisition checkpoint atomically when supplied. Persistence and state
   * changes are authorized internally with separate one-shot capabilities.
   */
  finalizeSourceArtifactAndCommitAcquisition(input: {
    acquisition: BrokerAcquisitionHandle;
    stagedArtifact: BrokerStagedArtifactHandle;
    outputPort: string;
    checkpointProposal?: unknown;
  }): Promise<DatasetRef>;
  /**
   * Stages a transform/review output from the executor-owned invocation's
   * complete input map, deriving immutable ancestry plus the strictest expiry,
   * redistribution, and attribution restrictions.
   */
  stageDerivedArtifact(input: {
    outputPort: string;
    artifactUri: string;
  }): Promise<BrokerStagedArtifactHandle>;
  /** Persists the staged output through an internal one-shot output capability. */
  finalizeDerivedArtifact(input: {
    stagedArtifact: BrokerStagedArtifactHandle;
    outputPort: string;
  }): Promise<DatasetRef>;
  /**
   * Performs an output-producing write through a one-shot capability that the
   * broker binds internally to this invocation, output port, and staged bytes.
   */
  commitStagedOutput(input: {
    stagedArtifact: BrokerStagedArtifactHandle;
    outputPort: string;
    effectClass: OutputEffectClass;
    resourceUri: string;
    operation: string;
  }): Promise<DatasetRef>;
  /**
   * Hashes and commits a checkpoint/state proposal through a one-shot
   * invocation-bound state capability.
   */
  commitState(input: {
    proposal: unknown;
    resourceUri: string;
    operation: string;
  }): Promise<void>;
}

export interface StageContext {
  runId: string;
  stageRunId: string;
  profile: string;
  partition: string;
  mode: PipelineMode;
  signal: AbortSignal;
  broker: StageBroker;
  /** Declared identifiers only. Resolved secret values are never in context. */
  declaredSecretRefs: readonly string[];
}

export interface StagePlugin<Config = unknown> {
  manifest: StagePluginManifest;
  run(
    context: StageContext,
    inputs: StageInputs,
    config: Config,
  ): Promise<StageResult>;
}

export function definePlugin<Config>(
  plugin: StagePlugin<Config>,
): StagePlugin<Config> {
  return plugin;
}

function freezeRecursively<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      freezeRecursively(child);
    }
    Object.freeze(value);
  }
  return value;
}

export function defineInertProfile(
  profile: InertProfileDeclaration,
): InertProfileDeclaration {
  const safeProfile = structuredClone(profile);
  if (
    safeProfile.deploymentEnabled !== false ||
    safeProfile.effectPolicy.length ||
    safeProfile.pluginLockDigest !== null
  ) {
    throw new TypeError("Scaffold profiles must be deployment-disabled");
  }
  const sourceIds = new Set<string>();
  const namespaces = new Set<string>();
  for (const source of safeProfile.sources) {
    if (!source.id || !source.namespace) {
      throw new TypeError("Profile source IDs and namespaces must not be empty");
    }
    if (sourceIds.has(source.id) || namespaces.has(source.namespace)) {
      throw new TypeError("Profile source IDs and namespaces must be unique");
    }
    sourceIds.add(source.id);
    namespaces.add(source.namespace);
    if (source.policyStatus !== "pending") {
      throw new TypeError("Inert scaffold source policies must remain pending");
    }
    if (
      source.artifactPolicy !== "forbidden" ||
      source.retentionDays !== null ||
      source.termsRef !== null ||
      source.attributionRef !== null ||
      source.resourceUris.length > 0 ||
      source.allowedSchemas.length > 0 ||
      source.upstreamTerms.length > 0 ||
      source.allowedFields.length > 0 ||
      source.redistribution !== "forbidden"
    ) {
      throw new TypeError("Inert scaffold sources must remain fail-closed");
    }
    for (const [name, days] of Object.entries({
      rawMaxDays: source.provisionalRetention.rawMaxDays,
      derivedMaxDays: source.provisionalRetention.derivedMaxDays,
      reviewEvidenceAfterTerminalDays:
        source.provisionalRetention.reviewEvidenceAfterTerminalDays,
    })) {
      if (!Number.isSafeInteger(days) || days < 0 || days > 30) {
        throw new TypeError(`${name} must be within the provisional 30-day ceiling`);
      }
    }
    if (
      source.adapter === "official-website" &&
      source.provisionalRetention.rawMaxDays !== 0
    ) {
      throw new TypeError("Official website raw retention must remain zero");
    }
  }
  return freezeRecursively(safeProfile);
}
