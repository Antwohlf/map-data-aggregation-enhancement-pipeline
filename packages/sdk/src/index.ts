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
  quarantined?: DatasetRef;
}

/**
 * A plugin describes the operation it needs, but never supplies the quantity
 * used for authorization. The broker derives that value from broker-owned
 * dataset metadata or from the completed operation.
 */
export interface BrokerEffectRequest {
  effectClass: EffectClass;
  resourceUri: string;
  operation: string;
  subject?: DatasetHandle;
}

export interface StageBroker {
  requestEffect(request: BrokerEffectRequest): Promise<void>;
  finalizeArtifactAndCommitAcquisition(input: {
    dataset: DatasetRef;
    checkpointProposal: unknown;
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
