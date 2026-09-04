import type {
  ActiveProfileDeclaration,
  DeploymentManifest,
  EffectAuthorization,
  EffectPolicy,
  EffectRequestDeclaration,
  EffectRequest,
  HostPolicyManifest,
  PipelineDefinition,
  ProfileDeclaration,
  ResourceReservation,
  StagePluginManifest,
} from "./types.js";
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

  const sourcesById = new Map(profile.sources.map((source) => [source.id, source]));
  for (const stage of definition.stages) {
    for (const sourcePolicyId of stage.sourcePolicyIds ?? []) {
      const source = sourcesById.get(sourcePolicyId);
      if (!source) {
        throw new ApplyNotReadyError(
          `Stage ${stage.id} references unknown source policy ${sourcePolicyId}`,
        );
      }
      const retention = source.provisionalRetention;
      const effectiveCeiling =
        source.artifactPolicy === "derived_only"
          ? retention.derivedMaxDays
          : retention.rawMaxDays;
      if (
        source.policyStatus !== "approved" ||
        !source.termsRef ||
        source.artifactPolicy === "forbidden" ||
        source.artifactPolicy !== retention.postApprovalArtifactPolicy ||
        source.retentionDays === null ||
        !Number.isSafeInteger(source.retentionDays) ||
        source.retentionDays < 0 ||
        source.retentionDays > effectiveCeiling ||
        source.allowedFields.length === 0 ||
        (retention.upstreamTermsMode === "per_child" &&
          source.upstreamTermsRefs.length === 0) ||
        (source.adapter === "official-website" &&
          (retention.rawMaxDays !== 0 ||
            source.artifactPolicy !== "derived_only"))
      ) {
        throw new ApplyNotReadyError(
          `Referenced source policy ${sourcePolicyId} is not approved`,
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

export interface AuthorizedEffectAttempt
  extends Omit<EffectRequest, "recordCount"> {
  stageId: string;
  /** Supplied by the trusted broker from broker-owned operation metadata. */
  authoritativeRecordCount: number;
}

export class ApplyAuthorizationContext {
  readonly profile: string;
  readonly deploymentIdentity: string;
  readonly hostPolicyDigest: string;
  readonly #definition: PipelineDefinition;
  readonly #catalog: Readonly<Record<string, StagePluginManifest>>;
  readonly #deployment: DeploymentManifest;
  readonly #hostPolicy: HostPolicyManifest;

  private constructor(
    token: symbol,
    snapshot: {
      definition: PipelineDefinition;
      catalog: Readonly<Record<string, StagePluginManifest>>;
      deployment: DeploymentManifest;
      hostPolicy: HostPolicyManifest;
    },
  ) {
    if (token !== CONTEXT_TOKEN) throw new TypeError("Invalid authorization context");
    this.#definition = snapshot.definition;
    this.#catalog = snapshot.catalog;
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
      deployment: input.deployment,
      hostPolicy: input.hostPolicy,
    }));
    return new ApplyAuthorizationContext(CONTEXT_TOKEN, snapshot);
  }

  authorizeEffect(attempt: AuthorizedEffectAttempt): void {
    const stage = this.#definition.stages.find(
      (candidate) => candidate.id === attempt.stageId,
    );
    const manifest = stage ? this.#catalog[stage.uses] : undefined;
    if (!stage || !manifest) {
      throw new ApplyNotReadyError(`Unknown authorized stage ${attempt.stageId}`);
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
        recordCount: attempt.authoritativeRecordCount,
      },
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
