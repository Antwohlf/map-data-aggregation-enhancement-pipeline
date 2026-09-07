import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";

import {
  type CanonicalJson,
  canonicalize,
  digest,
  type ResourceReadResult,
  type ResourceReader,
  type SchemaRef,
  type StagePluginManifest,
} from "@map-pipeline/core";
import { definePlugin, type StagePlugin } from "@map-pipeline/sdk";

interface FixtureManifestEntry {
  path: string;
  containsThirdPartyData: boolean;
  containsPersonalData: boolean;
  redistributionReviewed: boolean;
  approvalStatus: string;
  contentDigest: string;
  schema: { name: string; version: number };
}

interface FixtureManifest {
  version: number;
  fixtures: FixtureManifestEntry[];
}

const MAX_MANIFEST_BYTES = 1_048_576;

function fixturePathFromUri(resourceUri: string): string {
  const url = new URL(resourceUri);
  if (
    url.protocol !== "fixture:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) {
    throw new Error("Fixture reads require a canonical fixture:// URI");
  }
  const path = `${url.hostname}${url.pathname}`;
  if (!path || path.includes("..") || path.startsWith("/")) {
    throw new Error("Fixture URI contains an unsafe path");
  }
  return `${path}.json`;
}

export class FixtureJsonResourceReader implements ResourceReader {
  readonly #fixturesRoot: string;
  readonly #manifestPath: string;

  constructor(input: { fixturesRoot: string; manifestPath: string }) {
    this.#fixturesRoot = resolve(input.fixturesRoot);
    this.#manifestPath = resolve(input.manifestPath);
  }

  async read(input: {
    resourceUri: string;
    operation: string;
    partition: string;
    maxRecords: number;
    maxBytes: number;
    timeoutMs: number;
    signal: AbortSignal;
  }): Promise<ResourceReadResult> {
    if (input.operation !== "read") throw new Error("Fixture adapter supports only read");
    if (!Number.isSafeInteger(input.maxRecords) || input.maxRecords < 0) {
      throw new TypeError("Fixture record limit must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 0) {
      throw new TypeError("Fixture byte limit must be a non-negative safe integer");
    }
    if (input.signal.aborted) throw input.signal.reason;
    const relativePath = fixturePathFromUri(input.resourceUri);
    const manifestFile = await stat(this.#manifestPath);
    if (!manifestFile.isFile() || manifestFile.size > MAX_MANIFEST_BYTES) {
      throw new Error("Fixture manifest is missing, invalid, or too large");
    }
    const manifest = JSON.parse(
      await readFile(this.#manifestPath, { encoding: "utf8", signal: input.signal }),
    ) as FixtureManifest;
    const entry = manifest.fixtures.find((candidate) => candidate.path === relativePath);
    if (
      manifest.version !== 1 ||
      !entry ||
      !entry.schema ||
      typeof entry.schema.name !== "string" ||
      !entry.schema.name ||
      !Number.isSafeInteger(entry.schema.version) ||
      entry.schema.version < 1 ||
      entry.containsThirdPartyData ||
      entry.containsPersonalData ||
      !entry.redistributionReviewed ||
      entry.approvalStatus !== "approved_synthetic"
    ) {
      throw new Error("Fixture is not an approved synthetic public fixture");
    }

    const root = await realpath(this.#fixturesRoot);
    const path = await realpath(resolve(root, relativePath));
    if (!path.startsWith(`${root}${sep}`)) {
      throw new Error("Fixture path resolves outside the fixture root");
    }
    const file = await stat(path);
    if (!file.isFile()) throw new Error("Fixture path must resolve to a regular file");
    if (file.size > input.maxBytes) {
      throw new Error(`Fixture exceeds ${input.maxBytes} bytes`);
    }
    if (input.signal.aborted) throw input.signal.reason;
    const bytes = await readFile(path, { signal: input.signal });
    if (input.signal.aborted) throw input.signal.reason;
    if (bytes.byteLength > input.maxBytes) {
      throw new Error(`Fixture exceeds ${input.maxBytes} bytes`);
    }
    const actualDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const value = JSON.parse(bytes.toString("utf8")) as CanonicalJson;
    if (actualDigest !== entry.contentDigest) {
      throw new Error("Fixture content digest does not match its manifest");
    }
    const wrapped = value && typeof value === "object" && !Array.isArray(value)
      ? ["records", "rows", "places", "features"]
        .map((field) => value[field])
        .filter(Array.isArray)
      : [];
    if (wrapped.length > 1) {
      throw new Error("Fixture has multiple recognized record arrays");
    }
    const records = Array.isArray(value)
      ? value.length
      : value === null ? 0 : wrapped[0]?.length ?? 1;
    if (records > input.maxRecords) {
      throw new Error(`Fixture contains ${records} records; limit is ${input.maxRecords}`);
    }
    return {
      value,
      observedChildIds: [],
      schema: { ...entry.schema },
      snapshot: {
        snapshotId: actualDigest,
        sourceInstanceDigest: null,
        readerBindingDigest: digest({
          adapter: "files",
          resourceUri: input.resourceUri,
          operation: input.operation,
          schema: entry.schema,
          contentDigest: actualDigest,
        }),
        capturedAt: null,
        consistency: "immutable",
        cursorSchema: null,
        startExclusive: null,
        endInclusive: null,
        complete: true,
        contractName: entry.schema.name,
        contractVersion: entry.schema.version,
        contractDigest: entry.contentDigest,
      },
    };
  }
}

export interface JsonFixtureSourceConfig {
  resourceUri: string;
  outputPort: string;
}

export function createJsonFixtureSourcePlugin(
  manifest: StagePluginManifest,
): StagePlugin<JsonFixtureSourceConfig> {
  if (manifest.sourceAdapter !== "files") {
    throw new TypeError("JSON fixture source manifest must use the files adapter");
  }
  return definePlugin({
    manifest,
    async run(context, _inputs, config) {
      const acquisition = await context.broker.acquire({
        effectClass: "artifact.read",
        resourceUri: config.resourceUri,
        operation: "read",
      });
      const stagedArtifact = await context.broker.stageSourceArtifact({
        acquisition,
        outputPort: config.outputPort,
        artifactUri: config.resourceUri,
      });
      const output = await context.broker.finalizeSourceArtifactAndCommitAcquisition({
        acquisition,
        stagedArtifact,
        outputPort: config.outputPort,
      });
      return {
        outputs: { [config.outputPort]: output },
        metrics: { records: output.recordCount },
      };
    },
  });
}

export const JSON_FILE_SNAPSHOT_ADAPTER = "json-file-snapshot";

export interface JsonFileSnapshotResource {
  resourceUri: string;
  operation: "snapshot";
  partitions: readonly string[];
  rootPath: string;
  relativePath: string;
  schema: SchemaRef;
  contract: {
    name: string;
    version: number;
    digest: string;
  };
  expectedContentDigest: string;
  childIds: readonly string[];
}

export interface JsonFileSnapshotSourceConfig {
  resourceUri: string;
  outputPort: string;
}

export class JsonFileSnapshotReadError extends Error {
  override readonly name = "JsonFileSnapshotReadError";
}

function assertSha256(value: string, label: string): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest`);
  }
}

function assertSnapshotResource(resource: JsonFileSnapshotResource): void {
  let uri: URL;
  try {
    uri = new URL(resource.resourceUri);
  } catch {
    throw new TypeError("JSON snapshot resource URI is invalid");
  }
  if (
    uri.protocol !== "file-snapshot:" ||
    uri.toString() !== resource.resourceUri ||
    !uri.hostname ||
    uri.pathname === "/" ||
    uri.username ||
    uri.password ||
    uri.port ||
    uri.search ||
    uri.hash
  ) {
    throw new TypeError("JSON snapshots require a canonical file-snapshot:// URI");
  }
  if (resource.operation !== "snapshot") {
    throw new TypeError("JSON file snapshots support only the snapshot operation");
  }
  if (
    !resource.partitions.length ||
    new Set(resource.partitions).size !== resource.partitions.length ||
    resource.partitions.some((partition) => !partition || partition.trim() !== partition)
  ) {
    throw new TypeError("JSON snapshot partitions must be non-empty, trimmed, and unique");
  }
  if (!isAbsolute(resource.rootPath) || resolve(resource.rootPath) !== resource.rootPath) {
    throw new TypeError("JSON snapshot root must be an absolute normalized path");
  }
  if (
    !resource.relativePath ||
    isAbsolute(resource.relativePath) ||
    resource.relativePath.split(/[\\/]/).some((part) => !part || part === "." || part === "..")
  ) {
    throw new TypeError("JSON snapshot path must be a safe non-empty relative path");
  }
  if (
    !resource.schema.name ||
    !Number.isSafeInteger(resource.schema.version) ||
    resource.schema.version < 1 ||
    !resource.contract.name ||
    !Number.isSafeInteger(resource.contract.version) ||
    resource.contract.version < 1
  ) {
    throw new TypeError("JSON snapshot schema or contract identity is invalid");
  }
  assertSha256(resource.contract.digest, "JSON snapshot contract digest");
  assertSha256(resource.expectedContentDigest, "JSON snapshot content digest");
  if (
    new Set(resource.childIds).size !== resource.childIds.length ||
    resource.childIds.some((childId) => !childId || childId.trim() !== childId)
  ) {
    throw new TypeError("JSON snapshot child IDs must be trimmed and unique");
  }
}

export function computeJsonFileSnapshotSourceInstanceDigest(rootPath: string): string {
  if (!isAbsolute(rootPath) || resolve(rootPath) !== rootPath) {
    throw new TypeError("JSON snapshot root must be an absolute normalized path");
  }
  return digest({ adapter: JSON_FILE_SNAPSHOT_ADAPTER, rootPath });
}

export function computeJsonFileSnapshotReaderBindingDigest(
  resource: JsonFileSnapshotResource,
): string {
  assertSnapshotResource(resource);
  return digest({
    adapter: JSON_FILE_SNAPSHOT_ADAPTER,
    resourceUri: resource.resourceUri,
    operation: resource.operation,
    partitions: [...resource.partitions],
    sourceInstanceDigest: computeJsonFileSnapshotSourceInstanceDigest(resource.rootPath),
    relativePath: resource.relativePath,
    schema: resource.schema,
    contract: resource.contract,
    expectedContentDigest: resource.expectedContentDigest,
    childIds: [...resource.childIds],
  } as unknown as CanonicalJson);
}

function jsonRecordCount(value: CanonicalJson): number {
  if (Array.isArray(value)) return value.length;
  if (value === null) return 0;
  if (typeof value !== "object") return 1;
  const recognized = ["records", "rows", "places", "features"]
    .map((field) => value[field])
    .filter(Array.isArray);
  if (recognized.length > 1) {
    throw new JsonFileSnapshotReadError("JSON snapshot has multiple recognized record arrays");
  }
  return recognized[0]?.length ?? 1;
}

function sameFileSnapshot(
  before: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number },
  after: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number },
): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
    before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

export class JsonFileSnapshotResourceReader implements ResourceReader {
  readonly #resources: ReadonlyMap<string, JsonFileSnapshotResource>;

  constructor(input: { resources: readonly JsonFileSnapshotResource[] }) {
    const resources = input.resources.map((resource) => {
      assertSnapshotResource(resource);
      return structuredClone(resource);
    });
    if (new Set(resources.map((resource) => resource.resourceUri)).size !== resources.length) {
      throw new TypeError("JSON snapshot resource URIs must be unique");
    }
    this.#resources = new Map(resources.map((resource) => [resource.resourceUri, resource]));
  }

  async read(input: {
    resourceUri: string;
    operation: string;
    partition: string;
    maxRecords: number;
    maxBytes: number;
    timeoutMs: number;
    signal: AbortSignal;
  }): Promise<ResourceReadResult> {
    const resource = this.#resources.get(input.resourceUri);
    if (!resource || input.operation !== resource.operation) {
      throw new JsonFileSnapshotReadError("JSON snapshot resource or operation is not registered");
    }
    if (!resource.partitions.includes(input.partition)) {
      throw new JsonFileSnapshotReadError("JSON snapshot partition is not registered");
    }
    if (!Number.isSafeInteger(input.maxRecords) || input.maxRecords < 0) {
      throw new TypeError("JSON snapshot record limit must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 0) {
      throw new TypeError("JSON snapshot byte limit must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) {
      throw new TypeError("JSON snapshot timeout must be a positive safe integer");
    }
    const timeoutSignal = AbortSignal.timeout(input.timeoutMs);
    const signal = AbortSignal.any([input.signal, timeoutSignal]);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      if (signal.aborted) throw signal.reason;
      const root = await realpath(resource.rootPath);
      const resolvedPath = await realpath(resolve(root, resource.relativePath));
      if (!resolvedPath.startsWith(`${root}${sep}`)) {
        throw new JsonFileSnapshotReadError("JSON snapshot resolves outside its registered root");
      }
      handle = await open(resolvedPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const before = await handle.stat();
      if (!before.isFile()) throw new JsonFileSnapshotReadError("JSON snapshot is not a regular file");
      if (before.size > input.maxBytes) {
        throw new JsonFileSnapshotReadError(`JSON snapshot exceeds ${input.maxBytes} bytes`);
      }
      const bytes = await handle.readFile({ signal });
      const after = await handle.stat();
      if (!sameFileSnapshot(before, after)) {
        throw new JsonFileSnapshotReadError("JSON snapshot changed while it was being read");
      }
      if (bytes.byteLength > input.maxBytes) {
        throw new JsonFileSnapshotReadError(`JSON snapshot exceeds ${input.maxBytes} bytes`);
      }
      const contentDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      if (contentDigest !== resource.expectedContentDigest) {
        throw new JsonFileSnapshotReadError("JSON snapshot content digest does not match its host registration");
      }
      const value = JSON.parse(bytes.toString("utf8")) as CanonicalJson;
      canonicalize(value);
      const records = jsonRecordCount(value);
      if (records > input.maxRecords) {
        throw new JsonFileSnapshotReadError(
          `JSON snapshot contains ${records} records; limit is ${input.maxRecords}`,
        );
      }
      return {
        value,
        observedChildIds: [...resource.childIds],
        schema: { ...resource.schema },
        snapshot: {
          snapshotId: contentDigest,
          sourceInstanceDigest: computeJsonFileSnapshotSourceInstanceDigest(resource.rootPath),
          readerBindingDigest: computeJsonFileSnapshotReaderBindingDigest(resource),
          capturedAt: before.mtime.toISOString(),
          consistency: "immutable",
          cursorSchema: null,
          startExclusive: null,
          endInclusive: null,
          complete: true,
          contractName: resource.contract.name,
          contractVersion: resource.contract.version,
          contractDigest: resource.contract.digest,
        },
      };
    } catch (error) {
      if (error instanceof JsonFileSnapshotReadError || error instanceof TypeError) throw error;
      if (signal.aborted) throw new JsonFileSnapshotReadError("JSON snapshot read was aborted");
      throw new JsonFileSnapshotReadError("JSON snapshot read failed");
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}

export function createJsonFileSnapshotSourcePlugin(
  manifest: StagePluginManifest,
): StagePlugin<JsonFileSnapshotSourceConfig> {
  if (manifest.sourceAdapter !== JSON_FILE_SNAPSHOT_ADAPTER) {
    throw new TypeError(`JSON snapshot source manifest must use ${JSON_FILE_SNAPSHOT_ADAPTER}`);
  }
  return definePlugin({
    manifest,
    async run(context, _inputs, config) {
      const acquisition = await context.broker.acquire({
        effectClass: "artifact.read",
        resourceUri: config.resourceUri,
        operation: "snapshot",
      });
      const stagedArtifact = await context.broker.stageSourceArtifact({
        acquisition,
        outputPort: config.outputPort,
        artifactUri: config.resourceUri,
      });
      const output = await context.broker.finalizeSourceArtifactAndCommitAcquisition({
        acquisition,
        stagedArtifact,
        outputPort: config.outputPort,
      });
      return {
        outputs: { [config.outputPort]: output },
        metrics: { records: output.recordCount },
      };
    },
  });
}

/**
 * Reads an exact host-registered immutable JSON snapshot without creating a
 * raw-source artifact. The broker owns the value until every declared
 * downstream consumer has finished, then releases it from memory.
 */
export function createJsonFileEphemeralSnapshotSourcePlugin(
  manifest: StagePluginManifest,
): StagePlugin<JsonFileSnapshotSourceConfig> {
  if (manifest.sourceAdapter !== JSON_FILE_SNAPSHOT_ADAPTER) {
    throw new TypeError(`JSON snapshot source manifest must use ${JSON_FILE_SNAPSHOT_ADAPTER}`);
  }
  if (
    Object.values(manifest.outputs).some(
      (output) => output.artifactPolicy !== "forbidden",
    )
  ) {
    throw new TypeError("Ephemeral JSON snapshot outputs must forbid artifact persistence");
  }
  if (manifest.effects.includes("artifact.write")) {
    throw new TypeError("Ephemeral JSON snapshot plugins cannot request artifact writes");
  }
  return definePlugin({
    manifest,
    async run(context, _inputs, config) {
      const acquisition = await context.broker.acquire({
        effectClass: "artifact.read",
        resourceUri: config.resourceUri,
        operation: "snapshot",
      });
      const output = await context.broker.finalizeSourceEphemeral({
        acquisition,
        outputPort: config.outputPort,
      });
      return {
        outputs: { [config.outputPort]: output },
        metrics: { records: output.recordCount },
      };
    },
  });
}
