import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FilesystemJsonArtifactStore } from "./index.js";

const metadata = {
  schema: { name: "fixture.records", version: 1 },
  artifactPolicy: "required" as const,
  artifactClass: "raw" as const,
  retentionStartedAt: "2026-09-06T00:00:00.000Z",
  expiresAt: "2026-09-07T00:00:00.000Z",
  restrictions: {
    sourcePolicies: [],
    redistribution: "forbidden" as const,
    attributionRefs: [],
  },
  provenance: {
    kind: "internal" as const,
    producingStageId: "fixture",
    outputPort: "records",
    parentHandles: [],
  },
};

function activeOptions(maxBytes = 1_048_576) {
  return { maxBytes, signal: new AbortController().signal };
}

test("commits canonical JSON immutably and verifies reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "map-pipeline-artifacts-"));
  try {
    const store = new FilesystemJsonArtifactStore(root);
    const staged = await store.stageJson(
      [{ z: 1, a: "x" }, { b: true }],
      activeOptions(),
    );
    assert.equal(staged.recordCount, 2);
    assert.equal(staged.byteCount, 29);
    assert.deepEqual(staged.fields, ["a", "b", "z"]);
    const committed = await store.commitJson(staged, metadata, activeOptions());
    assert.match(committed.contentDigest, /^sha256:[a-f0-9]{64}$/);
    assert.match(committed.manifestDigest, /^sha256:[a-f0-9]{64}$/);
    assert.deepEqual(await store.readJson(committed, activeOptions()), [
      { a: "x", z: 1 },
      { b: true },
    ]);
    const objectText = await readFile(new URL(committed.uri), "utf8");
    assert.equal(objectText, '[{"a":"x","z":1},{"b":true}]\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publishes concurrent identical commits atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "map-pipeline-artifacts-"));
  try {
    const store = new FilesystemJsonArtifactStore(root);
    const value = [{ id: "same", stable: true }];
    const [firstStaged, secondStaged] = await Promise.all([
      store.stageJson(value, activeOptions()),
      store.stageJson(value, activeOptions()),
    ]);
    const [first, second] = await Promise.all([
      store.commitJson(firstStaged, metadata, activeOptions()),
      store.commitJson(secondStaged, metadata, activeOptions()),
    ]);
    assert.equal(first.contentDigest, second.contentDigest);
    assert.equal(first.manifestDigest, second.manifestDigest);
    assert.deepEqual(await store.readJson(first, activeOptions()), value);
    assert.deepEqual(await store.readJson(second, activeOptions()), value);
    assert.equal((await readdir(join(root, "objects"))).length, 1);
    assert.equal((await readdir(join(root, "manifests"))).length, 1);
    assert.deepEqual(await readdir(join(root, "staging")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects reads that escape the object store through a symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "map-pipeline-artifacts-"));
  const outside = await mkdtemp(join(tmpdir(), "map-pipeline-outside-"));
  try {
    const store = new FilesystemJsonArtifactStore(root);
    const staged = await store.stageJson([{ safe: true }], activeOptions());
    const committed = await store.commitJson(staged, metadata, activeOptions());
    const escapedPath = join(outside, "escaped.json");
    await writeFile(escapedPath, '{"unsafe":true}\n');
    const linkedPath = join(root, "objects", "linked.json");
    await symlink(escapedPath, linkedPath);
    await assert.rejects(
      () => store.readJson(
        { ...committed, uri: new URL(`file://${linkedPath}`).toString() },
        activeOptions(),
      ),
      /resolves outside the configured object store/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("derives document record counts without trusting the caller", async () => {
  const root = await mkdtemp(join(tmpdir(), "map-pipeline-artifacts-"));
  try {
    const store = new FilesystemJsonArtifactStore(root);
    const staged = await store.stageJson({
      fixtureId: "synthetic",
      records: [{ id: 1 }, { id: 2 }],
    }, activeOptions());
    assert.equal(staged.recordCount, 2);
    assert.deepEqual(staged.fields, ["fixtureId", "id", "records"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects oversized or aborted staging before retaining bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "map-pipeline-artifacts-"));
  try {
    const store = new FilesystemJsonArtifactStore(root);
    await assert.rejects(
      () => store.stageJson({ tooLarge: true }, activeOptions(1)),
      /exceeds 1 bytes/,
    );
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await assert.rejects(
      () => store.stageJson({ small: true }, {
        maxBytes: 1024,
        signal: controller.signal,
      }),
      /cancelled/,
    );
    assert.deepEqual(await readdir(join(root, "staging")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
