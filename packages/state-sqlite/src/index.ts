import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  canonicalize,
  type CanonicalJson,
  type RunDescriptor,
  type RunRecord,
  type RunStateStore,
  type StageAttemptRecord,
} from "@map-pipeline/core";

interface RunRow {
  run_id: string;
  profile: string;
  pipeline: string;
  pipeline_version: number;
  partition_key: string;
  mode: RunRecord["mode"];
  status: RunRecord["status"];
  started_at: string;
  finished_at: string | null;
  error: string | null;
}

interface StageRow {
  run_id: string;
  stage_id: string;
  attempt: number;
  status: StageAttemptRecord["status"];
  started_at: string;
  finished_at: string | null;
  outputs_json: string;
  error: string | null;
}

function assertChanged(changes: number | bigint, message: string): void {
  if (Number(changes) !== 1) throw new Error(message);
}

export class SqliteRunStateStore implements RunStateStore {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    const resolved = resolve(path);
    mkdirSync(dirname(resolved), { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(resolved);
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#db.exec("PRAGMA busy_timeout = 5000");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        profile TEXT NOT NULL,
        pipeline TEXT NOT NULL,
        pipeline_version INTEGER NOT NULL CHECK (pipeline_version > 0),
        partition_key TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('validate', 'plan', 'preview', 'apply')),
        status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
        started_at TEXT NOT NULL,
        finished_at TEXT,
        error TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS stage_attempts (
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        stage_id TEXT NOT NULL,
        attempt INTEGER NOT NULL CHECK (attempt > 0),
        status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
        started_at TEXT NOT NULL,
        finished_at TEXT,
        outputs_json TEXT NOT NULL DEFAULT '{}',
        error TEXT,
        PRIMARY KEY (run_id, stage_id, attempt)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS checkpoints (
        checkpoint_key TEXT PRIMARY KEY,
        profile TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('preview', 'apply')),
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `);
  }

  beginRun(run: RunDescriptor): void {
    this.#db.prepare(`
      INSERT INTO runs (
        run_id, profile, pipeline, pipeline_version, partition_key, mode,
        status, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?)
    `).run(
      run.runId,
      run.profile,
      run.pipeline,
      run.pipelineVersion,
      run.partition,
      run.mode,
      run.startedAt,
    );
  }

  beginStage(input: {
    runId: string;
    stageId: string;
    startedAt: string;
  }): number {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const run = this.#db.prepare(
        "SELECT status FROM runs WHERE run_id = ?",
      ).get(input.runId) as { status: string } | undefined;
      if (run?.status !== "running") {
        throw new Error(`Run ${input.runId} is not running`);
      }
      const active = this.#db.prepare(`
        SELECT COUNT(*) AS count
        FROM stage_attempts
        WHERE run_id = ? AND stage_id = ? AND status = 'running'
      `).get(input.runId, input.stageId) as { count: number };
      if (active.count !== 0) {
        throw new Error(`Stage ${input.stageId} already has a running attempt`);
      }
      const row = this.#db.prepare(`
        SELECT COALESCE(MAX(attempt), 0) + 1 AS attempt
        FROM stage_attempts
        WHERE run_id = ? AND stage_id = ?
      `).get(input.runId, input.stageId) as { attempt: number };
      this.#db.prepare(`
        INSERT INTO stage_attempts (
          run_id, stage_id, attempt, status, started_at
        ) VALUES (?, ?, ?, 'running', ?)
      `).run(input.runId, input.stageId, row.attempt, input.startedAt);
      this.#db.exec("COMMIT");
      return row.attempt;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  completeStage(input: {
    runId: string;
    stageId: string;
    attempt: number;
    finishedAt: string;
    outputs: Record<string, string>;
  }): void {
    const result = this.#db.prepare(`
      UPDATE stage_attempts
      SET status = 'succeeded', finished_at = ?, outputs_json = ?, error = NULL
      WHERE run_id = ? AND stage_id = ? AND attempt = ? AND status = 'running'
    `).run(
      input.finishedAt,
      canonicalize(input.outputs),
      input.runId,
      input.stageId,
      input.attempt,
    );
    assertChanged(result.changes, "Stage attempt is not running");
  }

  failStage(input: {
    runId: string;
    stageId: string;
    attempt: number;
    finishedAt: string;
    error: string;
  }): void {
    const result = this.#db.prepare(`
      UPDATE stage_attempts
      SET status = 'failed', finished_at = ?, error = ?
      WHERE run_id = ? AND stage_id = ? AND attempt = ? AND status = 'running'
    `).run(
      input.finishedAt,
      input.error,
      input.runId,
      input.stageId,
      input.attempt,
    );
    assertChanged(result.changes, "Stage attempt is not running");
  }

  completeRun(input: {
    runId: string;
    finishedAt: string;
    expectedStageIds: string[];
  }): void {
    const expected = [...new Set(input.expectedStageIds)];
    if (
      expected.length !== input.expectedStageIds.length ||
      expected.some((stageId) => !stageId)
    ) {
      throw new Error("Expected stage IDs must be unique and non-empty");
    }
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const latest = this.#db.prepare(`
        SELECT attempts.stage_id, attempts.status
        FROM stage_attempts attempts
        INNER JOIN (
          SELECT stage_id, MAX(attempt) AS attempt
          FROM stage_attempts
          WHERE run_id = ?
          GROUP BY stage_id
        ) selected
          ON selected.stage_id = attempts.stage_id
         AND selected.attempt = attempts.attempt
        WHERE attempts.run_id = ?
      `).all(input.runId, input.runId) as unknown as Array<{
        stage_id: string;
        status: StageAttemptRecord["status"];
      }>;
      const actual = latest.map((row) => row.stage_id).sort();
      const required = [...expected].sort();
      if (
        actual.length !== required.length ||
        actual.some((stageId, index) => stageId !== required[index]) ||
        latest.some((row) => row.status !== "succeeded")
      ) {
        throw new Error(
          "Cannot complete a run unless every expected stage's latest attempt succeeded",
        );
      }
      const result = this.#db.prepare(`
        UPDATE runs
        SET status = 'succeeded', finished_at = ?, error = NULL
        WHERE run_id = ? AND status = 'running'
      `).run(input.finishedAt, input.runId);
      assertChanged(result.changes, "Run is not running");
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  failRun(input: { runId: string; finishedAt: string; error: string }): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare(`
        UPDATE stage_attempts
        SET status = 'failed', finished_at = ?, error = COALESCE(error, ?)
        WHERE run_id = ? AND status = 'running'
      `).run(input.finishedAt, input.error, input.runId);
      const result = this.#db.prepare(`
        UPDATE runs
        SET status = 'failed', finished_at = ?, error = ?
        WHERE run_id = ? AND status = 'running'
      `).run(input.finishedAt, input.error, input.runId);
      assertChanged(result.changes, "Run is not running");
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  getRun(runId: string): RunRecord | null {
    const row = this.#db.prepare(
      "SELECT * FROM runs WHERE run_id = ?",
    ).get(runId) as RunRow | undefined;
    if (!row) return null;
    return {
      runId: row.run_id,
      profile: row.profile,
      pipeline: row.pipeline,
      pipelineVersion: row.pipeline_version,
      partition: row.partition_key,
      mode: row.mode,
      status: row.status,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      error: row.error,
    };
  }

  listStageAttempts(runId: string): StageAttemptRecord[] {
    const rows = this.#db.prepare(`
      SELECT * FROM stage_attempts
      WHERE run_id = ?
      ORDER BY stage_id, attempt
    `).all(runId) as unknown as StageRow[];
    return rows.map((row) => ({
      runId: row.run_id,
      stageId: row.stage_id,
      attempt: row.attempt,
      status: row.status,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      outputs: JSON.parse(row.outputs_json) as Record<string, string>,
      error: row.error,
    }));
  }

  loadCheckpoint(key: string): CanonicalJson | null {
    const row = this.#db.prepare(
      "SELECT value_json FROM checkpoints WHERE checkpoint_key = ?",
    ).get(key) as { value_json: string } | undefined;
    return row ? JSON.parse(row.value_json) as CanonicalJson : null;
  }

  putCheckpoint(input: {
    key: string;
    profile: string;
    mode: "preview" | "apply";
    value: CanonicalJson;
    updatedAt: string;
  }): void {
    this.#db.prepare(`
      INSERT INTO checkpoints (
        checkpoint_key, profile, mode, value_json, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(checkpoint_key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
      WHERE checkpoints.profile = excluded.profile
        AND checkpoints.mode = excluded.mode
    `).run(
      input.key,
      input.profile,
      input.mode,
      canonicalize(input.value),
      input.updatedAt,
    );
    const row = this.#db.prepare(`
      SELECT profile, mode FROM checkpoints WHERE checkpoint_key = ?
    `).get(input.key) as { profile: string; mode: string };
    if (row.profile !== input.profile || row.mode !== input.mode) {
      throw new Error("Checkpoint key is already bound to another profile or mode");
    }
  }

  close(): void {
    this.#db.close();
  }
}
