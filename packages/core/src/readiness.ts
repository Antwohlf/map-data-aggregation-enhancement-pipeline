import type {
  ActiveProfileDeclaration,
  DatasetHandle,
  DatasetRef,
  DatasetRestrictions,
  DeploymentManifest,
  EffectAuthorization,
  EffectPolicy,
  EffectRequestDeclaration,
  EffectRequest,
  HostPolicyManifest,
  PipelineDefinition,
  ProfileDeclaration,
  ResourceReservation,
  SourceBinding,
  SourcePolicyDeclaration,
  StagePluginManifest,
} from "./types.js";
import { BROKER_AUDIT_FIELDS, BROKER_AUDIT_SCHEMA } from "./types.js";
import { evaluateAdmission, type AdmissionDecision } from "./admission.js";
import { assertEffectAuthorizedInternal } from "./authorization.js";
import { digest, type CanonicalJson } from "./identity.js";
import { validateDefinition } from "./validation.js";

const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;

export class ApplyNotReadyError extends Error {
  override readonly name = "ApplyNotReadyError";
}

function digestObject(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (!serialized) {
    throw new TypeError("Cannot digest an unserializable manifest");
  }
  return digest(JSON.parse(serialized) as CanonicalJson);
}

export function computePluginCatalogDigest(
  catalog: Readonly<Record<string, StagePluginManifest>>,
): string {
  return digestObject(catalog);
}

export function computeDefinitionDigest(definition: PipelineDefinition): string {
  return digestObject(definition);
}

export function computeProfilePolicyDigest(profile: ProfileDeclaration): string {
  return digestObject(profile);
}

export function computeHostPolicyDigest(hostPolicy: HostPolicyManifest): string {
  return digestObject(hostPolicy);
}

function sameOperations(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return (
    left.length === right.length &&
    sortedLeft.every((operation, index) => operation === sortedRight[index])
  );
}

function policyMatches(
  policy: EffectPolicy,
  stageId: string,
  request: EffectRequestDeclaration,
): boolean {
  return (
    policy.stageId === stageId &&
    policy.effectClass === request.effectClass &&
    policy.resourceUri === request.resourceUri &&
    sameOperations(policy.operations, request.operations) &&
    policy.maxRecords === request.maxRecords &&
    policy.verification === request.verification
  );
}

function grantMatches(
  grant: EffectAuthorization,
  profile: ActiveProfileDeclaration,
  deployment: DeploymentManifest,
  stageId: string,
  request: EffectRequestDeclaration,
): boolean {
  return (
    grant.profile === profile.id &&
    grant.stageId === stageId &&
    grant.deploymentIdentity === deployment.deploymentIdentity &&
    grant.effectClass === request.effectClass &&
    grant.resourceUri === request.resourceUri &&
    sameOperations(grant.operations, request.operations) &&
    grant.maxRecords === request.maxRecords &&
    grant.verification === request.verification
  );
}

function retentionCeiling(
  source: SourcePolicyDeclaration,
  artifactClass: SourceBinding["artifactClass"],
): number {
  switch (artifactClass) {
    case "raw":
      return source.provisionalRetention.rawMaxDays;
    case "review_evidence":
      return source.provisionalRetention.reviewEvidenceAfterTerminalDays;
    case "derived":
      return source.provisionalRetention.derivedMaxDays;
  }
}

function validProvisionalCeilings(source: SourcePolicyDeclaration): boolean {
  return [
    source.provisionalRetention.rawMaxDays,
    source.provisionalRetention.derivedMaxDays,
    source.provisionalRetention.reviewEvidenceAfterTerminalDays,
  ].every(
    (days) => Number.isSafeInteger(days) && days >= 0 && days <= 30,
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return sameOperations(left, right);
}

function sameSchema(
  left: { name: string; version: number },
  right: { name: string; version: number },
): boolean {
  return left.name === right.name && left.version === right.version;
}

function isCanonicalIsoInstant(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

export interface DatasetRegistryVerifier {
  /** Must compare the complete handle/reference with broker-registry state. */
  verifyDataset(dataset: DatasetHandle): boolean;
}

function assertSourceDatasetBinding(input: {
  dataset: DatasetRef;
  binding: SourceBinding;
  stageId: string;
  outputPort: string;
  manifest: StagePluginManifest;
  profile: ProfileDeclaration;
  source: SourcePolicyDeclaration;
  registry: DatasetRegistryVerifier;
}): void {
  const {
    dataset,
    binding,
    stageId,
    outputPort,
    manifest,
    profile,
    source,
    registry,
  } = input;
  const provenance = dataset.provenance;
  const output = manifest.outputs[outputPort];
  const profilePolicyDigest = computeProfilePolicyDigest(profile);
  const expectedAttributionRefs = source.attributionRef
    ? [source.attributionRef]
    : [];
  const policyStamp = dataset.restrictions.sourcePolicies[0];
  if (
    !registry.verifyDataset(dataset) ||
    !dataset.brokerHandle ||
    !Number.isSafeInteger(dataset.recordCount) ||
    dataset.recordCount < 0 ||
    new Set(dataset.fields).size !== dataset.fields.length ||
    dataset.fields.some((field) => !field || !source.allowedFields.includes(field)) ||
    (dataset.recordCount > 0 && dataset.fields.length === 0) ||
    manifest.sourceAdapter === null ||
    manifest.sourceAdapter !== source.adapter ||
    binding.policyId !== source.id ||
    !binding.outputPorts.includes(outputPort) ||
    !output ||
    !sameSchema(dataset.schema, output.schema) ||
    !source.allowedSchemas.some((schema) => sameSchema(dataset.schema, schema)) ||
    dataset.artifactClass !== binding.artifactClass ||
    dataset.artifactPolicy !== source.artifactPolicy ||
    dataset.restrictions.sourcePolicies.length !== 1 ||
    policyStamp?.profileId !== profile.id ||
    policyStamp.profilePolicyVersion !== profile.policyVersion ||
    policyStamp.profilePolicyDigest !== profilePolicyDigest ||
    policyStamp.sourcePolicyId !== source.id ||
    dataset.restrictions.redistribution !== source.redistribution ||
    !sameStrings(
      dataset.restrictions.attributionRefs,
      expectedAttributionRefs,
    ) ||
    provenance.kind !== "source" ||
    provenance.producingStageId !== stageId ||
    provenance.profileId !== profile.id ||
    provenance.profilePolicyVersion !== profile.policyVersion ||
    provenance.profilePolicyDigest !== profilePolicyDigest ||
    provenance.sourcePolicyId !== binding.policyId ||
    provenance.sourceAdapter !== manifest.sourceAdapter ||
    provenance.effectClass !== binding.effectClass ||
    provenance.resourceUri !== binding.resourceUri ||
    !sameStrings(provenance.operations, binding.operations) ||
    provenance.outputPort !== outputPort ||
    !sameStrings(provenance.childIds, binding.childIds) ||
    !isCanonicalIsoInstant(dataset.retentionStartedAt)
  ) {
    throw new ApplyNotReadyError("Source dataset provenance does not match its binding");
  }

  if (
    dataset.expiresAt === null ||
    !isCanonicalIsoInstant(dataset.expiresAt) ||
    source.retentionDays === null
  ) {
    throw new ApplyNotReadyError("Source dataset expiry is missing or invalid");
  }
  const durationMs =
    new Date(dataset.expiresAt).valueOf() -
    new Date(dataset.retentionStartedAt).valueOf();
  const maxDays = Math.min(
    source.retentionDays,
    retentionCeiling(source, binding.artifactClass),
  );
  if (durationMs < 0 || durationMs > maxDays * 86_400_000) {
    throw new ApplyNotReadyError("Source dataset expiry exceeds its retention policy");
  }
}

export function assertBrokerAuditDataset(input: {
  dataset: DatasetRef;
  registry: DatasetRegistryVerifier;
}): void {
  const { dataset, registry } = input;
  if (
    !registry.verifyDataset(dataset) ||
    !dataset.brokerHandle ||
    dataset.artifactPolicy !== "restricted" ||
    dataset.artifactClass !== "audit_metadata" ||
    !sameSchema(dataset.schema, BROKER_AUDIT_SCHEMA) ||
    !sameStrings(dataset.fields, BROKER_AUDIT_FIELDS) ||
    dataset.recordCount !== 1 ||
    dataset.expiresAt !== null ||
    !isCanonicalIsoInstant(dataset.retentionStartedAt) ||
    dataset.restrictions.sourcePolicies.length !== 0 ||
    dataset.restrictions.redistribution !== "forbidden" ||
    dataset.restrictions.attributionRefs.length !== 0 ||
    dataset.provenance.kind !== "broker_audit" ||
    !dataset.provenance.runId ||
    !dataset.provenance.stageId
  ) {
    throw new ApplyNotReadyError(
      "Durable audit metadata must be broker-owned and minimal",
    );
  }
}

function assertStageOutputsRegistered(input: {
  stage: PipelineDefinition["stages"][number];
  manifest: StagePluginManifest;
  profile: ProfileDeclaration;
  inputs: Readonly<Record<string, DatasetHandle>>;
  outputs: Readonly<Record<string, DatasetHandle>>;
  registry: DatasetRegistryVerifier;
}): void {
  const { stage, manifest, profile, inputs, outputs, registry } = input;
  const inputDatasets = Object.values(inputs);
  for (const dataset of inputDatasets) {
    if (!registry.verifyDataset(dataset)) {
      throw new ApplyNotReadyError(
        `Stage ${stage.id} received an unregistered input`,
      );
    }
  }
  for (const [outputPort, dataset] of Object.entries(outputs)) {
    const declaration = manifest.outputs[outputPort];
    if (!declaration) {
      throw new ApplyNotReadyError(
        `Stage ${stage.id} returned undeclared output ${outputPort}`,
      );
    }
    if (
      !registry.verifyDataset(dataset) ||
      dataset.artifactPolicy !== declaration.artifactPolicy ||
      !sameSchema(dataset.schema, declaration.schema) ||
      (dataset.kind === "artifact" && dataset.artifactClass === "audit_metadata")
    ) {
      throw new ApplyNotReadyError(
        `Stage ${stage.id} returned an unregistered or incompatible output`,
      );
    }

    if (manifest.sourceAdapter !== null) {
      if (dataset.kind !== "artifact") {
        throw new ApplyNotReadyError(
          `Source stage ${stage.id} returned a non-finalized output`,
        );
      }
      const matchingBindings = (stage.sourceBindings ?? []).filter((binding) =>
        binding.outputPorts.includes(outputPort),
      );
      if (matchingBindings.length !== 1) {
        throw new ApplyNotReadyError(
          `Source output ${stage.id}.${outputPort} lacks one exact binding`,
        );
      }
      const binding = matchingBindings[0]!;
      const source = profile.sources.find(
        (candidate) => candidate.id === binding.policyId,
      );
      if (!source) {
        throw new ApplyNotReadyError(
          `Source output ${stage.id}.${outputPort} has no profile policy`,
        );
      }
      assertSourceDatasetBinding({
        dataset,
        binding,
        stageId: stage.id,
        outputPort,
        manifest,
        profile,
        source,
        registry,
      });
    } else if (dataset.kind === "artifact") {
      const parentDatasets = inputDatasets.filter(
        (candidate): candidate is DatasetRef => candidate.kind === "artifact",
      );
      if (parentDatasets.length !== inputDatasets.length || parentDatasets.length === 0) {
        throw new ApplyNotReadyError(
          `Internal output ${stage.id}.${outputPort} requires persisted parents`,
        );
      }
      const parentHandles = parentDatasets.map((parent) => parent.brokerHandle);
      const sourcePolicies = new Map<string, DatasetRestrictions["sourcePolicies"][number]>();
      const attributionRefs = new Set<string>();
      let redistribution: DatasetRestrictions["redistribution"] = "approved";
      let earliestExpiry = Number.POSITIVE_INFINITY;
      for (const parent of parentDatasets) {
        for (const stamp of parent.restrictions.sourcePolicies) {
          sourcePolicies.set(
            `${stamp.profileId}:${stamp.profilePolicyDigest}:${stamp.sourcePolicyId}`,
            stamp,
          );
        }
        for (const attributionRef of parent.restrictions.attributionRefs) {
          attributionRefs.add(attributionRef);
        }
        if (parent.restrictions.redistribution === "forbidden") {
          redistribution = "forbidden";
        }
        if (
          parent.expiresAt === null ||
          !isCanonicalIsoInstant(parent.expiresAt)
        ) {
          throw new ApplyNotReadyError(
            `Internal output ${stage.id}.${outputPort} cannot derive from non-expiring plugin data`,
          );
        }
        earliestExpiry = Math.min(
          earliestExpiry,
          new Date(parent.expiresAt).valueOf(),
        );
      }
      const expectedRestrictions: DatasetRestrictions = {
        sourcePolicies: [...sourcePolicies.values()].sort((left, right) =>
          `${left.profileId}:${left.profilePolicyDigest}:${left.sourcePolicyId}`.localeCompare(
            `${right.profileId}:${right.profilePolicyDigest}:${right.sourcePolicyId}`,
          ),
        ),
        redistribution,
        attributionRefs: [...attributionRefs].sort(),
      };
      const outputExpiry =
        dataset.expiresAt === null
          ? Number.POSITIVE_INFINITY
          : new Date(dataset.expiresAt).valueOf();
      if (
        dataset.provenance.kind !== "internal" ||
        dataset.provenance.producingStageId !== stage.id ||
        dataset.provenance.outputPort !== outputPort ||
        !sameStrings(dataset.provenance.parentHandles, parentHandles) ||
        digestObject(dataset.restrictions) !== digestObject(expectedRestrictions) ||
        !isCanonicalIsoInstant(dataset.retentionStartedAt) ||
        dataset.expiresAt === null ||
        !isCanonicalIsoInstant(dataset.expiresAt) ||
        outputExpiry > earliestExpiry
      ) {
        throw new ApplyNotReadyError(
          `Internal output ${stage.id}.${outputPort} did not preserve ancestry restrictions`,
        );
      }
    }
  }

  for (const [outputPort, declaration] of Object.entries(manifest.outputs)) {
    if (declaration.required !== false && !outputs[outputPort]) {
      throw new ApplyNotReadyError(
        `Stage ${stage.id} omitted required output ${outputPort}`,
      );
    }
  }
}

export interface ApplyReadinessInput {
  definition: PipelineDefinition;
  catalog: Readonly<Record<string, StagePluginManifest>>;
  profile: ProfileDeclaration;
  deployment: DeploymentManifest;
  hostPolicy: HostPolicyManifest;
}

export function assertApplyReady(
  input: ApplyReadinessInput,
): asserts input is ApplyReadinessInput & { profile: ActiveProfileDeclaration } {
  const { definition, catalog, profile, deployment, hostPolicy } = input;
  if (!profile.deploymentEnabled) {
    throw new ApplyNotReadyError(`Profile ${profile.id} is deployment-disabled`);
  }
  if (!deployment.enabled) {
    throw new ApplyNotReadyError("Deployment manifest is disabled");
  }
  if (definition.profile !== profile.id || deployment.profile !== profile.id) {
    throw new ApplyNotReadyError("Definition, profile, and deployment IDs differ");
  }
  if (
    !SHA256_DIGEST.test(deployment.definitionDigest) ||
    deployment.definitionDigest !== computeDefinitionDigest(definition) ||
    !SHA256_DIGEST.test(deployment.profilePolicyDigest) ||
    deployment.profilePolicyDigest !== computeProfilePolicyDigest(profile)
  ) {
    throw new ApplyNotReadyError(
      "Deployment definition/profile policy digests do not match",
    );
  }
  if (!deployment.deploymentIdentity) {
    throw new ApplyNotReadyError("Deployment identity is required");
  }
  if (
    !SHA256_DIGEST.test(profile.pluginLockDigest) ||
    computePluginCatalogDigest(catalog) !== profile.pluginLockDigest ||
    profile.pluginLockDigest !== deployment.pluginLockDigest
  ) {
    throw new ApplyNotReadyError("Trusted plugin-lock digests do not match");
  }

  if (
    !SHA256_DIGEST.test(deployment.hostPolicyDigest) ||
    computeHostPolicyDigest(hostPolicy) !== deployment.hostPolicyDigest
  ) {
    throw new ApplyNotReadyError("Trusted host-policy digest does not match");
  }
  if (
    !profile.targetContract.digest ||
    !SHA256_DIGEST.test(profile.targetContract.digest) ||
    profile.targetContract.digest !== deployment.targetContractDigest ||
    !profile.targetContract.supportedVersions.includes(
      deployment.targetContractVersion,
    )
  ) {
    throw new ApplyNotReadyError("Target contract binding is invalid");
  }
  if (deployment.secretProvider === "test_stub") {
    throw new ApplyNotReadyError("Production credentials are not configured");
  }

  const definitionIssues = validateDefinition(definition, catalog);
  if (definitionIssues.length) {
    throw new ApplyNotReadyError(
      `Pipeline definition is invalid: ${definitionIssues[0]?.path}`,
    );
  }

  if (
    !Number.isSafeInteger(profile.policyVersion) ||
    profile.policyVersion <= 0
  ) {
    throw new ApplyNotReadyError("Profile policy version is invalid");
  }
  const sourceIds = profile.sources.map((source) => source.id);
  const sourceNamespaces = profile.sources.map((source) => source.namespace);
  if (
    sourceIds.some((id) => !id) ||
    sourceNamespaces.some((namespace) => !namespace) ||
    new Set(sourceIds).size !== sourceIds.length ||
    new Set(sourceNamespaces).size !== sourceNamespaces.length
  ) {
    throw new ApplyNotReadyError(
      "Active profile source IDs and namespaces must be non-empty and unique",
    );
  }
  const sourcesById = new Map(profile.sources.map((source) => [source.id, source]));
  for (const stage of definition.stages) {
    const manifest = catalog[stage.uses];
    for (const binding of stage.sourceBindings ?? []) {
      const source = sourcesById.get(binding.policyId);
      if (!source) {
        throw new ApplyNotReadyError(
          `Stage ${stage.id} references unknown source policy ${binding.policyId}`,
        );
      }
      const retention = source.provisionalRetention;
      const upstreamChildIds = source.upstreamTerms.map((item) => item.childId);
      const upstreamTermsAreValid = source.upstreamTerms.every(
        (item) => item.childId && item.termsRef,
      );
      const schemaKeys = source.allowedSchemas.map(
        (schema) => `${schema.name}@${schema.version}`,
      );
      const allowedSchemasAreValid = source.allowedSchemas.every(
        (schema) =>
          schema.name &&
          Number.isSafeInteger(schema.version) &&
          schema.version > 0,
      );
      const outputsMatchPolicy = binding.outputPorts.every(
        (outputPort) => {
          const output = manifest?.outputs[outputPort];
          return (
            output?.artifactPolicy === source.artifactPolicy &&
            source.allowedSchemas.some((schema) =>
              sameSchema(output.schema, schema),
            )
          );
        },
      );
      if (
        !manifest ||
        manifest.sourceAdapter !== source.adapter ||
        !source.resourceUris.includes(binding.resourceUri) ||
        new Set(source.resourceUris).size !== source.resourceUris.length ||
        !allowedSchemasAreValid ||
        source.allowedSchemas.length === 0 ||
        new Set(schemaKeys).size !== schemaKeys.length ||
        !upstreamTermsAreValid ||
        new Set(upstreamChildIds).size !== upstreamChildIds.length ||
        !validProvisionalCeilings(source) ||
        source.policyStatus !== "approved" ||
        !source.termsRef ||
        !source.attributionRef ||
        source.artifactPolicy === "forbidden" ||
        source.artifactPolicy !== retention.postApprovalArtifactPolicy ||
        (binding.artifactClass === "raw" &&
          source.artifactPolicy === "derived_only") ||
        !outputsMatchPolicy ||
        source.retentionDays === null ||
        !Number.isSafeInteger(source.retentionDays) ||
        source.retentionDays < 0 ||
        source.retentionDays > retentionCeiling(source, binding.artifactClass) ||
        source.allowedFields.length === 0 ||
        (retention.upstreamTermsMode === "per_child" &&
          (binding.childIds.length === 0 ||
            binding.childIds.some(
              (childId) => !upstreamChildIds.includes(childId),
            ))) ||
        (source.adapter === "official-website" &&
          (retention.rawMaxDays !== 0 ||
            source.artifactPolicy !== "derived_only" ||
            binding.artifactClass === "raw"))
      ) {
        throw new ApplyNotReadyError(
          `Referenced source policy ${binding.policyId} is not approved for this output`,
        );
      }
    }
  }

  for (const [name, value] of Object.entries(hostPolicy.limits)) {
    const mayBeZero = name === "maxChildProcesses";
    if (
      !Number.isSafeInteger(value) ||
      value < (mayBeZero ? 0 : 1)
    ) {
      throw new ApplyNotReadyError(`Host limit ${name} is invalid`);
    }
  }
  if (!hostPolicy.id || !Number.isSafeInteger(hostPolicy.version) || hostPolicy.version <= 0) {
    throw new ApplyNotReadyError("Host policy identity is invalid");
  }
  for (const [name, group] of Object.entries(hostPolicy.admissionGroups)) {
    if (!name || !Number.isSafeInteger(group.maxConcurrency) || group.maxConcurrency <= 0) {
      throw new ApplyNotReadyError(`Admission group ${name} is invalid`);
    }
  }

  for (const stage of definition.stages) {
    if (!hostPolicy.admissionGroups[stage.resources.admissionGroup]) {
      throw new ApplyNotReadyError(
        `Unknown admission group ${stage.resources.admissionGroup}`,
      );
    }
    for (const request of stage.requestedEffects ?? []) {
      if (
        !profile.effectPolicy.some((policy) =>
          policyMatches(policy, stage.id, request),
        )
      ) {
        throw new ApplyNotReadyError(
          `Profile policy does not allow ${stage.id}:${request.effectClass}`,
        );
      }
      if (
        !deployment.effectAuthorizations.some((grant) =>
          grantMatches(grant, profile, deployment, stage.id, request),
        )
      ) {
        throw new ApplyNotReadyError(
          `Deployment does not grant ${stage.id}:${request.effectClass}`,
        );
      }
    }
  }

  for (const grant of deployment.effectAuthorizations) {
    const stage = definition.stages.find((candidate) => candidate.id === grant.stageId);
    if (
      !stage ||
      !stage.requestedEffects?.some((request) =>
        grantMatches(grant, profile, deployment, stage.id, request),
      )
    ) {
      throw new ApplyNotReadyError(
        `Deployment contains an unused grant for ${grant.stageId}:${grant.effectClass}`,
      );
    }
  }
}

function freezeRecursively<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeRecursively(child);
    Object.freeze(value);
  }
  return value;
}

const CONTEXT_TOKEN = Symbol("apply-authorization-context");
declare const AUTHORIZED_STAGE_INVOCATION: unique symbol;
declare const AUTHORIZED_OUTPUT_MUTATION: unique symbol;
declare const AUTHORIZED_STATE_MUTATION: unique symbol;

export interface AuthorizedStageInvocation {
  readonly [AUTHORIZED_STAGE_INVOCATION]: true;
  readonly kind: "authorized_stage_invocation";
  readonly brokerHandle: string;
  readonly runId: string;
  readonly stageRunId: string;
  readonly stageId: string;
}

export interface AuthorizedOutputMutationSubject {
  readonly [AUTHORIZED_OUTPUT_MUTATION]: true;
  readonly kind: "authorized_output_mutation";
  readonly brokerHandle: string;
  readonly outputPort: string;
}

export interface AuthorizedStateMutationSubject {
  readonly [AUTHORIZED_STATE_MUTATION]: true;
  readonly kind: "authorized_state_mutation";
  readonly brokerHandle: string;
  readonly proposalDigest: string;
}

interface StageInvocationSnapshot {
  owner: object;
  stage: PipelineDefinition["stages"][number];
  manifest: StagePluginManifest;
  inputs: Readonly<Record<string, DatasetHandle>>;
}

const STAGE_INVOCATIONS = new WeakMap<
  AuthorizedStageInvocation,
  StageInvocationSnapshot
>();
interface MutationSubjectSnapshot<T> {
  owner: object;
  invocation: AuthorizedStageInvocation;
  authoritativeRecordCount: number;
  consumed: boolean;
  detail: T;
}

const OUTPUT_MUTATIONS = new WeakMap<
  AuthorizedOutputMutationSubject,
  MutationSubjectSnapshot<{ outputPort: string; stagedArtifactHandle: string }>
>();
const STATE_MUTATIONS = new WeakMap<
  AuthorizedStateMutationSubject,
  MutationSubjectSnapshot<{ proposalDigest: string }>
>();
let stageInvocationSequence = 0;
let mutationSubjectSequence = 0;

interface AuthorizedEffectAttemptBase {
  invocation: AuthorizedStageInvocation;
  stageId: string;
  resourceUri: string;
  operation: string;
}

export interface AuthorizedReadEffectAttempt extends AuthorizedEffectAttemptBase {
  effectClass: "network.read" | "artifact.read";
  /** Supplied by the trusted broker from broker-owned operation metadata. */
  authoritativeRecordCount: number;
}

export interface AuthorizedMutationEffectAttempt
  extends AuthorizedEffectAttemptBase {
  effectClass: Extract<
    EffectRequest["effectClass"],
    "canonical.write" | "public.write"
  >;
  subject: DatasetHandle;
}

export interface AuthorizedOutputEffectAttempt
  extends AuthorizedEffectAttemptBase {
  effectClass: Extract<
    EffectRequest["effectClass"],
    "artifact.write" | "evidence.write" | "review.write"
  >;
  subject: AuthorizedOutputMutationSubject;
}

export interface AuthorizedStateEffectAttempt
  extends AuthorizedEffectAttemptBase {
  effectClass: "state.write";
  subject: AuthorizedStateMutationSubject;
}

export type AuthorizedEffectAttempt =
  | AuthorizedReadEffectAttempt
  | AuthorizedMutationEffectAttempt
  | AuthorizedOutputEffectAttempt
  | AuthorizedStateEffectAttempt;

export class ApplyAuthorizationContext {
  readonly profile: string;
  readonly deploymentIdentity: string;
  readonly hostPolicyDigest: string;
  readonly #definition: PipelineDefinition;
  readonly #catalog: Readonly<Record<string, StagePluginManifest>>;
  readonly #profile: ActiveProfileDeclaration;
  readonly #deployment: DeploymentManifest;
  readonly #hostPolicy: HostPolicyManifest;
  readonly #usedStageRunIds = new Set<string>();

  private constructor(
    token: symbol,
    snapshot: {
      definition: PipelineDefinition;
      catalog: Readonly<Record<string, StagePluginManifest>>;
      profile: ActiveProfileDeclaration;
      deployment: DeploymentManifest;
      hostPolicy: HostPolicyManifest;
    },
  ) {
    if (token !== CONTEXT_TOKEN) throw new TypeError("Invalid authorization context");
    this.#definition = snapshot.definition;
    this.#catalog = snapshot.catalog;
    this.#profile = snapshot.profile;
    this.#deployment = snapshot.deployment;
    this.#hostPolicy = snapshot.hostPolicy;
    this.profile = snapshot.definition.profile;
    this.deploymentIdentity = snapshot.deployment.deploymentIdentity;
    this.hostPolicyDigest = computeHostPolicyDigest(snapshot.hostPolicy);
    Object.freeze(this);
  }

  static create(input: ApplyReadinessInput): ApplyAuthorizationContext {
    assertApplyReady(input);
    const snapshot = freezeRecursively(structuredClone({
      definition: input.definition,
      catalog: input.catalog,
      profile: input.profile,
      deployment: input.deployment,
      hostPolicy: input.hostPolicy,
    }));
    return new ApplyAuthorizationContext(CONTEXT_TOKEN, snapshot);
  }

  beginStageInvocation(input: {
    runId: string;
    stageRunId: string;
    stageId: string;
    inputs: Readonly<Record<string, DatasetHandle>>;
    registry: DatasetRegistryVerifier;
  }): AuthorizedStageInvocation {
    if (
      !input.runId ||
      !input.stageRunId ||
      this.#usedStageRunIds.has(input.stageRunId)
    ) {
      throw new ApplyNotReadyError(
        "Stage invocation requires a unique run/stage-run identity",
      );
    }
    const stage = this.#definition.stages.find(
      (candidate) => candidate.id === input.stageId,
    );
    const manifest = stage ? this.#catalog[stage.uses] : undefined;
    if (!stage || !manifest) {
      throw new ApplyNotReadyError(
        `Unknown authorized stage ${input.stageId}`,
      );
    }
    const declaredInputs = stage.inputs ?? {};
    for (const [inputPort, declaration] of Object.entries(manifest.inputs)) {
      const reference = declaredInputs[inputPort];
      const dataset = input.inputs[inputPort];
      if (!reference) {
        if (declaration.required !== false || dataset) {
          throw new ApplyNotReadyError(
            `Stage ${stage.id} input ${inputPort} is not exactly declared`,
          );
        }
        continue;
      }
      if (!dataset || !input.registry.verifyDataset(dataset)) {
        throw new ApplyNotReadyError(
          `Stage ${stage.id} input ${inputPort} is missing or unregistered`,
        );
      }
      if (dataset.kind !== "artifact") {
        throw new ApplyNotReadyError(
          `Stage ${stage.id} input ${inputPort} must be a finalized artifact`,
        );
      }
      if (
        !isCanonicalIsoInstant(dataset.retentionStartedAt) ||
        dataset.expiresAt === null ||
        !isCanonicalIsoInstant(dataset.expiresAt) ||
        new Date(dataset.retentionStartedAt).valueOf() >
          new Date(dataset.expiresAt).valueOf() ||
        new Date(dataset.expiresAt).valueOf() <= Date.now()
      ) {
        throw new ApplyNotReadyError(
          `Stage ${stage.id} input ${inputPort} is expired or has invalid retention timestamps`,
        );
      }
      const profilePolicyDigest = computeProfilePolicyDigest(this.#profile);
      const stampKeys = dataset.restrictions.sourcePolicies.map(
        (stamp) => `${stamp.profileId}:${stamp.profilePolicyDigest}:${stamp.sourcePolicyId}`,
      );
      if (
        stampKeys.length === 0 ||
        new Set(stampKeys).size !== stampKeys.length ||
        dataset.restrictions.sourcePolicies.some(
          (stamp) =>
            stamp.profileId !== this.#profile.id ||
            stamp.profilePolicyVersion !== this.#profile.policyVersion ||
            stamp.profilePolicyDigest !== profilePolicyDigest ||
            !this.#profile.sources.some(
              (source) => source.id === stamp.sourcePolicyId,
            ),
        )
      ) {
        throw new ApplyNotReadyError(
          `Stage ${stage.id} input ${inputPort} has foreign or stale policy ancestry`,
        );
      }
      const [producerStageId, outputPort, ...extra] = reference.split(".");
      const provenance = dataset.provenance;
      if (
        !producerStageId ||
        !outputPort ||
        extra.length > 0 ||
        !provenance ||
        provenance.kind === "broker_audit" ||
        provenance.producingStageId !== producerStageId ||
        provenance.outputPort !== outputPort ||
        dataset.artifactPolicy !== declaration.artifactPolicy ||
        !sameSchema(dataset.schema, declaration.schema)
      ) {
        throw new ApplyNotReadyError(
          `Stage ${stage.id} input ${inputPort} does not match ${reference}`,
        );
      }
    }
    for (const inputPort of Object.keys(input.inputs)) {
      if (!manifest.inputs[inputPort] || !declaredInputs[inputPort]) {
        throw new ApplyNotReadyError(
          `Stage ${stage.id} received undeclared input ${inputPort}`,
        );
      }
    }

    const handle = Object.freeze({
      kind: "authorized_stage_invocation",
      brokerHandle: `invocation:${stage.id}:${++stageInvocationSequence}`,
      runId: input.runId,
      stageRunId: input.stageRunId,
      stageId: stage.id,
    }) as unknown as AuthorizedStageInvocation;
    this.#usedStageRunIds.add(input.stageRunId);
    STAGE_INVOCATIONS.set(handle, {
      owner: this,
      stage,
      manifest,
      inputs: freezeRecursively(structuredClone(input.inputs)),
    });
    return handle;
  }

  closeStageInvocation(invocation: AuthorizedStageInvocation): void {
    this.#invocationSnapshot(invocation);
    STAGE_INVOCATIONS.delete(invocation);
  }

  #invocationSnapshot(
    invocation: AuthorizedStageInvocation,
  ): StageInvocationSnapshot {
    const snapshot = STAGE_INVOCATIONS.get(invocation);
    if (!snapshot || snapshot.owner !== this) {
      throw new ApplyNotReadyError(
        "Stage invocation is not owned by this authorization context",
      );
    }
    return snapshot;
  }

  bindOutputMutationSubject(input: {
    invocation: AuthorizedStageInvocation;
    outputPort: string;
    stagedArtifactHandle: string;
    authoritativeRecordCount: number;
  }): AuthorizedOutputMutationSubject {
    const { manifest } = this.#invocationSnapshot(input.invocation);
    if (!manifest.outputs[input.outputPort]) {
      throw new ApplyNotReadyError(
        `Cannot bind undeclared output ${input.outputPort}`,
      );
    }
    if (!input.stagedArtifactHandle) {
      throw new ApplyNotReadyError("Staged artifact handle is required");
    }
    if (
      !Number.isSafeInteger(input.authoritativeRecordCount) ||
      input.authoritativeRecordCount < 0
    ) {
      throw new ApplyNotReadyError(
        "Output mutation record count must be a non-negative safe integer",
      );
    }
    const subject = Object.freeze({
      kind: "authorized_output_mutation",
      brokerHandle: `output-mutation:${++mutationSubjectSequence}`,
      outputPort: input.outputPort,
    }) as unknown as AuthorizedOutputMutationSubject;
    OUTPUT_MUTATIONS.set(subject, {
      owner: this,
      invocation: input.invocation,
      authoritativeRecordCount: input.authoritativeRecordCount,
      consumed: false,
      detail: {
        outputPort: input.outputPort,
        stagedArtifactHandle: input.stagedArtifactHandle,
      },
    });
    return subject;
  }

  bindStateMutationSubject(input: {
    invocation: AuthorizedStageInvocation;
    proposalDigest: string;
    authoritativeRecordCount: number;
  }): AuthorizedStateMutationSubject {
    this.#invocationSnapshot(input.invocation);
    if (!SHA256_DIGEST.test(input.proposalDigest)) {
      throw new ApplyNotReadyError("State proposal digest is invalid");
    }
    if (
      !Number.isSafeInteger(input.authoritativeRecordCount) ||
      input.authoritativeRecordCount < 0
    ) {
      throw new ApplyNotReadyError(
        "State mutation record count must be a non-negative safe integer",
      );
    }
    const subject = Object.freeze({
      kind: "authorized_state_mutation",
      brokerHandle: `state-mutation:${++mutationSubjectSequence}`,
      proposalDigest: input.proposalDigest,
    }) as unknown as AuthorizedStateMutationSubject;
    STATE_MUTATIONS.set(subject, {
      owner: this,
      invocation: input.invocation,
      authoritativeRecordCount: input.authoritativeRecordCount,
      consumed: false,
      detail: { proposalDigest: input.proposalDigest },
    });
    return subject;
  }

  authorizeEffect(
    attempt: AuthorizedEffectAttempt,
    registry: DatasetRegistryVerifier,
  ): void {
    const invocation = this.#invocationSnapshot(attempt.invocation);
    const { stage, manifest } = invocation;
    if (stage.id !== attempt.stageId) {
      throw new ApplyNotReadyError(
        `Effect stage ${attempt.stageId} does not own this invocation`,
      );
    }
    let recordCount: number;
    let mutationSubject:
      | MutationSubjectSnapshot<{
          outputPort: string;
          stagedArtifactHandle: string;
        }>
      | MutationSubjectSnapshot<{ proposalDigest: string }>
      | undefined;
    if (
      attempt.effectClass === "network.read" ||
      attempt.effectClass === "artifact.read"
    ) {
      recordCount = attempt.authoritativeRecordCount;
    } else if (
      attempt.effectClass === "canonical.write" ||
      attempt.effectClass === "public.write"
    ) {
      recordCount = attempt.subject.recordCount;
      if (!registry.verifyDataset(attempt.subject)) {
        throw new ApplyNotReadyError("Mutation subject is not broker-registered");
      }
      if (
        !Object.values(invocation.inputs).some(
          (dataset) => dataset.brokerHandle === attempt.subject.brokerHandle,
        )
      ) {
        throw new ApplyNotReadyError(
          "Mutation subject is not an input of this stage invocation",
        );
      }
      if (
        attempt.subject.kind !== "artifact" ||
        attempt.subject.expiresAt === null ||
        !isCanonicalIsoInstant(attempt.subject.expiresAt) ||
        new Date(attempt.subject.expiresAt).valueOf() <= Date.now()
      ) {
        throw new ApplyNotReadyError(
          "Consumer writes require an unexpired artifact input",
        );
      }
      if (
        attempt.effectClass === "public.write" &&
        (attempt.subject.restrictions.redistribution !== "approved" ||
          attempt.subject.restrictions.sourcePolicies.length === 0 ||
          attempt.subject.restrictions.sourcePolicies.some(
            (stamp) =>
              stamp.profileId !== this.#profile.id ||
              stamp.profilePolicyVersion !== this.#profile.policyVersion ||
              stamp.profilePolicyDigest !==
                computeProfilePolicyDigest(this.#profile) ||
              this.#profile.sources.find(
                (source) => source.id === stamp.sourcePolicyId,
              )?.redistribution !== "approved",
          ))
      ) {
        throw new ApplyNotReadyError(
          "Public writes require an unexpired, redistribution-approved subject",
        );
      }
    } else if (
      attempt.effectClass === "artifact.write" ||
      attempt.effectClass === "evidence.write" ||
      attempt.effectClass === "review.write"
    ) {
      mutationSubject = OUTPUT_MUTATIONS.get(attempt.subject);
      if (
        !mutationSubject ||
        mutationSubject.owner !== this ||
        mutationSubject.invocation !== attempt.invocation ||
        mutationSubject.detail.outputPort !== attempt.subject.outputPort ||
        mutationSubject.consumed
      ) {
        throw new ApplyNotReadyError(
          "Output mutation subject is invalid, foreign, or already consumed",
        );
      }
      recordCount = mutationSubject.authoritativeRecordCount;
    } else if (attempt.effectClass === "state.write") {
      mutationSubject = STATE_MUTATIONS.get(attempt.subject);
      if (
        !mutationSubject ||
        mutationSubject.owner !== this ||
        mutationSubject.invocation !== attempt.invocation ||
        mutationSubject.detail.proposalDigest !==
          attempt.subject.proposalDigest ||
        mutationSubject.consumed
      ) {
        throw new ApplyNotReadyError(
          "State mutation subject is invalid, foreign, or already consumed",
        );
      }
      recordCount = mutationSubject.authoritativeRecordCount;
    } else {
      throw new ApplyNotReadyError("Unsupported effect class");
    }
    assertEffectAuthorizedInternal({
      mode: "apply",
      profile: this.profile,
      stageId: stage.id,
      deploymentIdentity: this.deploymentIdentity,
      manifest,
      grants: this.#deployment.effectAuthorizations,
      request: {
        effectClass: attempt.effectClass,
        resourceUri: attempt.resourceUri,
        operation: attempt.operation,
        recordCount,
      },
    });
    if (mutationSubject) mutationSubject.consumed = true;
  }

  validateStageOutputs(input: {
    invocation: AuthorizedStageInvocation;
    outputs: Readonly<Record<string, DatasetHandle>>;
    registry: DatasetRegistryVerifier;
  }): void {
    const { stage, manifest, inputs } = this.#invocationSnapshot(
      input.invocation,
    );
    assertStageOutputsRegistered({
      stage,
      manifest,
      profile: this.#profile,
      inputs,
      outputs: input.outputs,
      registry: input.registry,
    });
  }

  evaluateAdmission(input: {
    active: readonly ResourceReservation[];
    candidate: ResourceReservation;
    observedFreeDiskBytes: number;
  }): AdmissionDecision {
    return evaluateAdmission({
      limits: {
        ...this.#hostPolicy.limits,
        groups: this.#hostPolicy.admissionGroups,
      },
      ...input,
    });
  }
}

export function createApplyAuthorizationContext(
  input: ApplyReadinessInput,
): ApplyAuthorizationContext {
  return ApplyAuthorizationContext.create(input);
}
