import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SqliteRunStateStore } from "./index.js";

test("persists run attempts and checkpoints across reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "map-pipeline-state-"));
  const path = join(root, "state.sqlite");
  try {
    let store = new SqliteRunStateStore(path);
    store.beginRun({
      runId: "run-1",
      profile: "apizzamichigan",
      pipeline: "fixture-preview",
      pipelineVersion: 1,
      partition: "MI",
      mode: "preview",
      startedAt: "2026-09-06T00:00:00.000Z",
    });
    const attempt = store.beginStage({
      runId: "run-1",
      stageId: "source",
      startedAt: "2026-09-06T00:00:01.000Z",
    });
    store.completeStage({
      runId: "run-1",
      stageId: "source",
      attempt,
      finishedAt: "2026-09-06T00:00:02.000Z",
      outputs: { records: "sha256:abc" },
    });
    store.putCheckpoint({
      key: "checkpoint-1",
      profile: "apizzamichigan",
      mode: "preview",
      value: { cursor: 3 },
      updatedAt: "2026-09-06T00:00:02.000Z",
    });
    assert.throws(
      () => store.completeRun({
        runId: "run-1",
        finishedAt: "2026-09-06T00:00:03.000Z",
        expectedStageIds: ["source", "missing"],
      }),
      /latest attempt succeeded/,
    );
    store.completeRun({
      runId: "run-1",
      finishedAt: "2026-09-06T00:00:03.000Z",
      expectedStageIds: ["source"],
    });
    store.close();

    store = new SqliteRunStateStore(path);
    assert.equal(store.getRun("run-1")?.status, "succeeded");
    assert.deepEqual(store.listStageAttempts("run-1")[0]?.outputs, {
      records: "sha256:abc",
    });
    assert.deepEqual(store.loadCheckpoint("checkpoint-1"), { cursor: 3 });
    assert.throws(
      () => store.putCheckpoint({
        key: "checkpoint-1",
        profile: "tacoboutmichigan",
        mode: "preview",
        value: { cursor: 4 },
        updatedAt: "2026-09-06T00:00:04.000Z",
      }),
      /another profile or mode/,
    );
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects duplicate run IDs and invalid state transitions", async () => {
  const root = await mkdtemp(join(tmpdir(), "map-pipeline-state-"));
  try {
    const store = new SqliteRunStateStore(join(root, "state.sqlite"));
    const descriptor = {
      runId: "run-duplicate",
      profile: "apizzamichigan",
      pipeline: "fixture-preview",
      pipelineVersion: 1,
      partition: "MI",
      mode: "preview" as const,
      startedAt: "2026-09-06T00:00:00.000Z",
    };
    store.beginRun(descriptor);
    assert.throws(() => store.beginRun(descriptor));
    const attempt = store.beginStage({
      runId: descriptor.runId,
      stageId: "source",
      startedAt: descriptor.startedAt,
    });
    assert.throws(
      () => store.beginStage({
        runId: descriptor.runId,
        stageId: "source",
        startedAt: descriptor.startedAt,
      }),
      /already has a running attempt/,
    );
    assert.throws(
      () => store.completeRun({
        runId: descriptor.runId,
        finishedAt: descriptor.startedAt,
        expectedStageIds: ["source"],
      }),
      /latest attempt succeeded/,
    );
    store.failStage({
      runId: descriptor.runId,
      stageId: "source",
      attempt,
      finishedAt: descriptor.startedAt,
      error: "fixture failure",
    });
    assert.throws(
      () => store.completeRun({
        runId: descriptor.runId,
        finishedAt: descriptor.startedAt,
        expectedStageIds: ["source"],
      }),
      /latest attempt succeeded/,
    );
    store.failRun({
      runId: descriptor.runId,
      finishedAt: descriptor.startedAt,
      error: "fixture failure",
    });
    assert.equal(store.getRun(descriptor.runId)?.status, "failed");
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
