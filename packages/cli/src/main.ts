#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { Ajv2020 } from "ajv/dist/2020.js";
import {
  validateDefinition,
  type PipelineDefinition,
  type StagePluginManifest,
} from "@map-pipeline/core";

function usage(): never {
  console.error(
    "Usage: map-pipeline validate --definition <file> --catalog <file>",
  );
  process.exit(2);
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function validateShape(
  value: unknown,
  schemaPath: string,
  label: string,
): Promise<boolean> {
  const schema = await readJson<object>(schemaPath);
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  if (validate(value)) return true;
  for (const error of validate.errors ?? []) {
    console.error(`${label}${error.instancePath || "/"}: ${error.message}`);
  }
  return false;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== "validate") {
    usage();
  }

  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      definition: { type: "string" },
      catalog: { type: "string" },
    },
    strict: true,
  });
  if (!values.definition || !values.catalog) {
    usage();
  }

  const definitionValue = await readJson<unknown>(values.definition);
  const catalogValue = await readJson<unknown>(values.catalog);
  const schemaRoot = new URL("../../../schemas/", import.meta.url);
  const shapesValid =
    (await validateShape(
      definitionValue,
      fileURLToPath(new URL("pipeline-definition.v1alpha1.schema.json", schemaRoot)),
      "definition",
    )) &&
    (await validateShape(
      catalogValue,
      fileURLToPath(new URL("plugin-catalog.v1alpha1.schema.json", schemaRoot)),
      "catalog",
    ));
  if (!shapesValid) {
    process.exitCode = 1;
    return;
  }

  const definition = definitionValue as PipelineDefinition;
  const catalog = catalogValue as Record<string, StagePluginManifest>;
  const issues = validateDefinition(definition, catalog);
  if (issues.length) {
    for (const issue of issues) {
      console.error(`${issue.path}: ${issue.message}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    JSON.stringify({
      valid: true,
      profile: definition.profile,
      pipeline: definition.metadata.name,
      version: definition.metadata.version,
      stages: definition.stages.length,
    }),
  );
}

try {
  await main();
} catch {
  console.error("input: unable to read, parse, or validate the requested files");
  process.exitCode = 1;
}
