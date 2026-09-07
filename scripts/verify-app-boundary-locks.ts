#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  verifyObservedJsonArtifact,
  verifyObservedTargetContractArtifact,
  type ObservedTargetContractReference,
} from "@map-pipeline/core";
import { apizzaMichiganProfile } from "../profiles/apizzamichigan/src/index.js";
import { tacoBoutMichiganProfile } from "../profiles/tacoboutmichigan/src/index.js";

interface LockedArtifact {
  path: string;
  byteLength: number;
  rawByteDigest: string;
  digestKind: "sha256-raw-bytes-v1";
  name?: string;
  version?: number;
}

interface AppBoundaryLock {
  lockSchemaVersion: number;
  activationEligible: boolean;
  sourceRepository: string;
  sourceRevision: string;
  sourceVisibilityAtObservation: string;
  profile: string;
  entity: string;
  artifacts: {
    boundaryConfig: LockedArtifact;
    statusSchema: LockedArtifact;
    targetContract: LockedArtifact;
  };
  redistribution: string;
}

function exactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} keys drifted`);
}

function record(value: unknown, label: string): Record<string, any> {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value as Record<string, any>;
}

function parseArgs(argv: string[]): { appRepository: string; appRef: string } {
  let appRepository = "";
  let appRef = "origin/main";
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--app-repository" && value) {
      appRepository = resolve(value);
      index += 1;
    } else if (argument === "--app-ref" && value) {
      appRef = value;
      index += 1;
    } else if (argument === "--help") {
      console.log("Usage: npm run verify:app-boundaries -- --app-repository <checkout> [--app-ref origin/main]");
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${argument}`);
    }
  }
  if (!appRepository) throw new Error("--app-repository is required");
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(appRef) || appRef.includes("..")) {
    throw new Error("--app-ref is invalid");
  }
  return { appRepository, appRef };
}

function gitBytes(repository: string, revision: string, path: string): Buffer {
  return execFileSync("git", ["-C", repository, "show", `${revision}:${path}`], {
    maxBuffer: 2 * 1024 * 1024,
  });
}

function validateLock(value: unknown, observed: ObservedTargetContractReference): AppBoundaryLock {
  const lock = record(value, "app boundary lock") as AppBoundaryLock;
  exactKeys(lock as unknown as Record<string, unknown>, [
    "lockSchemaVersion", "activationEligible", "sourceRepository", "sourceRevision",
    "sourceVisibilityAtObservation", "profile", "entity", "artifacts", "redistribution",
  ], "app boundary lock");
  assert.equal(lock.lockSchemaVersion, 1);
  assert.equal(lock.activationEligible, false);
  assert.equal(lock.sourceRepository, observed.ownerRepository);
  assert.equal(lock.sourceRevision, observed.source.revision);
  assert.equal(lock.sourceVisibilityAtObservation, "private");
  assert.equal(lock.profile, observed.profile);
  assert.equal(lock.entity, observed.entity);
  assert.equal(lock.redistribution, "metadata-only-source-artifacts-not-vendored");
  exactKeys(record(lock.artifacts, "artifacts"), ["boundaryConfig", "statusSchema", "targetContract"], "artifacts");
  for (const [name, artifact] of Object.entries(lock.artifacts)) {
    const expected = name === "targetContract"
      ? ["path", "byteLength", "rawByteDigest", "digestKind", "name", "version"]
      : ["path", "byteLength", "rawByteDigest", "digestKind"];
    exactKeys(record(artifact, name), expected, name);
    assert.equal(artifact.digestKind, "sha256-raw-bytes-v1");
  }
  assert.equal(lock.artifacts.targetContract.path, observed.source.path);
  assert.equal(lock.artifacts.targetContract.byteLength, observed.byteLength);
  assert.equal(lock.artifacts.targetContract.rawByteDigest, observed.rawByteDigest);
  assert.equal(lock.artifacts.targetContract.name, observed.contractName);
  assert.equal(lock.artifacts.targetContract.version, observed.version);
  return lock;
}

function validateBoundary(document: Readonly<Record<string, unknown>>, lock: AppBoundaryLock): void {
  exactKeys(document as Record<string, unknown>, ["version", "externalPipeline", "status"], "boundary");
  assert.equal(document.version, 1);
  const external = record(document.externalPipeline, "externalPipeline");
  exactKeys(external, ["repository", "writeEnabled", "effectAllowlist", "operationAllowlist"], "externalPipeline");
  assert.equal(external.repository, "Antwohlf/map-data-aggregation-enhancement-pipeline");
  assert.equal(external.writeEnabled, false);
  assert.deepEqual(external.effectAllowlist, []);
  assert.deepEqual(external.operationAllowlist, []);
  const status = record(document.status, "status");
  const target = record(record(status.targets, "status.targets")[lock.entity], `status target ${lock.entity}`);
  assert.equal(target.profile, lock.profile);
  assert.equal(target.defaultLane, lock.entity === "pizza" ? "legacy" : "disabled");
  assert.equal(target.contract.name, lock.artifacts.targetContract.name);
  assert.equal(target.contract.version, lock.artifacts.targetContract.version);
  assert.equal(target.contract.file, lock.artifacts.targetContract.path);
  const lanes = record(target.lanes, `${lock.entity} status lanes`);
  exactKeys(lanes, ["legacy", "shadow", "apply"], `${lock.entity} status lanes`);
  for (const [laneName, laneValue] of Object.entries(lanes)) {
    const lane = record(laneValue, `${lock.entity}/${laneName} status lane`);
    const registration = record(lane.registration, `${lock.entity}/${laneName} registration`);
    exactKeys(registration, ["state"], `${lock.entity}/${laneName} registration`);
    const shouldBeRegistered = lock.entity === "pizza" && laneName === "legacy";
    assert.equal(
      registration.state,
      shouldBeRegistered ? "registered" : "unregistered",
      `${lock.entity}/${laneName} status registration is unsafe`,
    );
    if (laneName !== "legacy") {
      assert.equal(lane.producerKind, "external-pipeline");
      assert.equal(lane.producerRepository, "Antwohlf/map-data-aggregation-enhancement-pipeline");
    }
  }
}

function validateStatusSchema(document: Readonly<Record<string, unknown>>): void {
  assert.equal(document.type, "object");
  assert.equal(document.additionalProperties, false);
  assert.equal(document.$id, "https://github.com/Antwohlf/apizzamichigan/blob/main/contracts/pipeline-status.v1.schema.json");
  const required = document.required;
  assert(Array.isArray(required));
  for (const key of ["purpose", "lane", "bindings", "profile", "entity", "producer", "run", "health", "ui"]) {
    assert(required.includes(key), `status schema is missing ${key}`);
  }
}

function validateTargetDocument(document: Readonly<Record<string, unknown>>, expected: {
  table: string;
  rpc: string;
  role: string;
}): void {
  exactKeys(document as Record<string, unknown>, [
    "contractSchemaVersion", "name", "version", "ownerRepository", "profile", "entity",
    "partition", "logicalResourceUri", "effectClass", "authority", "deployment",
    "localCanonical", "publicMirror", "externalAuthorization", "legacyCapability",
    "protectedLocalRelations",
  ], "target contract");
  const local = record(document.localCanonical, "localCanonical");
  const mirror = record(document.publicMirror, "publicMirror");
  const authorization = record(document.externalAuthorization, "externalAuthorization");
  const legacy = record(document.legacyCapability, "legacyCapability");
  const rpc = record(legacy.rpc, "legacyCapability.rpc");
  assert.equal(local.table, expected.table);
  assert.equal(mirror.table, expected.table);
  assert.equal(authorization.requiredPrincipal, expected.role);
  assert.equal(rpc.name, expected.rpc);
  assert.equal(rpc.currentExecuteRole, "service_role");
  assert.equal(legacy.unknownFieldPolicy, "reject-before-transport");
  assert(String(legacy.deploymentState).startsWith("unverified"));
  assert(Array.isArray(legacy.allowedPatchFields));
  assert(!legacy.allowedPatchFields.includes("name"));
  assert(!legacy.allowedPatchFields.includes("rating"));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const products = [
    {
      lockUrl: new URL("../profiles/apizzamichigan/contracts/app-boundary-lock.v1.json", import.meta.url),
      profile: apizzaMichiganProfile,
      table: "pizza_places",
      rpc: "apply_pizza_places_sync_batch",
      role: "map_pipeline_apizza_writer",
    },
    {
      lockUrl: new URL("../profiles/tacoboutmichigan/contracts/app-boundary-lock.v1.json", import.meta.url),
      profile: tacoBoutMichiganProfile,
      table: "taco_places",
      rpc: "apply_taco_places_sync_batch",
      role: "map_pipeline_taco_writer",
    },
  ] as const;

  for (const product of products) {
    const observed = product.profile.observedTargetContract;
    assert(observed, `${product.profile.id} lacks an observed target contract`);
    assert.equal(product.profile.targetContract.digest, null);
    assert.equal(product.profile.targetContract.digestKind, "sha256-canonical-json-v1");
    assert.deepEqual(product.profile.targetContract.supportedVersions, []);
    const lock = validateLock(
      JSON.parse(await readFile(product.lockUrl, "utf8")),
      observed,
    );
    const ancestry = spawnSync("git", ["-C", args.appRepository, "merge-base", "--is-ancestor", lock.sourceRevision, args.appRef]);
    assert.equal(ancestry.status, 0, `${lock.sourceRevision} is not an ancestor of ${args.appRef}`);

    for (const [name, artifact] of Object.entries(lock.artifacts)) {
      const pinnedBytes = gitBytes(args.appRepository, lock.sourceRevision, artifact.path);
      const currentBytes = gitBytes(args.appRepository, args.appRef, artifact.path);
      const pinned = verifyObservedJsonArtifact({ bytes: pinnedBytes, binding: artifact });
      verifyObservedJsonArtifact({ bytes: currentBytes, binding: artifact });
      if (name === "boundaryConfig") validateBoundary(pinned, lock);
      if (name === "statusSchema") validateStatusSchema(pinned);
    }

    const targetBytes = gitBytes(args.appRepository, lock.sourceRevision, lock.artifacts.targetContract.path);
    verifyObservedTargetContractArtifact({
      bytes: targetBytes,
      reference: observed,
      validateDocument(document) {
        validateTargetDocument(document, product);
      },
    });
    console.log(`${lock.profile}/${lock.entity}: app boundary lock verified; activation=false`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
