import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

import {
  type CanonicalJson,
  digest,
  type ResourceReadResult,
  type ResourceReader,
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
