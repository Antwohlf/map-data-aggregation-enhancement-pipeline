import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import {
  link,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  canonicalize,
  digest,
  type ArtifactCommitMetadata,
  type CanonicalJson,
  type CommittedJsonArtifact,
  type JsonArtifactStore,
  type StagedJsonArtifact,
} from "@map-pipeline/core";

interface StagedEntry extends StagedJsonArtifact {
  path: string;
}

function recordMetadata(value: CanonicalJson): {
  recordCount: number;
  fields: string[];
} {
  const wrappedRecords = value && typeof value === "object" && !Array.isArray(value)
    ? ["records", "rows", "places", "features"]
      .map((field) => value[field])
      .filter(Array.isArray)
    : [];
  if (wrappedRecords.length > 1) {
    throw new TypeError("Artifact has multiple recognized record arrays");
  }
  const records = Array.isArray(value)
    ? value
    : value === null
      ? []
      : wrappedRecords[0]
        ? wrappedRecords[0]
        : [value];
  const fields = new Set<string>();
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const field of Object.keys(value)) fields.add(field);
  }
  for (const record of records) {
    if (record && typeof record === "object" && !Array.isArray(record)) {
      for (const field of Object.keys(record)) fields.add(field);
    }
  }
  return { recordCount: records.length, fields: [...fields].sort() };
}

async function writeImmutable(
  path: string,
  contents: string,
  signal: AbortSignal,
): Promise<boolean> {
  throwIfAborted(signal);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
      signal,
    });
    throwIfAborted(signal);
    try {
      await link(temporaryPath, path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readFile(path, { encoding: "utf8", signal });
      throwIfAborted(signal);
      if (existing !== contents) {
        throw new Error(`Immutable artifact collision at ${path}`);
      }
      return false;
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function assertByteLimit(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError("Artifact byte limit must be a non-negative safe integer");
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}

export class FilesystemJsonArtifactStore implements JsonArtifactStore {
  readonly #root: string;
  readonly #objects: string;
  readonly #manifests: string;
  readonly #staging: string;
  readonly #staged = new Map<string, StagedEntry>();

  constructor(root: string) {
    this.#root = resolve(root);
    this.#objects = join(this.#root, "objects");
    this.#manifests = join(this.#root, "manifests");
    this.#staging = join(this.#root, "staging");
    for (const path of [this.#objects, this.#manifests, this.#staging]) {
      mkdirSync(path, { recursive: true, mode: 0o700 });
    }
  }

  async stageJson(
    value: CanonicalJson,
    options: { maxBytes: number; signal: AbortSignal },
  ): Promise<StagedJsonArtifact> {
    assertByteLimit(options.maxBytes);
    throwIfAborted(options.signal);
    throwIfAborted(options.signal);
    const serialized = `${canonicalize(value)}\n`;
    const byteCount = Buffer.byteLength(serialized);
    if (byteCount > options.maxBytes) {
      throw new Error(`Artifact exceeds ${options.maxBytes} bytes`);
    }
    throwIfAborted(options.signal);
    const contentDigest = digest(value);
    const handle = `staged:${randomUUID()}`;
    const path = join(this.#staging, `${handle.slice("staged:".length)}.json`);
    try {
      await writeFile(path, serialized, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
        signal: options.signal,
      });
      throwIfAborted(options.signal);
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    }
    const staged = {
      handle,
      contentDigest,
      byteCount,
      ...recordMetadata(value),
      path,
    };
    this.#staged.set(handle, staged);
    const { path: _path, ...publicStaged } = staged;
    return Object.freeze(publicStaged);
  }

  async commitJson(
    staged: StagedJsonArtifact,
    metadata: ArtifactCommitMetadata,
    options: { signal: AbortSignal },
  ): Promise<CommittedJsonArtifact> {
    throwIfAborted(options.signal);
    throwIfAborted(options.signal);
    const entry = this.#staged.get(staged.handle);
    if (
      !entry ||
      entry.contentDigest !== staged.contentDigest ||
      entry.byteCount !== staged.byteCount ||
      entry.recordCount !== staged.recordCount ||
      canonicalize(entry.fields) !== canonicalize(staged.fields)
    ) {
      throw new Error("Staged artifact is unknown or has been altered");
    }

    const contents = await readFile(entry.path, {
      encoding: "utf8",
      signal: options.signal,
    });
    throwIfAborted(options.signal);
    const value = JSON.parse(contents) as CanonicalJson;
    if (digest(value) !== entry.contentDigest) {
      throw new Error("Staged artifact content digest changed before commit");
    }

    const objectName = `${entry.contentDigest.slice("sha256:".length)}.json`;
    const objectPath = join(this.#objects, objectName);
    let manifestPath: string;
    let manifestDigest = "";
    await writeImmutable(objectPath, contents, options.signal);
    const manifest = JSON.parse(JSON.stringify({
      version: 1,
      contentDigest: entry.contentDigest,
      byteCount: entry.byteCount,
      recordCount: entry.recordCount,
      fields: entry.fields,
      objectUri: pathToFileURL(objectPath).toString(),
      ...metadata,
    })) as CanonicalJson;
    manifestDigest = digest(manifest);
    manifestPath = join(
      this.#manifests,
      `${manifestDigest.slice("sha256:".length)}.json`,
    );
    await writeImmutable(
      manifestPath,
      `${canonicalize(manifest)}\n`,
      options.signal,
    );
    throwIfAborted(options.signal);
    await rm(entry.path, { force: true });
    this.#staged.delete(entry.handle);

    return Object.freeze({
      handle: entry.handle,
      contentDigest: entry.contentDigest,
      byteCount: entry.byteCount,
      recordCount: entry.recordCount,
      fields: entry.fields,
      uri: pathToFileURL(objectPath).toString(),
      manifestDigest,
    });
  }

  async discard(staged: StagedJsonArtifact): Promise<void> {
    const entry = this.#staged.get(staged.handle);
    if (!entry) return;
    await rm(entry.path, { force: true });
    this.#staged.delete(entry.handle);
  }

  async readJson(
    artifact: CommittedJsonArtifact,
    options: { maxBytes: number; signal: AbortSignal },
  ): Promise<CanonicalJson> {
    assertByteLimit(options.maxBytes);
    throwIfAborted(options.signal);
    throwIfAborted(options.signal);
    if (artifact.byteCount > options.maxBytes) {
      throw new Error(`Artifact exceeds ${options.maxBytes} bytes`);
    }
    const url = new URL(artifact.uri);
    if (url.protocol !== "file:" || url.username || url.password || url.search || url.hash) {
      throw new Error("Artifact URI must be a plain file URL");
    }
    const path = resolve(fileURLToPath(url));
    const objectsRoot = `${this.#objects}${sep}`;
    if (!path.startsWith(objectsRoot)) {
      throw new Error("Artifact URI escapes the configured object store");
    }
    const [actualPath, objectRoot] = await Promise.all([
      realpath(path),
      realpath(this.#objects),
    ]);
    if (!actualPath.startsWith(`${objectRoot}${sep}`)) {
      throw new Error("Artifact URI resolves outside the configured object store");
    }
    const file = await stat(actualPath);
    if (!file.isFile()) throw new Error("Artifact URI must resolve to a regular file");
    if (file.size > options.maxBytes) {
      throw new Error(`Artifact exceeds ${options.maxBytes} bytes`);
    }
    throwIfAborted(options.signal);
    const contents = await readFile(actualPath, {
      encoding: "utf8",
      signal: options.signal,
    });
    throwIfAborted(options.signal);
    if (Buffer.byteLength(contents) > options.maxBytes) {
      throw new Error(`Artifact exceeds ${options.maxBytes} bytes`);
    }
    const value = JSON.parse(contents) as CanonicalJson;
    if (digest(value) !== artifact.contentDigest) {
      throw new Error("Committed artifact content digest does not match");
    }
    return value;
  }

}
