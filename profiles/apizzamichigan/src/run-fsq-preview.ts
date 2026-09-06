#!/usr/bin/env node

import { mkdir, statfs } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { FixtureJsonResourceReader } from "@map-pipeline/adapter-files";
import { FilesystemJsonArtifactStore } from "@map-pipeline/artifacts-filesystem";
import { PreviewExecutor } from "@map-pipeline/executor";
import { SqliteRunStateStore } from "@map-pipeline/state-sqlite";

import {
  apizzaFsqPreviewCatalog,
  apizzaFsqPreviewDefinition,
  apizzaFsqPreviewPlugins,
  apizzaFsqPreviewSchemaValidators,
  apizzaPreviewHostPolicy,
} from "./fsq-preview.js";

function parseArgs(argv: string[]): { partition: string; runtimeRoot: string; runId?: string } {
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const result: { partition: string; runtimeRoot: string; runId?: string } = {
    partition: "US",
    runtimeRoot: resolve(repositoryRoot, ".map-pipeline", "apizza-fsq-preview"),
  };
  const valueAfter = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    return value;
  };
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--partition") {
      result.partition = valueAfter(index, argument);
      index += 1;
    } else if (argument === "--runtime-root") {
      result.runtimeRoot = resolve(valueAfter(index, argument));
      index += 1;
    } else if (argument === "--run-id") {
      result.runId = valueAfter(index, argument);
      index += 1;
    } else if (argument === "--help") {
      console.log(
        "Usage: npm run preview:apizza-fsq -- [--partition US] [--runtime-root path] [--run-id id]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (result.partition !== "US") {
    throw new Error("This mixed-state synthetic fixture must use partition US");
  }
  if (result.runId !== undefined && !result.runId.trim()) {
    throw new Error("Run ID must not be empty");
  }
  return result;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  await mkdir(args.runtimeRoot, { recursive: true, mode: 0o700 });
  const artifacts = new FilesystemJsonArtifactStore(
    resolve(args.runtimeRoot, "artifact-store"),
  );
  const state = new SqliteRunStateStore(resolve(args.runtimeRoot, "state.sqlite"));
  try {
    const reader = new FixtureJsonResourceReader({
      fixturesRoot: resolve(repositoryRoot, "fixtures"),
      manifestPath: resolve(repositoryRoot, "fixtures", "manifest.json"),
    });
    const executor = new PreviewExecutor({
      definition: apizzaFsqPreviewDefinition,
      catalog: apizzaFsqPreviewCatalog,
      plugins: apizzaFsqPreviewPlugins,
      readers: { files: reader },
      schemaValidators: apizzaFsqPreviewSchemaValidators,
      artifactStore: artifacts,
      stateStore: state,
      hostPolicy: apizzaPreviewHostPolicy,
      observedFreeDiskBytes: async () => {
        const stats = await statfs(args.runtimeRoot, { bigint: true });
        return Number(stats.bavail * stats.bsize);
      },
    });
    const report = await executor.run({
      partition: args.partition,
      ...(args.runId === undefined ? {} : { runId: args.runId }),
    });
    console.log(JSON.stringify({ ...report, runtimeRoot: args.runtimeRoot }, null, 2));
  } finally {
    state.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
