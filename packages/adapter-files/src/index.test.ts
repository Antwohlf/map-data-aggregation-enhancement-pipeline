import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FixtureJsonResourceReader } from "./index.js";

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
      maxBytes: 1024,
      signal: new AbortController().signal,
    }), {
      value,
      observedChildIds: [],
      schema: { name: "synthetic.sample", version: 1 },
    });
    await assert.rejects(
      () => reader.read({
        resourceUri: "fixture://synthetic/sample",
        operation: "read",
        maxBytes: 1,
        signal: new AbortController().signal,
      }),
      /exceeds 1 bytes/,
    );
    await assert.rejects(
      () => reader.read({
        resourceUri: "fixture://synthetic/../secret",
        operation: "read",
        maxBytes: 1024,
        signal: new AbortController().signal,
      }),
      /unsafe path|approved synthetic/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
