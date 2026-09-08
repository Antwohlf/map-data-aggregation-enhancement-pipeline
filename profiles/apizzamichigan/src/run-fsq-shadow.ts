#!/usr/bin/env node

import { statfs } from "node:fs/promises";
import { resolve } from "node:path";

import {
  JSON_FILE_SNAPSHOT_ADAPTER,
  JsonFileSnapshotResourceReader,
} from "@map-pipeline/adapter-files";
import {
  POSTGRES_READONLY_ADAPTER,
  PostgresSnapshotResourceReader,
} from "@map-pipeline/adapter-postgres";
import { FilesystemJsonArtifactStore } from "@map-pipeline/artifacts-filesystem";
import { ReadOnlyShadowExecutor } from "@map-pipeline/executor";
import { SqliteRunStateStore } from "@map-pipeline/state-sqlite";

import {
  acquireApizzaFsqShadowRunLock,
  formatApizzaFsqShadowFailure,
  loadApizzaFsqShadowHostComposition,
  preparePrivateRuntimeRoot,
  runWithApizzaFsqShadowCleanup,
} from "./fsq-shadow-host-v1.js";
import {
  apizzaFsqShadowV1Catalog,
  apizzaFsqShadowV1HostPolicy,
  apizzaFsqShadowV1Plugins,
  apizzaFsqShadowV1SchemaValidators,
} from "./fsq-shadow-v1.js";
import { apizzaMichiganProfile } from "./index.js";

interface RunnerArgs {
  hostManifestPath: string;
  runId?: string;
}

function valueAfter(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

export function parseApizzaFsqShadowRunnerArgs(argv: readonly string[]): RunnerArgs {
  let hostManifestPath: string | undefined;
  let runId: string | undefined;
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--host-manifest") {
      hostManifestPath = resolve(valueAfter(argv, index, argument));
      index += 1;
    } else if (argument === "--run-id") {
      runId = valueAfter(argv, index, argument);
      index += 1;
    } else if (argument === "--help") {
      console.log(
        "Usage: npm run preview:apizza-fsq-shadow -- --host-manifest <owner-only-json> [--run-id id]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!hostManifestPath) throw new Error("--host-manifest is required");
  if (runId !== undefined && (!runId || runId.trim() !== runId || runId.normalize("NFC") !== runId)) {
    throw new Error("Run ID must be non-empty, trimmed NFC text");
  }
  return { hostManifestPath, ...(runId === undefined ? {} : { runId }) };
}

function requiredDatabaseConnectionString(): string {
  const value = process.env.APIZZA_SHADOW_DATABASE_URL;
  if (!value) {
    throw new Error("APIZZA_SHADOW_DATABASE_URL must contain the dedicated read-only DSN");
  }
  return value;
}

async function main(): Promise<void> {
  const args = parseApizzaFsqShadowRunnerArgs(process.argv);
  let postgres: PostgresSnapshotResourceReader | undefined;
  let state: SqliteRunStateStore | undefined;
  let lock: Awaited<ReturnType<typeof acquireApizzaFsqShadowRunLock>> | undefined;
  const termination = new AbortController();
  let terminated = false;
  const terminate = () => {
    terminated = true;
    termination.abort(new Error("Host requested runner termination"));
  };
  process.on("SIGINT", terminate);
  process.on("SIGTERM", terminate);
  try {
    const success = await runWithApizzaFsqShadowCleanup({
      work: async () => {
        // The manifest-independent host lock is held before the projection
        // preflight, pool construction, or runtime-state creation.
        lock = await acquireApizzaFsqShadowRunLock();
        const composition = await loadApizzaFsqShadowHostComposition({
          hostManifestPath: args.hostManifestPath,
          signal: termination.signal,
        });
        await preparePrivateRuntimeRoot(composition.host.runtimeRoot);
        postgres = new PostgresSnapshotResourceReader({
          resources: [composition.canonicalResource],
          connectionString: requiredDatabaseConnectionString(),
        });
        state = new SqliteRunStateStore(resolve(composition.host.runtimeRoot, "state.sqlite"));
        const executor = new ReadOnlyShadowExecutor({
          definition: composition.definition,
          catalog: apizzaFsqShadowV1Catalog,
          plugins: apizzaFsqShadowV1Plugins,
          readers: {
            [JSON_FILE_SNAPSHOT_ADAPTER]: new JsonFileSnapshotResourceReader({
              resources: [composition.fsqResource],
            }),
            [POSTGRES_READONLY_ADAPTER]: postgres,
          },
          schemaValidators: apizzaFsqShadowV1SchemaValidators,
          artifactStore: new FilesystemJsonArtifactStore(resolve(
            composition.host.runtimeRoot,
            "artifact-store",
          )),
          stateStore: state,
          hostPolicy: apizzaFsqShadowV1HostPolicy,
          observedFreeDiskBytes: async () => {
            const stats = await statfs(composition.host.runtimeRoot, { bigint: true });
            return Number(stats.bavail * stats.bsize);
          },
          deploymentIdentity: composition.deploymentIdentity,
          profile: apizzaMichiganProfile,
          executionLock: composition.executionLock,
          allowedPartitions: [composition.host.partition],
          sourceReadGrants: composition.sourceReadGrants,
        });
        const report = await executor.run({
          partition: composition.host.partition,
          ...(args.runId === undefined ? {} : { runId: args.runId }),
          signal: termination.signal,
        });
        const terminalStage = report.stages.at(-1);
        const terminalOutput = terminalStage?.outputs.report;
        if (!terminalStage || !terminalOutput) {
          throw new Error("APizza FSQ shadow run produced no terminal report");
        }
        return {
          status: report.status,
          runtimeClass: report.runtimeClass,
          runId: report.runId,
          profile: report.profile,
          pipeline: report.pipeline,
          pipelineVersion: report.pipelineVersion,
          partition: report.partition,
          startedAt: report.startedAt,
          finishedAt: report.finishedAt,
          bindings: report.bindings,
          terminal: {
            stageId: terminalStage.stageId,
            outputPort: "report",
            contentDigest: terminalOutput.contentDigest,
            manifestDigest: terminalOutput.manifestDigest,
            recordCount: terminalOutput.recordCount,
          },
          productWrites: 0,
        };
      },
      cleanups: [
        () => postgres?.close(),
        () => state?.close(),
        () => lock?.release(),
      ],
      isTerminated: () => terminated,
    });
    console.log(JSON.stringify(success, null, 2));
  } catch (error) {
    if (terminated) process.exitCode = 143;
    throw error;
  } finally {
    process.removeListener("SIGINT", terminate);
    process.removeListener("SIGTERM", terminate);
  }
}

main().catch((error: unknown) => {
  console.error(formatApizzaFsqShadowFailure(error));
  if (!process.exitCode) process.exitCode = 1;
});
