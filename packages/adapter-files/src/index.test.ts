import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  computeJsonFileSnapshotReaderBindingDigest,
  computeJsonFileSnapshotSourceInstanceDigest,
  FixtureJsonResourceReader,
  JsonFileSnapshotResourceReader,
  type JsonFileSnapshotResource,
} from "./index.js";
import { digest } from "@map-pipeline/core";

test("reads only manifest-approved synthetic fixtures", async () => {
  const root = await mkdtemp(join(tmpdir(), "map-pipeline-fixtures-"));
  try {
    await mkdir(join(root, "synthetic"));
    const value = { records: [{ id: "synthetic-1" }] };
    const fixtureText = JSON.stringify(value);
    await writeFile(join(root, "synthetic", "sample.json"), fixtureText);
    await writeFile(join(root, "manifest.json"), JSON.stringify({
      version: 1,
      fixtures: [{
        path: "synthetic/sample.json",
        containsThirdPartyData: false,
        containsPersonalData: false,
        redistributionReviewed: true,
        approvalStatus: "approved_synthetic",
        schema: { name: "synthetic.sample", version: 1 },
        contentDigest: `sha256:${createHash("sha256").update(fixtureText).digest("hex")}`,
      }],
    }));
    const reader = new FixtureJsonResourceReader({
      fixturesRoot: root,
      manifestPath: join(root, "manifest.json"),
    });
    assert.deepEqual(await reader.read({
      resourceUri: "fixture://synthetic/sample",
      operation: "read",
      partition: "US",
      maxRecords: 1,
      maxBytes: 1024,
      timeoutMs: 30_000,
      signal: new AbortController().signal,
    }), {
      value,
      observedChildIds: [],
      schema: { name: "synthetic.sample", version: 1 },
      snapshot: {
        snapshotId: `sha256:${createHash("sha256").update(fixtureText).digest("hex")}`,
        sourceInstanceDigest: null,
        readerBindingDigest: digest({
          adapter: "files",
          resourceUri: "fixture://synthetic/sample",
          operation: "read",
          schema: { name: "synthetic.sample", version: 1 },
          contentDigest: `sha256:${createHash("sha256").update(fixtureText).digest("hex")}`,
        }),
        capturedAt: null,
        consistency: "immutable",
        cursorSchema: null,
        startExclusive: null,
        endInclusive: null,
        complete: true,
        contractName: "synthetic.sample",
        contractVersion: 1,
        contractDigest: `sha256:${createHash("sha256").update(fixtureText).digest("hex")}`,
      },
    });
    await assert.rejects(
      () => reader.read({
        resourceUri: "fixture://synthetic/sample",
        operation: "read",
        partition: "US",
        maxRecords: 1,
        maxBytes: 1,
        timeoutMs: 30_000,
        signal: new AbortController().signal,
      }),
      /exceeds 1 bytes/,
    );
    await assert.rejects(
      () => reader.read({
        resourceUri: "fixture://synthetic/../secret",
        operation: "read",
        partition: "US",
        maxRecords: 1,
        maxBytes: 1024,
        timeoutMs: 30_000,
        signal: new AbortController().signal,
      }),
      /unsafe path|approved synthetic/,
    );
    await assert.rejects(
      () => reader.read({
        resourceUri: "fixture://synthetic/sample",
        operation: "read",
        partition: "US",
        maxRecords: 0,
        maxBytes: 1024,
        timeoutMs: 30_000,
        signal: new AbortController().signal,
      }),
      /contains 1 records; limit is 0/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reads only an exact host-registered immutable JSON snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "map-pipeline-json-snapshot-"));
  const value = [{ fsq_place_id: "private-row" }];
  const bytes = JSON.stringify(value);
  const contentDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const resource: JsonFileSnapshotResource = {
    resourceUri: "file-snapshot://pipeline-input/apizza-fsq-v1",
    operation: "snapshot",
    partitions: ["US"],
    rootPath: root,
    relativePath: "fsq.json",
    schema: { name: "apizza.fsq-release-rows", version: 1 },
    contract: {
      name: "apizza-fsq-release-rows",
      version: 1,
      digest: `sha256:${"a".repeat(64)}`,
    },
    expectedContentDigest: contentDigest,
    childIds: ["release:test-only"],
  };
  try {
    await writeFile(join(root, resource.relativePath), bytes);
    const reader = new JsonFileSnapshotResourceReader({ resources: [resource] });
    const result = await reader.read({
      resourceUri: resource.resourceUri,
      operation: "snapshot",
      partition: "US",
      maxRecords: 1,
      maxBytes: 1024,
      timeoutMs: 30_000,
      signal: new AbortController().signal,
    });
    assert.deepEqual(result.value, value);
    assert.deepEqual(result.observedChildIds, resource.childIds);
    assert.deepEqual(result.schema, resource.schema);
    assert.deepEqual(result.snapshot, {
      snapshotId: contentDigest,
      sourceInstanceDigest: computeJsonFileSnapshotSourceInstanceDigest(root),
      readerBindingDigest: computeJsonFileSnapshotReaderBindingDigest(resource),
      capturedAt: result.snapshot.capturedAt,
      consistency: "immutable",
      cursorSchema: null,
      startExclusive: null,
      endInclusive: null,
      complete: true,
      contractName: resource.contract.name,
      contractVersion: resource.contract.version,
      contractDigest: resource.contract.digest,
    });
    assert.equal(
      new Date(result.snapshot.capturedAt ?? "invalid").toISOString(),
      result.snapshot.capturedAt,
    );
    await assert.rejects(() => reader.read({
      resourceUri: resource.resourceUri,
      operation: "read",
      partition: "US",
      maxRecords: 1,
      maxBytes: 1024,
      timeoutMs: 30_000,
      signal: new AbortController().signal,
    }), /not registered/);
    await assert.rejects(() => reader.read({
      resourceUri: resource.resourceUri,
      operation: "snapshot",
      partition: "MI",
      maxRecords: 1,
      maxBytes: 1024,
      timeoutMs: 30_000,
      signal: new AbortController().signal,
    }), /partition is not registered/);
    await assert.rejects(() => reader.read({
      resourceUri: resource.resourceUri,
      operation: "snapshot",
      partition: "US",
      maxRecords: 0,
      maxBytes: 1024,
      timeoutMs: 30_000,
      signal: new AbortController().signal,
    }), /contains 1 records; limit is 0/);
    const wrongDigestReader = new JsonFileSnapshotResourceReader({
      resources: [{ ...resource, expectedContentDigest: `sha256:${"b".repeat(64)}` }],
    });
    await assert.rejects(() => wrongDigestReader.read({
      resourceUri: resource.resourceUri,
      operation: "snapshot",
      partition: "US",
      maxRecords: 1,
      maxBytes: 1024,
      timeoutMs: 30_000,
      signal: new AbortController().signal,
    }), /digest does not match/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a registered JSON snapshot that resolves outside its root", async () => {
  const root = await mkdtemp(join(tmpdir(), "map-pipeline-json-root-"));
  const outside = await mkdtemp(join(tmpdir(), "map-pipeline-json-outside-"));
  const bytes = "[]";
  const resource: JsonFileSnapshotResource = {
    resourceUri: "file-snapshot://pipeline-input/escaped-v1",
    operation: "snapshot",
    partitions: ["US"],
    rootPath: root,
    relativePath: "escaped.json",
    schema: { name: "test.rows", version: 1 },
    contract: {
      name: "test-rows",
      version: 1,
      digest: `sha256:${"a".repeat(64)}`,
    },
    expectedContentDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    childIds: [],
  };
  try {
    await writeFile(join(outside, "outside.json"), bytes);
    await symlink(join(outside, "outside.json"), join(root, resource.relativePath));
    const reader = new JsonFileSnapshotResourceReader({ resources: [resource] });
    await assert.rejects(() => reader.read({
      resourceUri: resource.resourceUri,
      operation: "snapshot",
      partition: "US",
      maxRecords: 1,
      maxBytes: 1024,
      timeoutMs: 30_000,
      signal: new AbortController().signal,
    }), /outside its registered root/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
