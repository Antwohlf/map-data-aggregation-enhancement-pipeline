import { randomUUID } from "node:crypto";

import {
  assertPreviewEffectAuthorized,
  canonicalize,
  digest,
  evaluateAdmission,
  validateDefinition,
  type ArtifactCommitMetadata,
  type CanonicalJson,
  type CanonicalJsonValidator,
  type CommittedJsonArtifact,
  type DatasetHandle,
  type DatasetProvenance,
  type DatasetRef,
  type DatasetRestrictions,
  type DatasetRegistryVerifier,
  type DeliveryReceipt,
  type EffectAuthorization,
  type EphemeralDatasetHandle,
  type HostPolicyManifest,
  type JsonArtifactStore,
  type PipelineDefinition,
  type ResourceReader,
  type RunStateStore,
  type SchemaRef,
  type StageDefinition,
  type StagePluginManifest,
  type StagedJsonArtifact,
  type SourceSnapshotDescriptor,
} from "@map-pipeline/core";
import type {
  BrokerAcquisitionHandle,
  BrokerDeliveryReceipt,
  BrokerMutationEffectRequest,
  BrokerReadEffectRequest,
  BrokerStagedArtifactHandle,
  StageBroker,
  StagePlugin,
  StageResult,
} from "@map-pipeline/sdk";

export class PreviewExecutionError extends Error {
  override readonly name = "PreviewExecutionError";
}

interface RegisteredArtifactDataset {
  kind: "artifact";
  dataset: DatasetRef;
  artifact: CommittedJsonArtifact;
  fingerprint: string;
}

interface RegisteredEphemeralDataset {
  kind: "ephemeral";
  dataset: EphemeralDatasetHandle;
  value: CanonicalJson;
  expiresAt: string;
  restrictions: DatasetRestrictions;
  provenance: DatasetProvenance;
  remainingConsumers: number;
  fingerprint: string;
}

type RegisteredDataset = RegisteredArtifactDataset | RegisteredEphemeralDataset;

class PreviewDatasetRegistry implements DatasetRegistryVerifier {
  readonly #datasets = new Map<string, RegisteredDataset>();

  register(dataset: DatasetRef, artifact: CommittedJsonArtifact): void {
    if (this.#datasets.has(dataset.brokerHandle)) {
      throw new PreviewExecutionError(`Duplicate dataset handle ${dataset.brokerHandle}`);
    }
    this.#datasets.set(dataset.brokerHandle, {
      kind: "artifact",
      dataset,
      artifact,
      fingerprint: canonicalize(JSON.parse(JSON.stringify(dataset)) as CanonicalJson),
    });
  }

  registerEphemeral(
    dataset: EphemeralDatasetHandle,
    value: CanonicalJson,
    metadata: {
      expiresAt: string;
      restrictions: DatasetRestrictions;
      provenance: DatasetProvenance;
      remainingConsumers: number;
    },
  ): void {
    if (this.#datasets.has(dataset.brokerHandle)) {
      throw new PreviewExecutionError(`Duplicate dataset handle ${dataset.brokerHandle}`);
    }
    if (!Number.isSafeInteger(metadata.remainingConsumers) || metadata.remainingConsumers <= 0) {
      throw new PreviewExecutionError("Ephemeral dataset requires a positive consumer count");
    }
    this.#datasets.set(dataset.brokerHandle, {
      kind: "ephemeral",
      dataset,
      value,
      expiresAt: metadata.expiresAt,
      restrictions: metadata.restrictions,
      provenance: metadata.provenance,
      remainingConsumers: metadata.remainingConsumers,
      fingerprint: canonicalize(JSON.parse(JSON.stringify(dataset)) as CanonicalJson),
    });
  }

  verifyDataset(dataset: DatasetHandle): boolean {
    const registered = this.#datasets.get(dataset.brokerHandle);
    if (!registered || dataset.kind !== registered.kind) return false;
    return registered.fingerprint ===
      canonicalize(JSON.parse(JSON.stringify(dataset)) as CanonicalJson);
  }

  artifactFor(dataset: DatasetHandle): CommittedJsonArtifact {
    const registered = this.#datasets.get(dataset.brokerHandle);
    if (!this.verifyDataset(dataset) || registered?.kind !== "artifact") {
      throw new PreviewExecutionError("Dataset is not registered by this preview run");
    }
    return registered.artifact;
  }

  valueFor(dataset: DatasetHandle): CanonicalJson | undefined {
    const registered = this.#datasets.get(dataset.brokerHandle);
    if (!this.verifyDataset(dataset) || registered?.kind !== "ephemeral") return undefined;
    return structuredClone(registered.value);
  }

  lineageFor(dataset: DatasetHandle): {
    expiresAt: string;
    restrictions: DatasetRestrictions;
    provenance: DatasetProvenance;
  } {
    const registered = this.#datasets.get(dataset.brokerHandle);
    if (!this.verifyDataset(dataset) || !registered) {
      throw new PreviewExecutionError("Dataset is not registered by this preview run");
    }
    if (registered.kind === "artifact") {
      if (!registered.dataset.expiresAt) {
        throw new PreviewExecutionError("Preview data parents must expire");
      }
      return {
        expiresAt: registered.dataset.expiresAt,
        restrictions: registered.dataset.restrictions,
        provenance: registered.dataset.provenance,
      };
    }
    return {
      expiresAt: registered.expiresAt,
      restrictions: registered.restrictions,
      provenance: registered.provenance,
    };
  }

  releaseConsumed(inputs: readonly DatasetHandle[]): void {
    for (const input of inputs) {
      const registered = this.#datasets.get(input.brokerHandle);
      if (!registered || registered.kind !== "ephemeral") continue;
      registered.remainingConsumers -= 1;
      if (registered.remainingConsumers < 0) {
        throw new PreviewExecutionError("Ephemeral dataset consumer accounting underflowed");
      }
      if (registered.remainingConsumers === 0) {
        this.#datasets.delete(input.brokerHandle);
      }
    }
  }

  clearEphemeral(): void {
    for (const [handle, registered] of this.#datasets) {
      if (registered.kind === "ephemeral") this.#datasets.delete(handle);
    }
  }
}

interface AcquisitionEntry {
  request: BrokerReadEffectRequest;
  value: CanonicalJson;
  recordCount: number;
  observedChildIds: string[];
  schema: { name: string; version: number };
  snapshot: SourceSnapshotDescriptor;
  status: "open" | "finalizing" | "finalized" | "failed";
}

interface StagedEntry {
  staged: StagedJsonArtifact;
  outputPort: string;
  sourceAcquisitionHandle: string | null;
  status: "open" | "finalizing" | "finalized" | "failed";
}

function recordCount(value: CanonicalJson): number {
  if (Array.isArray(value)) return value.length;
  if (value === null) return 0;
  if (typeof value === "object") {
    const wrapped = ["records", "rows", "places", "features"]
      .map((field) => value[field])
      .filter(Array.isArray);
    if (wrapped.length > 1) {
      throw new PreviewExecutionError("Dataset has multiple recognized record arrays");
    }
    if (wrapped[0]) return wrapped[0].length;
  }
  return 1;
}

function digestObject(value: unknown): string {
  return digest(JSON.parse(JSON.stringify(value)) as CanonicalJson);
}

function schemaKey(schema: { name: string; version: number }): string {
  return `${schema.name}@${schema.version}`;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isCanonicalJson(value: unknown): value is CanonicalJson {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) return true;
  if (Array.isArray(value)) return value.every(isCanonicalJson);
  if (typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) &&
    Object.values(value).every(isCanonicalJson);
}

function validateSnapshotDescriptor(snapshot: SourceSnapshotDescriptor): void {
  const capturedAtValid = snapshot.capturedAt === null ||
    (typeof snapshot.capturedAt === "string" &&
      !Number.isNaN(Date.parse(snapshot.capturedAt)) &&
      new Date(snapshot.capturedAt).toISOString() === snapshot.capturedAt);
  const cursorSchemaValid = snapshot.cursorSchema === null || (
    typeof snapshot.cursorSchema?.name === "string" &&
    Boolean(snapshot.cursorSchema.name) &&
    Number.isSafeInteger(snapshot.cursorSchema.version) &&
    snapshot.cursorSchema.version > 0
  );
  if (
    typeof snapshot.snapshotId !== "string" ||
    !snapshot.snapshotId ||
    snapshot.snapshotId.trim() !== snapshot.snapshotId ||
    (snapshot.sourceInstanceDigest !== null &&
      !/^sha256:[a-f0-9]{64}$/.test(snapshot.sourceInstanceDigest)) ||
    !/^sha256:[a-f0-9]{64}$/.test(snapshot.readerBindingDigest) ||
    !capturedAtValid ||
    !["immutable", "repeatable_read"].includes(snapshot.consistency) ||
    !cursorSchemaValid ||
    !isCanonicalJson(snapshot.startExclusive) ||
    !isCanonicalJson(snapshot.endInclusive) ||
    snapshot.complete !== true ||
    typeof snapshot.contractName !== "string" ||
    !snapshot.contractName ||
    !Number.isSafeInteger(snapshot.contractVersion) ||
    snapshot.contractVersion < 1 ||
    !/^sha256:[a-f0-9]{64}$/.test(snapshot.contractDigest)
  ) {
    throw new PreviewExecutionError("Reader returned invalid source snapshot metadata");
  }
}

function sameSchemaOrNull(left: SchemaRef | null, right: SchemaRef | null): boolean {
  return left === null
    ? right === null
    : right !== null && left.name === right.name && left.version === right.version;
}

function freezeRecursively<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeRecursively(child);
    Object.freeze(value);
  }
  return value;
}

class PreviewStageBroker implements StageBroker {
  readonly #definition: PipelineDefinition;
  readonly #stage: StageDefinition;
  readonly #manifest: StagePluginManifest;
  readonly #artifactStore: JsonArtifactStore;
  readonly #registry: PreviewDatasetRegistry;
  readonly #readers: Readonly<Record<string, ResourceReader>>;
  readonly #schemaValidators: Readonly<Record<string, CanonicalJsonValidator>>;
  readonly #signal: AbortSignal;
  readonly #partition: string;
  readonly #deploymentIdentity: string;
  readonly #runtimePolicyDigest: string;
  readonly #runtimeClass: "fixture_preview" | "read_only_shadow";
  readonly #shadowSourceReadGrants: readonly ShadowSourceReadGrant[];
  readonly #grants: EffectAuthorization[];
  readonly #inputs: Readonly<Record<string, DatasetHandle>>;
  readonly #acquisitions = new Map<string, AcquisitionEntry>();
  readonly #staged = new Map<string, StagedEntry>();
  readonly #claimedOutputPorts = new Set<string>();
  readonly #finalizedOutputs = new Map<string, string>();
  readonly #effectRecordCounts = new Map<string, number>();
  readonly #receipts = new WeakMap<object, {
    outputHandle: string;
    outputPort: string;
    fingerprint: string;
  }>();
  #artifactBytes = 0;
  #stagingInProgress = false;
  #closed = false;
  #activeOperations = 0;
  #drainResolver: (() => void) | null = null;
  #closePromise: Promise<void> | null = null;

  constructor(input: {
    definition: PipelineDefinition;
    stage: StageDefinition;
    catalog: Readonly<Record<string, StagePluginManifest>>;
    artifactStore: JsonArtifactStore;
    registry: PreviewDatasetRegistry;
    readers: Readonly<Record<string, ResourceReader>>;
    schemaValidators: Readonly<Record<string, CanonicalJsonValidator>>;
    signal: AbortSignal;
    partition: string;
    deploymentIdentity: string;
    runtimePolicyDigest: string;
    runtimeClass: "fixture_preview" | "read_only_shadow";
    shadowSourceReadGrants: readonly ShadowSourceReadGrant[];
    inputs: Readonly<Record<string, DatasetHandle>>;
  }) {
    this.#definition = input.definition;
    this.#stage = input.stage;
    this.#manifest = input.catalog[input.stage.uses]!;
    this.#artifactStore = input.artifactStore;
    this.#registry = input.registry;
    this.#readers = input.readers;
    this.#schemaValidators = input.schemaValidators;
    this.#signal = input.signal;
    this.#partition = input.partition;
    this.#deploymentIdentity = input.deploymentIdentity;
    this.#runtimePolicyDigest = input.runtimePolicyDigest;
    this.#runtimeClass = input.runtimeClass;
    this.#shadowSourceReadGrants = input.shadowSourceReadGrants;
    this.#inputs = Object.freeze({ ...input.inputs });
    this.#grants = (input.stage.requestedEffects ?? []).map((request) => ({
      profile: input.definition.profile,
      stageId: input.stage.id,
      deploymentIdentity: input.deploymentIdentity,
      ...request,
    }));
  }

  #assertOpen(): void {
    if (this.#closed) throw new PreviewExecutionError("Stage broker is closed");
    if (this.#signal.aborted) throw this.#signal.reason;
  }

  async #track<T>(operation: () => Promise<T>): Promise<T> {
    this.#assertOpen();
    this.#activeOperations += 1;
    try {
      const result = await operation();
      this.#assertOpen();
      return result;
    } finally {
      this.#activeOperations -= 1;
      if (this.#activeOperations === 0 && this.#drainResolver) {
        const resolveDrain = this.#drainResolver;
        this.#drainResolver = null;
        resolveDrain();
      }
    }
  }

  async #drain(): Promise<void> {
    if (this.#activeOperations === 0) return;
    await new Promise<void>((resolve) => {
      this.#drainResolver = resolve;
    });
  }

  #authorize(input: {
    effectClass: EffectAuthorization["effectClass"];
    resourceUri: string;
    operation: string;
    recordCount: number;
  }): void {
    this.#assertOpen();
    const key = `${input.effectClass}\u0000${input.resourceUri}\u0000${input.operation}`;
    const declaration = this.#grants.find(
      (grant) =>
        grant.effectClass === input.effectClass &&
        grant.resourceUri === input.resourceUri &&
        grant.operations.includes(input.operation),
    );
    const previous = this.#effectRecordCounts.get(key) ?? 0;
    if (!declaration || previous + input.recordCount > declaration.maxRecords) {
      throw new PreviewExecutionError("Stage effect exceeds its cumulative record bound");
    }
    assertPreviewEffectAuthorized({
      profile: this.#definition.profile,
      stageId: this.#stage.id,
      deploymentIdentity: this.#deploymentIdentity,
      manifest: this.#manifest,
      grants: this.#grants,
      request: input,
    });
    this.#effectRecordCounts.set(key, previous + input.recordCount);
  }

  async requestEffect(request: BrokerMutationEffectRequest): Promise<void> {
    this.#authorize({
      effectClass: request.effectClass,
      resourceUri: request.resourceUri,
      operation: request.operation,
      recordCount: request.subject.recordCount,
    });
  }

  async acquire(request: BrokerReadEffectRequest): Promise<BrokerAcquisitionHandle> {
    return this.#track(async () => {
      const declaration = (this.#stage.requestedEffects ?? []).find(
        (effect) =>
          effect.effectClass === request.effectClass &&
          effect.resourceUri === request.resourceUri &&
          effect.operations.includes(request.operation),
      );
      if (!declaration) {
        throw new PreviewExecutionError("Read is not declared by this stage");
      }
      this.#authorize({
        ...request,
        recordCount: declaration.maxRecords,
      });
      const adapter = this.#manifest.sourceAdapter;
      if (!adapter) throw new PreviewExecutionError("Only source plugins can acquire resources");
      const reader = this.#readers[adapter];
      if (!reader) throw new PreviewExecutionError(`No reader registered for adapter ${adapter}`);
      const result = await reader.read({
        ...request,
        partition: this.#partition,
        maxRecords: declaration.maxRecords,
        maxBytes: this.#stage.resources.maxArtifactBytes - this.#artifactBytes,
        timeoutMs: this.#stage.resources.maxWallTimeMs,
        signal: this.#signal,
      });
      this.#assertOpen();
      const authoritativeValue = freezeRecursively(structuredClone(result.value));
      const authoritativeRecordCount = recordCount(authoritativeValue);
      if (authoritativeRecordCount > declaration.maxRecords) {
        throw new PreviewExecutionError(
          `Read returned ${authoritativeRecordCount} records; limit is ${declaration.maxRecords}`,
        );
      }
      const handle = Object.freeze({
        kind: "broker_acquisition",
        brokerHandle: `acquisition:${randomUUID()}`,
      }) as unknown as BrokerAcquisitionHandle;
      validateSnapshotDescriptor(result.snapshot);
      if (this.#shadowSourceReadGrants.length) {
        const grant = this.#shadowSourceReadGrants.find((candidate) =>
          candidate.stageId === this.#stage.id &&
          candidate.sourceAdapter === this.#manifest.sourceAdapter &&
          candidate.effectClass === request.effectClass &&
          candidate.resourceUri === request.resourceUri &&
          candidate.partitions.includes(this.#partition) &&
          candidate.operations.includes(request.operation));
        const expectation = grant?.snapshot;
        if (
          !expectation ||
          result.snapshot.consistency !== expectation.consistency ||
          result.snapshot.sourceInstanceDigest !== expectation.sourceInstanceDigest ||
          result.snapshot.readerBindingDigest !== expectation.readerBindingDigest ||
          result.snapshot.contractName !== expectation.contractName ||
          result.snapshot.contractVersion !== expectation.contractVersion ||
          result.snapshot.contractDigest !== expectation.contractDigest ||
          !sameSchemaOrNull(result.snapshot.cursorSchema, expectation.cursorSchema)
        ) {
          throw new PreviewExecutionError(
            "Reader snapshot does not match the host-owned shadow attestation",
          );
        }
      }
      this.#acquisitions.set(handle.brokerHandle, {
        request,
        value: authoritativeValue,
        recordCount: authoritativeRecordCount,
        observedChildIds: [...result.observedChildIds].sort(),
        schema: { ...result.schema },
        snapshot: freezeRecursively(structuredClone(result.snapshot)),
        status: "open",
      });
      return handle;
    });
  }

  async readDatasetJson(dataset: DatasetHandle): Promise<CanonicalJson> {
    return this.#track(async () => {
      if (
        !Object.values(this.#inputs).some(
          (input) => input.brokerHandle === dataset.brokerHandle,
        )
      ) {
        throw new PreviewExecutionError("Dataset is not an input of this stage");
      }
      if (dataset.kind === "ephemeral") {
        const value = this.#registry.valueFor(dataset);
        if (value === undefined) {
          throw new PreviewExecutionError("Ephemeral dataset is not registered by this preview run");
        }
        return value;
      }
      const artifact = this.#registry.artifactFor(dataset);
      return this.#artifactStore.readJson(artifact, {
        maxBytes: this.#stage.resources.maxArtifactBytes,
        signal: this.#signal,
      });
    });
  }

  async stageSourceArtifact(input: {
    acquisition: BrokerAcquisitionHandle;
    outputPort: string;
    artifactUri: string;
  }): Promise<BrokerStagedArtifactHandle> {
    this.#assertOpen();
    const acquisition = this.#acquisitions.get(input.acquisition.brokerHandle);
    if (!acquisition || acquisition.status !== "open") {
      throw new PreviewExecutionError("Source acquisition is unknown or already finalized");
    }
    if (acquisition.request.resourceUri !== input.artifactUri) {
      throw new PreviewExecutionError("Source staging URI does not match its acquisition");
    }
    const binding = this.#sourceBinding(input.outputPort, acquisition);
    const declaredSchema = this.#manifest.outputs[input.outputPort]!.schema;
    if (
      acquisition.schema.name !== declaredSchema.name ||
      acquisition.schema.version !== declaredSchema.version
    ) {
      throw new PreviewExecutionError(
        `Source output ${input.outputPort} does not match the reader schema`,
      );
    }
    if (!sameStrings(binding.childIds, acquisition.observedChildIds)) {
      throw new PreviewExecutionError("Observed child datasets do not match the source binding");
    }
    return this.#stageJson(input.outputPort, acquisition.value, input.acquisition.brokerHandle);
  }

  async finalizeSourceArtifactAndCommitAcquisition(input: {
    acquisition: BrokerAcquisitionHandle;
    stagedArtifact: BrokerStagedArtifactHandle;
    outputPort: string;
    checkpointProposal?: unknown;
  }): Promise<DatasetRef> {
    return this.#track(async () => {
      if (input.checkpointProposal !== undefined) {
        throw new PreviewExecutionError("Fixture preview does not accept plugin checkpoints");
      }
      const acquisition = this.#acquisitions.get(input.acquisition.brokerHandle);
      const staged = this.#stagedEntry(input.stagedArtifact, input.outputPort);
      if (
        !acquisition ||
        acquisition.status !== "open" ||
        staged.sourceAcquisitionHandle !== input.acquisition.brokerHandle
      ) {
        throw new PreviewExecutionError("Source finalization handles do not match");
      }
      const binding = this.#sourceBinding(input.outputPort, acquisition);
      acquisition.status = "finalizing";
      const now = new Date().toISOString();
      const metadata: ArtifactCommitMetadata = {
        schema: this.#manifest.outputs[input.outputPort]!.schema,
        artifactPolicy: this.#artifactPolicy(input.outputPort),
        artifactClass: binding.artifactClass,
        retentionStartedAt: now,
        expiresAt: new Date(Date.parse(now) + 86_400_000).toISOString(),
        restrictions: {
          sourcePolicies: [],
          redistribution: "forbidden",
          attributionRefs: [],
        },
        provenance: {
          kind: "preview_source",
          runtimeClass: this.#runtimeClass,
          runtimePolicyDigest: this.#runtimePolicyDigest,
          recordCount: acquisition.recordCount,
          producingStageId: this.#stage.id,
          profileId: this.#definition.profile,
          bindingPolicyId: binding.policyId,
          sourceAdapter: this.#manifest.sourceAdapter!,
          effectClass: binding.effectClass,
          resourceUri: binding.resourceUri,
          operations: binding.operations,
          outputPort: input.outputPort,
          childIds: acquisition.observedChildIds,
          snapshot: acquisition.snapshot,
        },
      };
      try {
        const dataset = await this.#commitStaged(staged, input.outputPort, metadata);
        acquisition.status = "finalized";
        return dataset;
      } catch (error) {
        acquisition.status = "failed";
        throw error;
      }
    });
  }

  async finalizeSourceEphemeral(input: {
    acquisition: BrokerAcquisitionHandle;
    outputPort: string;
  }): Promise<EphemeralDatasetHandle> {
    return this.#track(async () => {
      const acquisition = this.#acquisitions.get(input.acquisition.brokerHandle);
      if (!acquisition || acquisition.status !== "open") {
        throw new PreviewExecutionError("Source acquisition is unknown or already finalized");
      }
      const declaration = this.#manifest.outputs[input.outputPort];
      if (!declaration || declaration.artifactPolicy !== "forbidden") {
        throw new PreviewExecutionError(
          "Ephemeral source output must declare forbidden artifact persistence",
        );
      }
      const binding = this.#sourceBinding(input.outputPort, acquisition);
      if (
        acquisition.schema.name !== declaration.schema.name ||
        acquisition.schema.version !== declaration.schema.version
      ) {
        throw new PreviewExecutionError(
          `Source output ${input.outputPort} does not match the reader schema`,
        );
      }
      if (!sameStrings(binding.childIds, acquisition.observedChildIds)) {
        throw new PreviewExecutionError("Observed child datasets do not match the source binding");
      }
      const outputReference = `${this.#stage.id}.${input.outputPort}`;
      const remainingConsumers = this.#definition.stages.reduce(
        (count, stage) => count + Object.values(stage.inputs ?? {})
          .filter((reference) => reference === outputReference).length,
        0,
      );
      if (remainingConsumers === 0) {
        throw new PreviewExecutionError(
          `Ephemeral source output ${outputReference} has no declared consumer`,
        );
      }
      this.#claimOutputPort(input.outputPort);
      this.#validateOutputJson(input.outputPort, acquisition.value);
      acquisition.status = "finalizing";
      try {
        const dataset = freezeRecursively({
          kind: "ephemeral" as const,
          artifactPolicy: "forbidden" as const,
          brokerHandle: `ephemeral:${randomUUID()}`,
          schema: { ...declaration.schema },
          recordCount: acquisition.recordCount,
        }) as unknown as EphemeralDatasetHandle;
        const now = new Date().toISOString();
        this.#registry.registerEphemeral(dataset, acquisition.value, {
          expiresAt: new Date(Date.parse(now) + 86_400_000).toISOString(),
          restrictions: {
            sourcePolicies: [],
            redistribution: "forbidden",
            attributionRefs: [],
          },
          provenance: {
            kind: "preview_source",
            runtimeClass: this.#runtimeClass,
            runtimePolicyDigest: this.#runtimePolicyDigest,
            recordCount: acquisition.recordCount,
            producingStageId: this.#stage.id,
            profileId: this.#definition.profile,
            bindingPolicyId: binding.policyId,
            sourceAdapter: this.#manifest.sourceAdapter!,
            effectClass: binding.effectClass,
            resourceUri: binding.resourceUri,
            operations: binding.operations,
            outputPort: input.outputPort,
            childIds: acquisition.observedChildIds,
            snapshot: acquisition.snapshot,
          },
          remainingConsumers,
        });
        acquisition.status = "finalized";
        this.#finalizedOutputs.set(input.outputPort, dataset.brokerHandle);
        this.#acquisitions.delete(input.acquisition.brokerHandle);
        return dataset;
      } catch (error) {
        acquisition.status = "failed";
        throw error;
      }
    });
  }

  async stageDerivedArtifact(_input: {
    outputPort: string;
    artifactUri: string;
  }): Promise<BrokerStagedArtifactHandle> {
    throw new PreviewExecutionError(
      "Preview plugins must stage derived output through stageDerivedJson",
    );
  }

  async stageDerivedJson(input: {
    outputPort: string;
    value: CanonicalJson;
  }): Promise<BrokerStagedArtifactHandle> {
    this.#assertOpen();
    if (this.#manifest.sourceAdapter !== null) {
      throw new PreviewExecutionError("Source plugins cannot stage derived output");
    }
    if (!Object.keys(this.#inputs).length) {
      throw new PreviewExecutionError("Derived output requires at least one input");
    }
    return this.#stageJson(input.outputPort, input.value, null);
  }

  async finalizeDerivedArtifact(input: {
    stagedArtifact: BrokerStagedArtifactHandle;
    outputPort: string;
  }): Promise<DatasetRef> {
    return this.#track(() => this.#finalizeDerivedArtifact(input));
  }

  async #finalizeDerivedArtifact(input: {
    stagedArtifact: BrokerStagedArtifactHandle;
    outputPort: string;
  }): Promise<DatasetRef> {
    const staged = this.#stagedEntry(input.stagedArtifact, input.outputPort);
    if (staged.sourceAcquisitionHandle !== null) {
      throw new PreviewExecutionError("Source output cannot use derived finalization");
    }
    const parents = Object.values(this.#inputs).map((dataset) => {
      if (!this.#registry.verifyDataset(dataset)) {
        throw new PreviewExecutionError("Derived output has an unregistered parent");
      }
      return dataset;
    });
    const sourcePolicies = new Map<string, DatasetRef["restrictions"]["sourcePolicies"][number]>();
    const attributionRefs = new Set<string>();
    const sourceProvenance = new Map<string, NonNullable<
      Extract<DatasetProvenance, { kind: "internal" }>["sourceProvenance"]
    >[number]>();
    let redistribution: DatasetRef["restrictions"]["redistribution"] = "approved";
    let earliestExpiry = Number.POSITIVE_INFINITY;
    for (const parent of parents) {
      const lineage = this.#registry.lineageFor(parent);
      for (const policy of lineage.restrictions.sourcePolicies) {
        sourcePolicies.set(
          `${policy.profileId}:${policy.profilePolicyDigest}:${policy.sourcePolicyId}`,
          policy,
        );
      }
      for (const attribution of lineage.restrictions.attributionRefs) {
        attributionRefs.add(attribution);
      }
      if (lineage.restrictions.redistribution === "forbidden") redistribution = "forbidden";
      earliestExpiry = Math.min(earliestExpiry, Date.parse(lineage.expiresAt));
      if (
        lineage.provenance.kind === "source" ||
        lineage.provenance.kind === "preview_source"
      ) {
        sourceProvenance.set(digestObject(lineage.provenance), lineage.provenance);
      } else if (lineage.provenance.kind === "internal") {
        for (const source of lineage.provenance.sourceProvenance ?? []) {
          sourceProvenance.set(digestObject(source), source);
        }
      }
    }
    const now = new Date().toISOString();
    return this.#commitStaged(staged, input.outputPort, {
      schema: this.#manifest.outputs[input.outputPort]!.schema,
      artifactPolicy: this.#artifactPolicy(input.outputPort),
      artifactClass: "derived",
      retentionStartedAt: now,
      expiresAt: new Date(earliestExpiry).toISOString(),
      restrictions: {
        sourcePolicies: [...sourcePolicies.values()].sort((left, right) =>
          left.sourcePolicyId.localeCompare(right.sourcePolicyId)),
        redistribution,
        attributionRefs: [...attributionRefs].sort(),
      },
      provenance: {
        kind: "internal",
        producingStageId: this.#stage.id,
        outputPort: input.outputPort,
        parentHandles: parents.map((parent) => parent.brokerHandle),
        sourceProvenance: [...sourceProvenance.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([, source]) => source),
      },
    });
  }

  async commitStagedOutput(input: {
    stagedArtifact: BrokerStagedArtifactHandle;
    outputPort: string;
    effectClass: "artifact.write" | "evidence.write" | "review.write";
    resourceUri: string;
    operation: string;
    idempotencyKey: string;
    targetVersion: string;
  }): Promise<{ output: DatasetRef; receipt: BrokerDeliveryReceipt }> {
    return this.#track(async () => {
      if (!input.idempotencyKey.trim() || !input.targetVersion.trim()) {
        throw new PreviewExecutionError("Output receipt identity must be non-empty");
      }
      const staged = this.#stagedEntry(input.stagedArtifact, input.outputPort);
      if (input.effectClass !== "artifact.write") {
        this.#authorize({
          effectClass: input.effectClass,
          resourceUri: input.resourceUri,
          operation: input.operation,
          recordCount: staged.staged.recordCount,
        });
      }
      const writes = (this.#stage.requestedEffects ?? []).filter(
        (effect) => effect.effectClass === "artifact.write",
      );
      if (
        writes.length !== 1 ||
        writes[0]!.resourceUri !== input.resourceUri ||
        !writes[0]!.operations.includes(input.operation)
      ) {
        throw new PreviewExecutionError("Output commit does not match its declared preview write");
      }
      const output = await this.#finalizeDerivedArtifact(input);
      const receipt = Object.freeze({
        idempotencyKey: input.idempotencyKey,
        outputPort: input.outputPort,
        payloadHash: output.contentDigest,
        targetVersion: input.targetVersion,
        outcome: "created" as const,
        verifiedAt: new Date().toISOString(),
      }) as BrokerDeliveryReceipt;
      this.#receipts.set(receipt, {
        outputHandle: output.brokerHandle,
        outputPort: input.outputPort,
        fingerprint: canonicalize(receipt as unknown as CanonicalJson),
      });
      return Object.freeze({ output, receipt });
    });
  }

  verifyReceipt(receipt: BrokerDeliveryReceipt, output: DatasetHandle): boolean {
    const registered = this.#receipts.get(receipt);
    return Boolean(
      registered &&
      registered.outputHandle === output.brokerHandle &&
      registered.outputPort === receipt.outputPort &&
      registered.fingerprint === canonicalize(receipt as unknown as CanonicalJson),
    );
  }

  verifyOutputAccounting(outputs: Readonly<Record<string, DatasetHandle>>): boolean {
    const entries = Object.entries(outputs);
    return entries.length === this.#finalizedOutputs.size && entries.every(
      ([port, output]) => this.#finalizedOutputs.get(port) === output.brokerHandle,
    );
  }

  async commitState(input: {
    proposal: unknown;
    resourceUri: string;
    operation: string;
  }): Promise<void> {
    this.#authorize({
      effectClass: "state.write",
      resourceUri: input.resourceUri,
      operation: input.operation,
      recordCount: input.proposal === undefined ? 0 : 1,
    });
  }

  async close(options: { rejectUnawaited?: boolean } = {}): Promise<void> {
    if (!this.#closePromise) {
      this.#closePromise = this.#close(options.rejectUnawaited === true);
    }
    return this.#closePromise;
  }

  async #close(rejectUnawaited: boolean): Promise<void> {
    const hadUnawaitedOperations = this.#activeOperations > 0;
    this.#closed = true;
    await this.#drain();
    await Promise.all(
      [...this.#staged.values()]
        .filter((entry) => entry.status !== "finalized")
        .map((entry) => this.#artifactStore.discard(entry.staged)),
    );
    this.#acquisitions.clear();
    this.#staged.clear();
    if (rejectUnawaited && hadUnawaitedOperations) {
      throw new PreviewExecutionError("Stage returned with unawaited broker operations");
    }
  }

  #sourceBinding(outputPort: string, acquisition: AcquisitionEntry) {
    if (this.#manifest.sourceAdapter === null) {
      throw new PreviewExecutionError("Only source plugins can finalize acquisitions");
    }
    const bindings = (this.#stage.sourceBindings ?? []).filter(
      (binding) =>
        binding.outputPorts.includes(outputPort) &&
        binding.effectClass === acquisition.request.effectClass &&
        binding.resourceUri === acquisition.request.resourceUri &&
        binding.operations.includes(acquisition.request.operation),
    );
    if (bindings.length !== 1) {
      throw new PreviewExecutionError("Source output lacks one exact fixture binding");
    }
    return bindings[0]!;
  }

  #artifactPolicy(outputPort: string): Exclude<DatasetRef["artifactPolicy"], "forbidden"> {
    const policy = this.#manifest.outputs[outputPort]?.artifactPolicy;
    if (!policy || policy === "forbidden") {
      throw new PreviewExecutionError(`Output ${outputPort} cannot be persisted`);
    }
    return policy;
  }

  #claimOutputPort(outputPort: string): void {
    if (!this.#manifest.outputs[outputPort]) {
      throw new PreviewExecutionError(`Undeclared output ${outputPort}`);
    }
    if (this.#claimedOutputPorts.has(outputPort)) {
      throw new PreviewExecutionError(`Output ${outputPort} has already been staged or finalized`);
    }
    this.#claimedOutputPorts.add(outputPort);
  }

  #validateOutputJson(outputPort: string, value: CanonicalJson): void {
    const schema = this.#manifest.outputs[outputPort]!.schema;
    const validate = this.#schemaValidators[schemaKey(schema)];
    if (!validate) {
      throw new PreviewExecutionError(`No runtime validator registered for ${schemaKey(schema)}`);
    }
    try {
      validate(value);
    } catch (error) {
      throw new PreviewExecutionError(
        `Output ${outputPort} failed ${schemaKey(schema)} validation: ${errorMessage(error)}`,
      );
    }
  }

  async #stageJson(
    outputPort: string,
    value: CanonicalJson,
    sourceAcquisitionHandle: string | null,
  ): Promise<BrokerStagedArtifactHandle> {
    if (this.#stagingInProgress) {
      throw new PreviewExecutionError("Concurrent artifact staging is not allowed");
    }
    this.#claimOutputPort(outputPort);
    const snapshot = freezeRecursively(structuredClone(value));
    this.#validateOutputJson(outputPort, snapshot);
    this.#stagingInProgress = true;
    return this.#track(async () => {
      try {
        const remainingBytes = this.#stage.resources.maxArtifactBytes - this.#artifactBytes;
        const staged = await this.#artifactStore.stageJson(snapshot, {
          maxBytes: remainingBytes,
          signal: this.#signal,
        });
        try {
          this.#assertOpen();
        } catch (error) {
          await this.#artifactStore.discard(staged);
          throw error;
        }
        this.#artifactBytes += staged.byteCount;
        const handle = Object.freeze({
          kind: "broker_staged_artifact",
          brokerHandle: `broker:${staged.handle}`,
        }) as unknown as BrokerStagedArtifactHandle;
        this.#staged.set(handle.brokerHandle, {
          staged,
          outputPort,
          sourceAcquisitionHandle,
          status: "open",
        });
        return handle;
      } finally {
        this.#stagingInProgress = false;
      }
    });
  }

  #stagedEntry(
    handle: BrokerStagedArtifactHandle,
    outputPort: string,
  ): StagedEntry {
    this.#assertOpen();
    const staged = this.#staged.get(handle.brokerHandle);
    if (!staged || staged.status !== "open" || staged.outputPort !== outputPort) {
      throw new PreviewExecutionError("Staged artifact is invalid or already finalized");
    }
    return staged;
  }

  async #commitStaged(
    staged: StagedEntry,
    outputPort: string,
    metadata: ArtifactCommitMetadata,
  ): Promise<DatasetRef> {
    const write = (this.#stage.requestedEffects ?? []).filter(
      (effect) =>
        effect.effectClass === "artifact.write" &&
        effect.resourceUri.startsWith("preview://") &&
        effect.operations.includes("create"),
    );
    if (write.length !== 1) {
      throw new PreviewExecutionError(
        `Stage ${this.#stage.id} must declare one preview artifact write`,
      );
    }
    this.#authorize({
      effectClass: "artifact.write",
      resourceUri: write[0]!.resourceUri,
      operation: "create",
      recordCount: staged.staged.recordCount,
    });
    if (staged.status !== "open") {
      throw new PreviewExecutionError("Staged artifact is already being finalized");
    }
    staged.status = "finalizing";
    try {
      const committed = await this.#artifactStore.commitJson(staged.staged, metadata, {
        signal: this.#signal,
      });
      this.#assertOpen();
      const dataset = freezeRecursively({
      kind: "artifact",
      brokerHandle: `dataset:${committed.manifestDigest}`,
      artifactPolicy: metadata.artifactPolicy,
      artifactClass: metadata.artifactClass,
      manifestDigest: committed.manifestDigest,
      contentDigest: committed.contentDigest,
      schema: metadata.schema,
      fields: committed.fields,
      recordCount: committed.recordCount,
      uri: committed.uri,
      retentionStartedAt: metadata.retentionStartedAt,
      expiresAt: metadata.expiresAt,
      restrictions: metadata.restrictions,
      provenance: metadata.provenance,
      }) as unknown as DatasetRef;
      this.#registry.register(dataset, committed);
      this.#finalizedOutputs.set(outputPort, dataset.brokerHandle);
      staged.status = "finalized";
      return dataset;
    } catch (error) {
      staged.status = "failed";
      throw error;
    }
  }
}

export interface PreviewStageReport {
  stageId: string;
  attempt: number;
  metrics: Record<string, number>;
  outputs: Record<string, {
    brokerHandle: string;
    recordCount: number;
    contentDigest?: string;
    manifestDigest?: string;
    uri?: string;
  }>;
  deliveryReceipts: DeliveryReceipt[];
}

export interface PreviewExecutionReport {
  mode: "preview";
  runtimeClass: "fixture_preview" | "read_only_shadow";
  status: "succeeded";
  runId: string;
  profile: string;
  pipeline: string;
  pipelineVersion: number;
  partition: string;
  startedAt: string;
  finishedAt: string;
  stages: PreviewStageReport[];
}

export interface PreviewExecutorOptions {
  definition: PipelineDefinition;
  catalog: Readonly<Record<string, StagePluginManifest>>;
  plugins: Readonly<Record<string, StagePlugin<unknown>>>;
  /** Readers keyed by the exact StagePluginManifest.sourceAdapter identity. */
  readers: Readonly<Record<string, ResourceReader>>;
  schemaValidators: Readonly<Record<string, CanonicalJsonValidator>>;
  artifactStore: JsonArtifactStore;
  stateStore: RunStateStore;
  hostPolicy: HostPolicyManifest;
  observedFreeDiskBytes: () => Promise<number>;
  now?: () => Date;
}

export interface ShadowSourceReadGrant {
  stageId: string;
  sourceAdapter: string;
  policyId: string;
  effectClass: "network.read" | "artifact.read";
  resourceUri: string;
  operations: readonly string[];
  partitions: readonly string[];
  maxRecords: number;
  snapshot: {
    consistency: "immutable" | "repeatable_read";
    sourceInstanceDigest: string | null;
    readerBindingDigest: string;
    cursorSchema: SchemaRef | null;
    contractName: string;
    contractVersion: number;
    contractDigest: string;
  };
}

export interface ReadOnlyShadowExecutorOptions extends PreviewExecutorOptions {
  deploymentIdentity: string;
  allowedPartitions: readonly string[];
  sourceReadGrants: readonly ShadowSourceReadGrant[];
}

interface ExecutorRuntimePolicy {
  kind: "fixture_preview" | "read_only_shadow";
  deploymentIdentity: string;
  allowedPartitions: readonly string[];
  sourceReadGrants: readonly ShadowSourceReadGrant[];
}

function validateRuntimePolicyShape(policy: ExecutorRuntimePolicy): void {
  if (
    !policy.deploymentIdentity ||
    policy.deploymentIdentity.trim() !== policy.deploymentIdentity ||
    !policy.allowedPartitions.length ||
    new Set(policy.allowedPartitions).size !== policy.allowedPartitions.length ||
    policy.allowedPartitions.some((partition) => !partition || partition.trim() !== partition)
  ) {
    throw new PreviewExecutionError("Runtime policy identity or partitions are invalid");
  }
  for (const grant of policy.sourceReadGrants) {
    let resourceUriValid = false;
    try {
      const resource = new URL(grant.resourceUri);
      resourceUriValid = resource.toString() === grant.resourceUri &&
        !resource.username && !resource.password && !resource.search && !resource.hash;
    } catch {
      resourceUriValid = false;
    }
    if (
      !grant.stageId ||
      !grant.sourceAdapter ||
      !grant.policyId ||
      !resourceUriValid ||
      !grant.operations.length ||
      new Set(grant.operations).size !== grant.operations.length ||
      grant.operations.some((operation) => !operation || operation.trim() !== operation) ||
      !grant.partitions.length ||
      new Set(grant.partitions).size !== grant.partitions.length ||
      grant.partitions.some((partition) => !partition || partition.trim() !== partition) ||
      !Number.isSafeInteger(grant.maxRecords) ||
      grant.maxRecords <= 0 ||
      !grant.snapshot ||
      !["immutable", "repeatable_read"].includes(grant.snapshot.consistency) ||
      (grant.snapshot.sourceInstanceDigest !== null &&
        !/^sha256:[a-f0-9]{64}$/.test(grant.snapshot.sourceInstanceDigest)) ||
      !/^sha256:[a-f0-9]{64}$/.test(grant.snapshot.readerBindingDigest) ||
      (grant.snapshot.cursorSchema !== null && (
        !grant.snapshot.cursorSchema.name ||
        !Number.isSafeInteger(grant.snapshot.cursorSchema.version) ||
        grant.snapshot.cursorSchema.version < 1
      )) ||
      !grant.snapshot.contractName ||
      !Number.isSafeInteger(grant.snapshot.contractVersion) ||
      grant.snapshot.contractVersion < 1 ||
      !/^sha256:[a-f0-9]{64}$/.test(grant.snapshot.contractDigest)
    ) {
      throw new PreviewExecutionError("Shadow source read grant is invalid");
    }
  }
}

class OrderedArtifactExecutor {
  readonly #options: PreviewExecutorOptions;
  readonly #runtimePolicy: ExecutorRuntimePolicy;
  readonly #runtimePolicyDigest: string;
  #running = false;

  constructor(options: PreviewExecutorOptions, runtimePolicy: ExecutorRuntimePolicy) {
    this.#options = {
      ...options,
      definition: freezeRecursively(structuredClone(options.definition)),
      catalog: freezeRecursively(structuredClone(options.catalog)),
      plugins: Object.freeze({ ...options.plugins }),
      readers: Object.freeze({ ...options.readers }),
      schemaValidators: Object.freeze({ ...options.schemaValidators }),
      hostPolicy: freezeRecursively(structuredClone(options.hostPolicy)),
    };
    this.#runtimePolicy = freezeRecursively(structuredClone(runtimePolicy));
    validateRuntimePolicyShape(this.#runtimePolicy);
    this.#runtimePolicyDigest = digestObject({
      kind: this.#runtimePolicy.kind,
      deploymentIdentity: this.#runtimePolicy.deploymentIdentity,
      allowedPartitions: [...this.#runtimePolicy.allowedPartitions],
      sourceReadGrants: this.#runtimePolicy.sourceReadGrants.map((grant) => ({
        ...grant,
        operations: [...grant.operations],
      })),
      definition: this.#options.definition,
      catalog: this.#options.catalog,
      hostPolicy: this.#options.hostPolicy,
    });
    this.#assertReady();
  }

  async run(input: { partition: string; runId?: string }): Promise<PreviewExecutionReport> {
    if (this.#running) {
      throw new PreviewExecutionError(
        "This executor already has an active run; cross-process admission is not implemented",
      );
    }
    if (!input.partition.trim()) throw new PreviewExecutionError("Partition is required");
    if (
      this.#options.definition.partitions &&
      !this.#options.definition.partitions.includes(input.partition)
    ) {
      throw new PreviewExecutionError(
        `Partition ${input.partition} is not allowed by this pipeline definition`,
      );
    }
    if (!this.#runtimePolicy.allowedPartitions.includes(input.partition)) {
      throw new PreviewExecutionError(
        `Partition ${input.partition} is not allowed by this runtime policy`,
      );
    }
    const now = this.#options.now ?? (() => new Date());
    const runId = input.runId ?? `run-${randomUUID()}`;
    if (!runId || runId.trim() !== runId || runId.normalize("NFC") !== runId) {
      throw new PreviewExecutionError("Run ID must be non-empty, trimmed NFC text");
    }
    this.#running = true;
    const startedAt = now().toISOString();
    const registry = new PreviewDatasetRegistry();
    const outputsByStage = new Map<string, Record<string, DatasetHandle>>();
    const stageReports: PreviewStageReport[] = [];
    let runStarted = false;

    try {
      this.#options.stateStore.beginRun({
        runId,
        profile: this.#options.definition.profile,
        pipeline: this.#options.definition.metadata.name,
        pipelineVersion: this.#options.definition.metadata.version,
        partition: input.partition,
        mode: "preview",
        startedAt,
      });
      runStarted = true;

      for (const stage of this.#options.definition.stages) {
        const manifest = this.#options.catalog[stage.uses]!;
        const plugin = this.#options.plugins[stage.uses]!;
        const stageInputs: Record<string, DatasetHandle> = {};
        for (const [inputPort, reference] of Object.entries(stage.inputs ?? {})) {
          const [stageId, outputPort, ...extra] = reference.split(".");
          const dataset = stageId && outputPort && extra.length === 0
            ? outputsByStage.get(stageId)?.[outputPort]
            : undefined;
          if (!dataset) {
            throw new PreviewExecutionError(
              `Stage ${stage.id} cannot resolve input ${inputPort} from ${reference}`,
            );
          }
          stageInputs[inputPort] = dataset;
        }

        const admission = evaluateAdmission({
          limits: {
            ...this.#options.hostPolicy.limits,
            groups: this.#options.hostPolicy.admissionGroups,
          },
          active: [],
          candidate: stage.resources,
          observedFreeDiskBytes: await this.#options.observedFreeDiskBytes(),
        });
        if (!admission.admitted) {
          throw new PreviewExecutionError(
            `Stage ${stage.id} was not admitted: ${admission.reasons.join("; ")}`,
          );
        }

        const invocationInputs = Object.freeze({ ...stageInputs });
        const attempt = this.#options.stateStore.beginStage({
          runId,
          stageId: stage.id,
          startedAt: now().toISOString(),
        });
        const controller = new AbortController();
        const broker = new PreviewStageBroker({
          definition: this.#options.definition,
          stage,
          catalog: this.#options.catalog,
          artifactStore: this.#options.artifactStore,
          registry,
          readers: this.#options.readers,
          schemaValidators: this.#options.schemaValidators,
          signal: controller.signal,
          partition: input.partition,
          deploymentIdentity: this.#runtimePolicy.deploymentIdentity,
          runtimePolicyDigest: this.#runtimePolicyDigest,
          runtimeClass: this.#runtimePolicy.kind,
          shadowSourceReadGrants: this.#runtimePolicy.kind === "read_only_shadow"
            ? this.#runtimePolicy.sourceReadGrants
            : [],
          inputs: invocationInputs,
        });

        try {
          const result = await this.#runStageWithTimeout(
            plugin,
            broker,
            stage,
            invocationInputs,
            input.partition,
            runId,
            attempt,
            controller,
          );
          controller.abort(new PreviewExecutionError(`Stage ${stage.id} invocation completed`));
          await broker.close({ rejectUnawaited: true });
          this.#validateResult(stage, manifest, result, registry, broker);
          outputsByStage.set(stage.id, Object.freeze({ ...result.outputs }));
          const outputSummary: PreviewStageReport["outputs"] = Object.fromEntries(
            Object.entries(result.outputs).map(([port, dataset]) => {
              return dataset.kind === "artifact"
                ? [port, {
                  brokerHandle: dataset.brokerHandle,
                  contentDigest: dataset.contentDigest,
                  manifestDigest: dataset.manifestDigest,
                  recordCount: dataset.recordCount,
                  uri: dataset.uri,
                }]
                : [port, {
                  brokerHandle: dataset.brokerHandle,
                  recordCount: dataset.recordCount,
                }];
            }),
          );
          this.#options.stateStore.completeStage({
            runId,
            stageId: stage.id,
            attempt,
            finishedAt: now().toISOString(),
            outputs: Object.fromEntries(
              Object.entries(outputSummary).map(([port, value]) => [
                port,
                value.manifestDigest ?? "ephemeral",
              ]),
            ),
          });
          stageReports.push({
            stageId: stage.id,
            attempt,
            metrics: result.metrics,
            outputs: outputSummary,
            deliveryReceipts: result.deliveryReceipts ?? [],
          });
        } catch (error) {
          controller.abort(error);
          let stageError = error;
          try {
            await broker.close();
          } catch (cleanupError) {
            if (cleanupError !== error) {
              stageError = new AggregateError(
                [error, cleanupError],
                `Stage ${stage.id} failed and broker cleanup also failed`,
              );
            }
          }
          this.#options.stateStore.failStage({
            runId,
            stageId: stage.id,
            attempt,
            finishedAt: now().toISOString(),
            error: errorMessage(stageError),
          });
          throw stageError;
        } finally {
          registry.releaseConsumed(Object.values(invocationInputs));
        }
      }

      const finishedAt = now().toISOString();
      this.#options.stateStore.completeRun({
        runId,
        finishedAt,
        expectedStageIds: this.#options.definition.stages.map((stage) => stage.id),
      });
      return {
        mode: "preview",
        runtimeClass: this.#runtimePolicy.kind,
        status: "succeeded",
        runId,
        profile: this.#options.definition.profile,
        pipeline: this.#options.definition.metadata.name,
        pipelineVersion: this.#options.definition.metadata.version,
        partition: input.partition,
        startedAt,
        finishedAt,
        stages: stageReports,
      };
    } catch (error) {
      if (runStarted && this.#options.stateStore.getRun(runId)?.status === "running") {
        this.#options.stateStore.failRun({
          runId,
          finishedAt: now().toISOString(),
          error: errorMessage(error),
        });
      }
      throw error;
    } finally {
      registry.clearEphemeral();
      this.#running = false;
    }
  }

  #assertReady(): void {
    const { definition, catalog, plugins, hostPolicy, schemaValidators } = this.#options;
    const issues = validateDefinition(definition, catalog);
    if (issues.length) {
      throw new PreviewExecutionError(
        `Pipeline definition is invalid: ${issues[0]!.path} ${issues[0]!.message}`,
      );
    }
    if (!hostPolicy.id || hostPolicy.version < 1) {
      throw new PreviewExecutionError("Host policy identity is invalid");
    }
    if (
      !this.#runtimePolicy.deploymentIdentity ||
      this.#runtimePolicy.deploymentIdentity.trim() !== this.#runtimePolicy.deploymentIdentity ||
      !this.#runtimePolicy.allowedPartitions.length ||
      new Set(this.#runtimePolicy.allowedPartitions).size !==
        this.#runtimePolicy.allowedPartitions.length
    ) {
      throw new PreviewExecutionError("Runtime policy identity or partitions are invalid");
    }
    if (
      !definition.partitions ||
      definition.partitions.some(
        (partition) => !this.#runtimePolicy.allowedPartitions.includes(partition),
      )
    ) {
      throw new PreviewExecutionError("Definition partitions exceed the runtime policy");
    }
    const usedShadowGrants = new Set<number>();
    for (const stage of definition.stages) {
      const manifest = catalog[stage.uses]!;
      const plugin = plugins[stage.uses];
      if (!plugin || digestObject(plugin.manifest) !== digestObject(manifest)) {
        throw new PreviewExecutionError(`Plugin ${stage.uses} is missing or lock-mismatched`);
      }
      if (manifest.secretRefs?.length) {
        throw new PreviewExecutionError("Read-only executors cannot pass secrets to plugins");
      }
      for (const declaration of Object.values(manifest.outputs)) {
        if (!schemaValidators[schemaKey(declaration.schema)]) {
          throw new PreviewExecutionError(
            `Plugin ${stage.uses} lacks runtime validator ${schemaKey(declaration.schema)}`,
          );
        }
      }
      for (const request of stage.requestedEffects ?? []) {
        const protocol = new URL(request.resourceUri).protocol;
        const fixtureRead = request.effectClass === "artifact.read" && protocol === "fixture:";
        const shadowRead = this.#runtimePolicy.kind === "read_only_shadow" &&
          (request.effectClass === "artifact.read" || request.effectClass === "network.read");
        const previewWrite = request.effectClass === "artifact.write" && protocol === "preview:";
        if (!(previewWrite || (this.#runtimePolicy.kind === "fixture_preview" ? fixtureRead : shadowRead))) {
          throw new PreviewExecutionError(
            `${this.#runtimePolicy.kind} forbids ${request.effectClass} on ${request.resourceUri}`,
          );
        }
      }
      if (manifest.sourceAdapter !== null) {
        for (const binding of stage.sourceBindings ?? []) {
          if (this.#runtimePolicy.kind === "fixture_preview") {
            if (
              binding.effectClass !== "artifact.read" ||
              new URL(binding.resourceUri).protocol !== "fixture:" ||
              !binding.policyId.startsWith("fixture:")
            ) {
              throw new PreviewExecutionError(
                "Fixture preview source bindings must be synthetic fixtures",
              );
            }
            continue;
          }
          const matches = this.#runtimePolicy.sourceReadGrants
            .map((grant, index) => ({ grant, index }))
            .filter(({ grant }) =>
              grant.stageId === stage.id &&
              grant.sourceAdapter === manifest.sourceAdapter &&
              grant.policyId === binding.policyId &&
              grant.effectClass === binding.effectClass &&
              grant.resourceUri === binding.resourceUri &&
              definition.partitions!.every((partition) => grant.partitions.includes(partition)) &&
              sameStrings(grant.operations, binding.operations));
          if (matches.length !== 1) {
            throw new PreviewExecutionError(
              `Shadow source ${stage.id} lacks one exact host-owned read grant`,
            );
          }
          const { grant, index } = matches[0]!;
          const request = (stage.requestedEffects ?? []).find((candidate) =>
            candidate.effectClass === binding.effectClass &&
            candidate.resourceUri === binding.resourceUri &&
            sameStrings(candidate.operations, binding.operations));
          if (!request || request.maxRecords > grant.maxRecords) {
            throw new PreviewExecutionError(
              `Shadow source ${stage.id} exceeds its host-owned record bound`,
            );
          }
          usedShadowGrants.add(index);
        }
      }
    }
    if (
      this.#runtimePolicy.kind === "fixture_preview" &&
      this.#runtimePolicy.sourceReadGrants.length
    ) {
      throw new PreviewExecutionError("Fixture preview cannot accept shadow read grants");
    }
    if (
      this.#runtimePolicy.kind === "read_only_shadow" &&
      (this.#runtimePolicy.sourceReadGrants.length === 0 ||
        usedShadowGrants.size !== this.#runtimePolicy.sourceReadGrants.length)
    ) {
      throw new PreviewExecutionError("Shadow runtime has missing or unused source read grants");
    }
  }

  async #runStageWithTimeout(
    plugin: StagePlugin<unknown>,
    broker: StageBroker,
    stage: StageDefinition,
    inputs: Readonly<Record<string, DatasetHandle>>,
    partition: string,
    runId: string,
    attempt: number,
    controller: AbortController,
  ): Promise<StageResult> {
    const timeoutMs = stage.resources.maxWallTimeMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new PreviewExecutionError(`Stage ${stage.id} has an invalid wall-time limit`);
    }
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        plugin.run({
          runId,
          stageRunId: `${runId}:${stage.id}:${attempt}`,
          profile: this.#options.definition.profile,
          partition,
          mode: "preview",
          signal: controller.signal,
          broker,
          declaredSecretRefs: [],
        }, inputs, stage.with ?? {}),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            const error = new PreviewExecutionError(
              `Stage ${stage.id} exceeded ${timeoutMs}ms`,
            );
            controller.abort(error);
            reject(error);
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  #validateResult(
    stage: StageDefinition,
    manifest: StagePluginManifest,
    result: StageResult,
    registry: PreviewDatasetRegistry,
    broker: PreviewStageBroker,
  ): void {
    if (!broker.verifyOutputAccounting(result.outputs)) {
      throw new PreviewExecutionError(
        `Stage ${stage.id} failed output accounting against its finalized output set`,
      );
    }
    for (const [name, value] of Object.entries(result.metrics)) {
      if (!name || !Number.isFinite(value) || value < 0) {
        throw new PreviewExecutionError(`Stage ${stage.id} returned invalid metrics`);
      }
    }
    for (const [port, declaration] of Object.entries(manifest.outputs)) {
      const output = result.outputs[port];
      if (declaration.required !== false && !output) {
        throw new PreviewExecutionError(`Stage ${stage.id} omitted output ${port}`);
      }
      if (
        output &&
        (!registry.verifyDataset(output) ||
          output.schema.name !== declaration.schema.name ||
          output.schema.version !== declaration.schema.version ||
          output.artifactPolicy !== declaration.artifactPolicy ||
          (output.kind === "artifact" && (
            !("producingStageId" in output.provenance) ||
            output.provenance.producingStageId !== stage.id ||
            !("outputPort" in output.provenance) ||
            output.provenance.outputPort !== port
          )) ||
          (output.kind === "ephemeral" && declaration.artifactPolicy !== "forbidden"))
      ) {
        throw new PreviewExecutionError(`Stage ${stage.id} returned invalid output ${port}`);
      }
    }
    for (const port of Object.keys(result.outputs)) {
      if (!manifest.outputs[port]) {
        throw new PreviewExecutionError(`Stage ${stage.id} returned undeclared output ${port}`);
      }
    }
    if (
      this.#options.definition.requiredSinks.includes(stage.id) &&
      (manifest.delivery !== "verified_receipt" || !(result.deliveryReceipts?.length))
    ) {
      throw new PreviewExecutionError(
        `Required sink ${stage.id} did not return a verified receipt`,
      );
    }
    for (const receipt of result.deliveryReceipts ?? []) {
      const receiptOutput = result.outputs[receipt.outputPort];
      if (
        !receipt.idempotencyKey ||
        !receipt.outputPort ||
        !/^sha256:[a-f0-9]{64}$/.test(receipt.payloadHash) ||
        !receipt.targetVersion ||
        !["created", "updated", "no_op", "conflict"].includes(receipt.outcome) ||
        Number.isNaN(Date.parse(receipt.verifiedAt)) ||
        new Date(receipt.verifiedAt).toISOString() !== receipt.verifiedAt ||
        !receiptOutput ||
        receiptOutput.kind !== "artifact" ||
        receiptOutput.contentDigest !== receipt.payloadHash ||
        !broker.verifyReceipt(receipt, receiptOutput)
      ) {
        throw new PreviewExecutionError(`Stage ${stage.id} returned an invalid receipt`);
      }
    }
    if (this.#options.definition.requiredSinks.includes(stage.id)) {
      for (const [port, declaration] of Object.entries(manifest.outputs)) {
        if (
          declaration.required !== false &&
          !result.deliveryReceipts?.some((receipt) => receipt.outputPort === port)
        ) {
          throw new PreviewExecutionError(
            `Required sink ${stage.id} has no receipt for output ${port}`,
          );
        }
      }
    }
  }
}

export class PreviewExecutor {
  readonly #executor: OrderedArtifactExecutor;

  constructor(options: PreviewExecutorOptions) {
    this.#executor = new OrderedArtifactExecutor(options, {
      kind: "fixture_preview",
      deploymentIdentity: "local-preview",
      allowedPartitions: [...(options.definition.partitions ?? [])],
      sourceReadGrants: [],
    });
  }

  run(input: { partition: string; runId?: string }): Promise<PreviewExecutionReport> {
    return this.#executor.run(input);
  }
}

export class ReadOnlyShadowExecutor {
  readonly #executor: OrderedArtifactExecutor;

  constructor(options: ReadOnlyShadowExecutorOptions) {
    const {
      deploymentIdentity,
      allowedPartitions,
      sourceReadGrants,
      ...executorOptions
    } = options;
    this.#executor = new OrderedArtifactExecutor(executorOptions, {
      kind: "read_only_shadow",
      deploymentIdentity,
      allowedPartitions,
      sourceReadGrants,
    });
  }

  run(input: { partition: string; runId?: string }): Promise<PreviewExecutionReport> {
    return this.#executor.run(input);
  }
}
