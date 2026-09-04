import { createHash } from "node:crypto";

import type { PipelineMode } from "./types.js";

type JsonPrimitive = null | boolean | number | string;
export type CanonicalJson =
  | JsonPrimitive
  | CanonicalJson[]
  | { [key: string]: CanonicalJson };

function normalize(value: CanonicalJson): CanonicalJson {
  if (Array.isArray(value)) {
    return value.map(normalize);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, normalize(child)]),
    );
  }

  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("Canonical JSON cannot contain a non-finite number");
  }

  return value;
}

export function canonicalize(value: CanonicalJson): string {
  return JSON.stringify(normalize(value));
}

export function digest(value: CanonicalJson): string {
  const hex = createHash("sha256").update(canonicalize(value)).digest("hex");
  return `sha256:${hex}`;
}

export function createSourceRecordKey(input: {
  profile: string;
  sourceNamespace: string;
  externalId: string;
}): string {
  for (const [label, value] of Object.entries(input)) {
    if (!value || value.trim() !== value || value.normalize("NFC") !== value) {
      throw new TypeError(`${label} must be non-empty, trimmed, NFC text`);
    }
  }
  return `srk_${digest(input).slice("sha256:".length)}`;
}

export function createObservationId(input: {
  sourceRecordKey: string;
  payload: CanonicalJson;
  sourceRevision?: string;
}): string {
  return `obs_${digest({
    sourceRecordKey: input.sourceRecordKey,
    sourceRevision: input.sourceRevision ?? null,
    payload: input.payload,
  }).slice("sha256:".length)}`;
}

function assertIdentityText(parts: Record<string, string>): void {
  for (const [label, value] of Object.entries(parts)) {
    if (!value || value.trim() !== value || value.normalize("NFC") !== value) {
      throw new TypeError(`${label} must be non-empty, trimmed, NFC text`);
    }
  }
}

function assertPositiveVersion(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

export function createJobKey(input: {
  profile: string;
  pipeline: string;
  pipelineVersion: number;
  task: string;
  pluginId: string;
  pluginVersion: string;
  entityKey: string;
  mode: PipelineMode;
}): string {
  assertIdentityText({
    profile: input.profile,
    pipeline: input.pipeline,
    task: input.task,
    pluginId: input.pluginId,
    pluginVersion: input.pluginVersion,
    entityKey: input.entityKey,
    mode: input.mode,
  });
  assertPositiveVersion("pipelineVersion", input.pipelineVersion);
  return `job_${digest(input).slice("sha256:".length)}`;
}

export function createCheckpointKey(input: {
  profile: string;
  pipeline: string;
  pipelineVersion: number;
  stageId: string;
  pluginId: string;
  pluginVersion: string;
  sourceNamespace: string;
  target: string;
  partition: string;
  mode: "preview" | "apply";
}): string {
  assertIdentityText({
    profile: input.profile,
    pipeline: input.pipeline,
    stageId: input.stageId,
    pluginId: input.pluginId,
    pluginVersion: input.pluginVersion,
    sourceNamespace: input.sourceNamespace,
    target: input.target,
    partition: input.partition,
    mode: input.mode,
  });
  assertPositiveVersion("pipelineVersion", input.pipelineVersion);
  return `chk_${digest(input).slice("sha256:".length)}`;
}
