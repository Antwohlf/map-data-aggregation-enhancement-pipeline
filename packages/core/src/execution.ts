import type {
  ArtifactClass,
  ArtifactPolicy,
  DatasetProvenance,
  DatasetRestrictions,
  PipelineMode,
  SchemaRef,
} from "./types.js";
import type { CanonicalJson } from "./identity.js";

export interface StagedJsonArtifact {
  handle: string;
  contentDigest: string;
  byteCount: number;
  recordCount: number;
  fields: string[];
}

export interface ArtifactCommitMetadata {
  schema: SchemaRef;
  artifactPolicy: Exclude<ArtifactPolicy, "forbidden">;
  artifactClass: ArtifactClass;
  retentionStartedAt: string;
  expiresAt: string | null;
  restrictions: DatasetRestrictions;
  provenance: DatasetProvenance;
}

export interface CommittedJsonArtifact extends StagedJsonArtifact {
  uri: string;
  manifestDigest: string;
}

export interface JsonArtifactStore {
  stageJson(
    value: CanonicalJson,
    options: { maxBytes: number; signal: AbortSignal },
  ): Promise<StagedJsonArtifact>;
  commitJson(
    staged: StagedJsonArtifact,
    metadata: ArtifactCommitMetadata,
    options: { signal: AbortSignal },
  ): Promise<CommittedJsonArtifact>;
  discard(staged: StagedJsonArtifact): Promise<void>;
  readJson(
    artifact: CommittedJsonArtifact,
    options: { maxBytes: number; signal: AbortSignal },
  ): Promise<CanonicalJson>;
}

export interface ResourceReadResult {
  value: CanonicalJson;
  observedChildIds: string[];
  schema: SchemaRef;
}

export interface ResourceReader {
  read(input: {
    resourceUri: string;
    operation: string;
    maxBytes: number;
    signal: AbortSignal;
  }): Promise<ResourceReadResult>;
}

/** Host-owned runtime validator for one versioned canonical JSON schema. */
export type CanonicalJsonValidator = (value: CanonicalJson) => void;

export interface RunDescriptor {
  runId: string;
  profile: string;
  pipeline: string;
  pipelineVersion: number;
  partition: string;
  mode: PipelineMode;
  startedAt: string;
}

export interface RunRecord extends RunDescriptor {
  status: "running" | "succeeded" | "failed";
  finishedAt: string | null;
  error: string | null;
}

export interface StageAttemptRecord {
  runId: string;
  stageId: string;
  attempt: number;
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  finishedAt: string | null;
  outputs: Record<string, string>;
  error: string | null;
}

export interface RunStateStore {
  beginRun(run: RunDescriptor): void;
  beginStage(input: {
    runId: string;
    stageId: string;
    startedAt: string;
  }): number;
  completeStage(input: {
    runId: string;
    stageId: string;
    attempt: number;
    finishedAt: string;
    outputs: Record<string, string>;
  }): void;
  failStage(input: {
    runId: string;
    stageId: string;
    attempt: number;
    finishedAt: string;
    error: string;
  }): void;
  completeRun(input: {
    runId: string;
    finishedAt: string;
    expectedStageIds: string[];
  }): void;
  failRun(input: { runId: string; finishedAt: string; error: string }): void;
  getRun(runId: string): RunRecord | null;
  listStageAttempts(runId: string): StageAttemptRecord[];
  loadCheckpoint(key: string): CanonicalJson | null;
  putCheckpoint(input: {
    key: string;
    profile: string;
    mode: "preview" | "apply";
    value: CanonicalJson;
    updatedAt: string;
  }): void;
  close(): void;
}
