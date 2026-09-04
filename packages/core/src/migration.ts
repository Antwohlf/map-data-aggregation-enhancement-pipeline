export type LegacyStateKind =
  | "planner_state"
  | "acquisition_manifest"
  | "delivery_checkpoint"
  | "worker_queue";

export interface LegacyStateDescriptor {
  kind: LegacyStateKind;
  contentDigest: string;
  schemaVersion: number;
  sourcePathDigest: string;
  profile: string | null;
  target: string | null;
  referencedArtifacts: Array<{
    contentDigest: string;
    relocatable: boolean;
  }>;
}

export interface LegacyImportBinding {
  kind: LegacyStateKind;
  profile: string;
  target: string;
  expectedContentDigest: string;
  expectedSourcePathDigest: string;
  supportedSchemaVersions: number[];
}

export interface BoundLegacyStateDescriptor
  extends Omit<
    LegacyStateDescriptor,
    "profile" | "target" | "referencedArtifacts"
  > {
  readonly profile: string;
  readonly target: string;
  readonly referencedArtifacts: ReadonlyArray<
    Readonly<{
      contentDigest: string;
      relocatable: boolean;
    }>
  >;
}

const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;

function freezeRecursively<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeRecursively(child);
    Object.freeze(value);
  }
  return value;
}

export function bindLegacyImport(
  descriptor: LegacyStateDescriptor,
  binding: LegacyImportBinding,
): BoundLegacyStateDescriptor {
  if (descriptor.kind !== binding.kind) {
    throw new TypeError("Legacy state kind does not match the import binding");
  }
  for (const [name, value] of [
    ["content", descriptor.contentDigest],
    ["source path", descriptor.sourcePathDigest],
    ["expected content", binding.expectedContentDigest],
    ["expected source path", binding.expectedSourcePathDigest],
  ] as const) {
    if (!SHA256_DIGEST.test(value)) {
      throw new TypeError(`Legacy ${name} digest is invalid`);
    }
  }
  if (descriptor.contentDigest !== binding.expectedContentDigest) {
    throw new TypeError("Legacy state digest does not match the import binding");
  }
  if (descriptor.sourcePathDigest !== binding.expectedSourcePathDigest) {
    throw new TypeError("Legacy source path does not match the import binding");
  }
  if (!binding.supportedSchemaVersions.includes(descriptor.schemaVersion)) {
    throw new TypeError("Legacy state schema version is unsupported");
  }
  if (descriptor.profile !== null && descriptor.profile !== binding.profile) {
    throw new TypeError("Legacy state profile does not match the import binding");
  }
  if (descriptor.target !== null && descriptor.target !== binding.target) {
    throw new TypeError("Legacy state target does not match the import binding");
  }
  for (const artifact of descriptor.referencedArtifacts) {
    if (!SHA256_DIGEST.test(artifact.contentDigest)) {
      throw new TypeError("Legacy artifact digest is invalid");
    }
    if (!artifact.relocatable) {
      throw new TypeError("Legacy state contains an unrelocatable artifact reference");
    }
  }

  return freezeRecursively({
    ...structuredClone(descriptor),
    profile: binding.profile,
    target: binding.target,
  });
}

export type QueueRole =
  | "producer"
  | "consumer"
  | "reconciler"
  | "retry_feeder"
  | "manual_writer"
  | "observer";

export interface ServiceTopologyEntry {
  id: string;
  profile: string | "shared";
  mode: "observe" | "preview" | "apply";
  desiredSchedule: ServiceSchedule | null;
  liveSchedule: ServiceSchedule | null;
  desiredState: "present" | "absent";
  liveState: "loaded" | "unloaded" | "unknown";
  definitionPresent: boolean;
  desiredCommandDigest: string | null;
  liveCommandDigest: string | null;
  queueRoles: QueueRole[];
  queueBindings: Array<{
    queueId: string;
    storeUri: string;
    lockIdentity: string;
    producesTasks: string[];
    consumesTasks: string[];
  }>;
  targetWriteScopes: string[];
  stateRefs: string[];
  admissionGroups: string[];
  credentialRefs: string[];
}

export type ServiceSchedule =
  | { kind: "persistent" }
  | { kind: "interval"; everyMs: number }
  | { kind: "calendar"; expression: string }
  | { kind: "manual" };

export function queueMutators(
  services: readonly ServiceTopologyEntry[],
): ServiceTopologyEntry[] {
  const mutatingRoles = new Set<QueueRole>([
    "producer",
    "consumer",
    "reconciler",
    "retry_feeder",
    "manual_writer",
  ]);
  return services.filter((service) =>
    service.queueRoles.some((role) => mutatingRoles.has(role)),
  );
}

export interface TopologyCutoverEvidence {
  claimsReconciled: boolean;
  enqueueRoutingSwitched: boolean;
  legacyWritersDisabled: boolean;
}

export function topologyCutoverIssues(
  services: readonly ServiceTopologyEntry[],
  evidence: TopologyCutoverEvidence,
): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  const loadedWriters = new Map<string, string>();
  for (const service of services) {
    if (!service.id || seen.has(service.id)) {
      issues.push(`service ID is empty or duplicated: ${service.id}`);
    }
    seen.add(service.id);
    for (const [origin, schedule] of [
      ["desired", service.desiredSchedule],
      ["live", service.liveSchedule],
    ] as const) {
      if (
        schedule?.kind === "interval" &&
        (!Number.isSafeInteger(schedule.everyMs) || schedule.everyMs <= 0)
      ) {
        issues.push(`${service.id} has an invalid ${origin} interval`);
      }
      if (schedule?.kind === "calendar" && !schedule.expression.trim()) {
        issues.push(`${service.id} has an empty ${origin} calendar expression`);
      }
    }
    if (
      service.desiredSchedule &&
      service.liveSchedule &&
      JSON.stringify(service.desiredSchedule) !== JSON.stringify(service.liveSchedule)
    ) {
      issues.push(`${service.id} desired/live schedules differ`);
    }
    if (service.desiredState === "present" && service.liveState !== "loaded") {
      issues.push(`${service.id} is desired but not loaded`);
    }
    if (service.desiredState === "present" && !service.desiredSchedule) {
      issues.push(`${service.id} is missing its desired schedule`);
    }
    if (service.liveState === "loaded" && !service.liveSchedule) {
      issues.push(`${service.id} is missing its live schedule`);
    }
    if (service.desiredState === "present" && !service.desiredCommandDigest) {
      issues.push(`${service.id} is missing its desired command digest`);
    }
    if (service.liveState === "loaded" && !service.liveCommandDigest) {
      issues.push(`${service.id} is missing its live command digest`);
    }
    for (const [origin, commandDigest] of [
      ["desired", service.desiredCommandDigest],
      ["live", service.liveCommandDigest],
    ] as const) {
      if (commandDigest && !SHA256_DIGEST.test(commandDigest)) {
        issues.push(`${service.id} has an invalid ${origin} command digest`);
      }
    }
    if (service.desiredState === "absent" && service.liveState === "loaded") {
      issues.push(`${service.id} is loaded but not desired`);
    }
    if (service.liveState === "loaded" && !service.definitionPresent) {
      issues.push(`${service.id} is loaded without a service definition`);
    }
    if (
      service.desiredCommandDigest &&
      service.liveCommandDigest &&
      service.desiredCommandDigest !== service.liveCommandDigest
    ) {
      issues.push(`${service.id} desired/live command digests differ`);
    }

    const mutator = queueMutators([service]).length === 1;
    if (mutator && service.queueBindings.length === 0) {
      issues.push(`${service.id} mutates a queue without a queue binding`);
    }
    if (
      service.queueRoles.includes("producer") &&
      !service.queueBindings.some((binding) => binding.producesTasks.length > 0)
    ) {
      issues.push(`${service.id} is a producer without produced task types`);
    }
    if (
      service.queueRoles.some((role) =>
        ["consumer", "reconciler", "retry_feeder"].includes(role),
      ) &&
      !service.queueBindings.some((binding) => binding.consumesTasks.length > 0)
    ) {
      issues.push(`${service.id} consumes queue state without task types`);
    }
    if (
      service.queueRoles.includes("manual_writer") &&
      service.targetWriteScopes.length === 0
    ) {
      issues.push(`${service.id} is a manual writer without a target scope`);
    }
    if (service.liveState === "loaded" && service.mode === "apply") {
      for (const scope of service.targetWriteScopes) {
        if (!scope) {
          issues.push(`${service.id} has an empty target write scope`);
          continue;
        }
        const existingWriter = loadedWriters.get(scope);
        if (existingWriter) {
          issues.push(
            `${service.id} and ${existingWriter} are both loaded writers for ${scope}`,
          );
        } else {
          loadedWriters.set(scope, service.id);
        }
      }
    }
    for (const binding of service.queueBindings) {
      if (!binding.queueId || !binding.storeUri || !binding.lockIdentity) {
        issues.push(`${service.id} has an incomplete queue/store/lock binding`);
      }
    }
  }
  if (!evidence.claimsReconciled) issues.push("active queue claims are not reconciled");
  if (!evidence.enqueueRoutingSwitched) issues.push("enqueue routing is not switched");
  if (!evidence.legacyWritersDisabled) issues.push("legacy writers are not disabled");
  return issues;
}
