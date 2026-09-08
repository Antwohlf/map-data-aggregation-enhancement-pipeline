import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  JsonFileSnapshotResourceReader,
  type JsonFileSnapshotResource,
} from "@map-pipeline/adapter-files";
import {
  type PostgresSnapshotResource,
} from "@map-pipeline/adapter-postgres";
import {
  canonicalize,
  digest,
  type CanonicalJson,
  type PipelineDefinition,
} from "@map-pipeline/core";
import type {
  ShadowExecutionLock,
  ShadowSourceReadGrant,
} from "@map-pipeline/executor";

import {
  APIZZA_CANONICAL_SHADOW_SOURCE_URI,
  APIZZA_FSQ_SHADOW_SOURCE_URI,
  createApizzaFsqShadowV1Definition,
  createApizzaFsqShadowV1ExecutionLock,
  createApizzaFsqShadowV1ReadGrants,
} from "./fsq-shadow-v1.js";
import {
  APIZZA_FSQ_RELEASE_ROWS_SCHEMA,
  validateApizzaFsqReleaseRowsV1,
} from "./fsq-release-v1.js";
import { apizzaMichiganProfile } from "./index.js";
import { APIZZA_MATCHING_V1_MAX_CANDIDATES } from "./matching-v1.js";

const MAX_CONFIG_BYTES = 1_048_576;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const FSQ_POLICY_ID = "shadow:apizza-fsq-os-places-flatfile-v1";
const FSQ_CONTRACT_DIGEST =
  "sha256:4806be0c73df2c2e6b68279e1d8aa74d9c6bb7f71adb968515888e722d035ab8";
const CANONICAL_CONTRACT_DIGEST =
  "sha256:2870d183bc58344dbbd7fa9fa0f20b6988503257761e69865bab833b3a931017";
const repositoryRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));

const defaultPolicyPath = fileURLToPath(new URL(
  "../policy/fsq-os-places-shadow-policy.v1.json",
  import.meta.url,
));
const defaultCanonicalContractPath = fileURLToPath(new URL(
  "../contracts/canonical-match-v1.json",
  import.meta.url,
));

type PlainRecord = Record<string, unknown>;

export interface ApizzaFsqSourcePolicyAssertionV1 {
  schemaVersion: 1;
  policyId: string;
  profile: "apizzamichigan";
  adapter: "json-file-snapshot";
  resourceUri: string;
  dataset: "FSQ OS Places";
  approvalStatus: "pending_owner_approval" | "approved_read_only_shadow";
  approvedMode: "read_only_shadow";
  license: "Apache-2.0";
  attribution: string;
  termsRef: string;
  evidenceCapturedOn: string;
  ownerApprovedAt: string | null;
  expiresAt: string | null;
  projectionContract: {
    name: "apizza-fsq-release-rows";
    version: 1;
    digest: string;
  };
  containsPii: true;
  privacyReviewStatus:
    | "pending_conservative_classification"
    | "approved_restricted_projection";
  redistribution: "forbidden";
  rawArtifactRetentionDays: 0;
}

export interface ApizzaFsqShadowHostManifestV1 {
  schemaVersion: 1;
  deploymentIdentity: string;
  partition: "US";
  runtimeRoot: string;
  evaluationTime: string;
  fallbackRetrievedAt: string;
  expectedSourcePolicyDigest: string;
  fsq: {
    rootPath: string;
    relativePath: string;
    expectedContentDigest: string;
    childIds: string[];
    maxRecords: number;
  };
  postgres: {
    databaseInstanceId: string;
    viewDefinitionDigest: string;
    pageSize: number;
    maxRowBytes: number;
  };
}

interface CanonicalMatchContractV1 {
  contractSchemaVersion: 1;
  profile: "apizzamichigan";
  name: "apizza-canonical-match";
  version: 1;
  resourceUri: string;
  operation: "snapshot";
  partition: "US";
  databaseName: string;
  databaseRole: string;
  databaseContractOwner: string;
  databaseIdentityRelation: { schema: string; name: string };
  relation: { schema: string; name: string; kind: "view" };
  snapshotSchema: { name: string; version: number };
  cursor: {
    columns: string[];
    schema: { name: string; version: number };
    collation: "C";
    unique: true;
    maxUtf8Bytes: 256;
  };
  columns: Array<{
    name: string;
    type: "text" | "double precision" | "boolean" | "integer";
    nullable: boolean;
    sourceExpression: string;
  }>;
}

export interface ApizzaFsqShadowHostComposition {
  host: ApizzaFsqShadowHostManifestV1;
  sourcePolicy: ApizzaFsqSourcePolicyAssertionV1;
  sourcePolicyDigest: string;
  definition: PipelineDefinition;
  fsqResource: JsonFileSnapshotResource;
  canonicalResource: PostgresSnapshotResource;
  deploymentIdentity: string;
  executionLock: Readonly<ShadowExecutionLock>;
  sourceReadGrants: readonly ShadowSourceReadGrant[];
}

export interface ExclusiveRunLock {
  path: string;
  release(): Promise<void>;
}

export class ApizzaFsqShadowTerminationError extends Error {
  override readonly name = "ApizzaFsqShadowTerminationError";
}

function assertRecord(value: unknown, label: string): asserts value is PlainRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertExactKeys(value: PlainRecord, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError(`${label} has unknown or missing fields`);
  }
}

function assertCanonicalInstant(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a canonical timestamp`);
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed) || new Date(parsed).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical timestamp`);
  }
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest`);
  }
}

function assertCanonicalHttps(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a canonical HTTPS URL`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(`${label} must be a canonical HTTPS URL`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.search ||
    parsed.hash ||
    parsed.toString() !== value
  ) {
    throw new TypeError(`${label} must be a canonical HTTPS URL`);
  }
}

function assertAbsoluteNormalizedPath(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value) {
    throw new TypeError(`${label} must be an absolute normalized path`);
  }
}

function isWithin(parent: string, candidate: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}${sep}`);
}

function assertOutsideRepository(path: string, label: string): void {
  if (isWithin(repositoryRoot, resolve(path))) {
    throw new TypeError(`${label} must remain outside the public git worktree`);
  }
}

function assertDisjointPaths(left: string, right: string, label: string): void {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  if (
    isWithin(normalizedLeft, normalizedRight) ||
    isWithin(normalizedRight, normalizedLeft)
  ) {
    throw new TypeError(`${label} must not overlap`);
  }
}

function assertTrimmedIdentity(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !value ||
    value.trim() !== value ||
    value.normalize("NFC") !== value ||
    Buffer.byteLength(value, "utf8") > 512
  ) {
    throw new TypeError(`${label} must be bounded, trimmed NFC text`);
  }
}

async function readJson(path: string, label: string): Promise<CanonicalJson> {
  const file = await lstat(path);
  if (!file.isFile() || file.isSymbolicLink() || file.size > MAX_CONFIG_BYTES) {
    throw new TypeError(`${label} must be a regular JSON file no larger than ${MAX_CONFIG_BYTES} bytes`);
  }
  return JSON.parse(await readFile(path, "utf8")) as CanonicalJson;
}

async function assertPrivateFile(path: string, label: string): Promise<void> {
  const resolved = resolve(path);
  const file = await lstat(resolved);
  if (!file.isFile() || file.isSymbolicLink()) {
    throw new TypeError(`${label} must be a regular file and not a symbolic link`);
  }
  if (await realpath(resolved) !== resolved) {
    throw new TypeError(`${label} may not traverse symbolic links`);
  }
  if ((file.mode & 0o077) !== 0) {
    throw new TypeError(`${label} must not be accessible by group or other users`);
  }
  if (typeof process.getuid === "function" && file.uid !== process.getuid()) {
    throw new TypeError(`${label} must be owned by the current user`);
  }
}

async function assertPrivateDirectory(path: string, label: string): Promise<void> {
  const resolved = resolve(path);
  const directory = await lstat(resolved);
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new TypeError(`${label} must be a directory and not a symbolic link`);
  }
  if (await realpath(resolved) !== resolved) {
    throw new TypeError(`${label} may not traverse symbolic links`);
  }
  if ((directory.mode & 0o077) !== 0) {
    throw new TypeError(`${label} must not be accessible by group or other users`);
  }
  if (typeof process.getuid === "function" && directory.uid !== process.getuid()) {
    throw new TypeError(`${label} must be owned by the current user`);
  }
}

async function assertSafeDirectoryCreationPath(path: string, label: string): Promise<void> {
  let ancestor = resolve(path);
  while (true) {
    try {
      const entry = await lstat(ancestor);
      if (entry.isSymbolicLink()) {
        throw new TypeError(`${label} may not traverse symbolic links`);
      }
      const actual = await realpath(ancestor);
      if (actual !== ancestor) {
        throw new TypeError(`${label} may not traverse symbolic links`);
      }
      assertOutsideRepository(actual, label);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) {
        throw new TypeError(`${label} has no safe existing parent`);
      }
      ancestor = parent;
    }
  }
}

function parseSourcePolicy(value: CanonicalJson): ApizzaFsqSourcePolicyAssertionV1 {
  assertRecord(value, "FSQ source policy assertion");
  assertExactKeys(value, [
    "schemaVersion",
    "policyId",
    "profile",
    "adapter",
    "resourceUri",
    "dataset",
    "approvalStatus",
    "approvedMode",
    "license",
    "attribution",
    "termsRef",
    "evidenceCapturedOn",
    "ownerApprovedAt",
    "expiresAt",
    "projectionContract",
    "containsPii",
    "privacyReviewStatus",
    "redistribution",
    "rawArtifactRetentionDays",
  ], "FSQ source policy assertion");
  assertRecord(value.projectionContract, "FSQ projection contract policy");
  assertExactKeys(
    value.projectionContract,
    ["name", "version", "digest"],
    "FSQ projection contract policy",
  );
  assertDigest(value.projectionContract.digest, "FSQ projection contract digest");
  assertCanonicalHttps(value.termsRef, "FSQ source terms reference");
  if (
    value.schemaVersion !== 1 ||
    value.policyId !== FSQ_POLICY_ID ||
    value.profile !== "apizzamichigan" ||
    value.adapter !== "json-file-snapshot" ||
    value.resourceUri !== APIZZA_FSQ_SHADOW_SOURCE_URI ||
    value.dataset !== "FSQ OS Places" ||
    !["pending_owner_approval", "approved_read_only_shadow"].includes(
      String(value.approvalStatus),
    ) ||
    value.approvedMode !== "read_only_shadow" ||
    value.license !== "Apache-2.0" ||
    typeof value.attribution !== "string" ||
    !value.attribution.trim() ||
    typeof value.evidenceCapturedOn !== "string" ||
    !DATE.test(value.evidenceCapturedOn) ||
    value.projectionContract.name !== "apizza-fsq-release-rows" ||
    value.projectionContract.version !== 1 ||
    value.projectionContract.digest !== FSQ_CONTRACT_DIGEST ||
    value.containsPii !== true ||
    ![
      "pending_conservative_classification",
      "approved_restricted_projection",
    ].includes(String(value.privacyReviewStatus)) ||
    value.redistribution !== "forbidden" ||
    value.rawArtifactRetentionDays !== 0
  ) {
    throw new TypeError("FSQ source policy assertion does not match the frozen shadow policy");
  }
  if (value.ownerApprovedAt !== null) {
    assertCanonicalInstant(value.ownerApprovedAt, "FSQ owner approval time");
  }
  if (value.expiresAt !== null) {
    assertCanonicalInstant(value.expiresAt, "FSQ policy expiry");
  }
  if (
    (value.approvalStatus === "approved_read_only_shadow") !==
      (value.ownerApprovedAt !== null)
  ) {
    throw new TypeError("FSQ policy approval status and owner approval time disagree");
  }
  return structuredClone(value) as unknown as ApizzaFsqSourcePolicyAssertionV1;
}

function assertSourcePolicyActive(
  policy: ApizzaFsqSourcePolicyAssertionV1,
  now: Date,
): void {
  if (policy.approvalStatus !== "approved_read_only_shadow" || !policy.ownerApprovedAt) {
    throw new TypeError("FSQ source policy is pending explicit owner approval");
  }
  if (policy.privacyReviewStatus !== "approved_restricted_projection") {
    throw new TypeError("FSQ projection privacy classification is pending approval");
  }
  if (Date.parse(policy.ownerApprovedAt) > now.getTime()) {
    throw new TypeError("FSQ source policy approval time is in the future");
  }
  if (policy.expiresAt !== null && Date.parse(policy.expiresAt) <= now.getTime()) {
    throw new TypeError("FSQ source policy approval has expired");
  }
}

function parseHostManifest(value: CanonicalJson): ApizzaFsqShadowHostManifestV1 {
  assertRecord(value, "APizza FSQ shadow host manifest");
  assertExactKeys(value, [
    "schemaVersion",
    "deploymentIdentity",
    "partition",
    "runtimeRoot",
    "evaluationTime",
    "fallbackRetrievedAt",
    "expectedSourcePolicyDigest",
    "fsq",
    "postgres",
  ], "APizza FSQ shadow host manifest");
  assertRecord(value.fsq, "APizza FSQ host source");
  assertExactKeys(value.fsq, [
    "rootPath",
    "relativePath",
    "expectedContentDigest",
    "childIds",
    "maxRecords",
  ], "APizza FSQ host source");
  assertRecord(value.postgres, "APizza Postgres host source");
  assertExactKeys(value.postgres, [
    "databaseInstanceId",
    "viewDefinitionDigest",
    "pageSize",
    "maxRowBytes",
  ], "APizza Postgres host source");
  assertTrimmedIdentity(value.deploymentIdentity, "deploymentIdentity");
  assertAbsoluteNormalizedPath(value.runtimeRoot, "runtimeRoot");
  assertCanonicalInstant(value.evaluationTime, "evaluationTime");
  assertCanonicalInstant(value.fallbackRetrievedAt, "fallbackRetrievedAt");
  assertDigest(value.expectedSourcePolicyDigest, "expectedSourcePolicyDigest");
  assertAbsoluteNormalizedPath(value.fsq.rootPath, "fsq.rootPath");
  assertDigest(value.fsq.expectedContentDigest, "fsq.expectedContentDigest");
  assertDigest(value.postgres.viewDefinitionDigest, "postgres.viewDefinitionDigest");
  if (
    value.schemaVersion !== 1 ||
    value.partition !== "US" ||
    typeof value.fsq.relativePath !== "string" ||
    !value.fsq.relativePath ||
    isAbsolute(value.fsq.relativePath) ||
    value.fsq.relativePath.split(/[\\/]/).some(
      (part) => !part || part === "." || part === "..",
    ) ||
    !Array.isArray(value.fsq.childIds) ||
    value.fsq.childIds.length === 0 ||
    new Set(value.fsq.childIds).size !== value.fsq.childIds.length ||
    value.fsq.childIds.some(
      (childId) => typeof childId !== "string" || !childId || childId.trim() !== childId,
    ) ||
    !Number.isSafeInteger(value.fsq.maxRecords) ||
    Number(value.fsq.maxRecords) < 1 ||
    Number(value.fsq.maxRecords) > APIZZA_MATCHING_V1_MAX_CANDIDATES ||
    typeof value.postgres.databaseInstanceId !== "string" ||
    !UUID.test(value.postgres.databaseInstanceId) ||
    !Number.isSafeInteger(value.postgres.pageSize) ||
    Number(value.postgres.pageSize) < 1 ||
    Number(value.postgres.pageSize) > 5_000 ||
    !Number.isSafeInteger(value.postgres.maxRowBytes) ||
    Number(value.postgres.maxRowBytes) < 1 ||
    Number(value.postgres.maxRowBytes) > 1_048_576
  ) {
    throw new TypeError("APizza FSQ shadow host manifest is invalid");
  }
  return structuredClone(value) as unknown as ApizzaFsqShadowHostManifestV1;
}

function parseCanonicalContract(value: CanonicalJson): CanonicalMatchContractV1 {
  if (digest(value) !== CANONICAL_CONTRACT_DIGEST) {
    throw new TypeError("APizza canonical input contract digest has drifted");
  }
  assertRecord(value, "APizza canonical input contract");
  if (
    value.contractSchemaVersion !== 1 ||
    value.profile !== "apizzamichigan" ||
    value.name !== "apizza-canonical-match" ||
    value.version !== 1 ||
    value.resourceUri !== APIZZA_CANONICAL_SHADOW_SOURCE_URI ||
    value.operation !== "snapshot" ||
    value.partition !== "US"
  ) {
    throw new TypeError("APizza canonical input contract identity is invalid");
  }
  return structuredClone(value) as unknown as CanonicalMatchContractV1;
}

function canonicalResourceFrom(
  contract: CanonicalMatchContractV1,
  host: ApizzaFsqShadowHostManifestV1,
): PostgresSnapshotResource {
  return {
    resourceUri: contract.resourceUri,
    operation: contract.operation,
    partitions: [contract.partition],
    databaseName: contract.databaseName,
    databaseRole: contract.databaseRole,
    databaseContractOwner: contract.databaseContractOwner,
    databaseInstanceId: host.postgres.databaseInstanceId,
    databaseIdentityRelation: { ...contract.databaseIdentityRelation },
    schema: { ...contract.snapshotSchema },
    contract: {
      name: contract.name,
      version: contract.version,
      digest: CANONICAL_CONTRACT_DIGEST,
      viewDefinitionDigest: host.postgres.viewDefinitionDigest,
      cursorSchema: { ...contract.cursor.schema },
    },
    relation: { schema: contract.relation.schema, name: contract.relation.name },
    columns: contract.columns.map((column) => column.name),
    columnTypes: Object.fromEntries(
      contract.columns.map((column) => [column.name, column.type]),
    ),
    columnNullability: Object.fromEntries(
      contract.columns.map((column) => [column.name, column.nullable]),
    ),
    orderBy: [...contract.cursor.columns],
    pageSize: host.postgres.pageSize,
    maxRowBytes: host.postgres.maxRowBytes,
  };
}

export async function loadApizzaFsqShadowHostComposition(input: {
  hostManifestPath: string;
  sourcePolicyPath?: string;
  canonicalContractPath?: string;
  now?: Date;
  signal?: AbortSignal;
}): Promise<ApizzaFsqShadowHostComposition> {
  if (input.signal?.aborted) {
    throw new Error("APizza FSQ shadow host composition was aborted");
  }
  const hostManifestPath = resolve(input.hostManifestPath);
  assertOutsideRepository(hostManifestPath, "APizza FSQ shadow host manifest");
  await assertPrivateFile(hostManifestPath, "APizza FSQ shadow host manifest");
  const host = parseHostManifest(await readJson(hostManifestPath, "APizza FSQ shadow host manifest"));
  assertOutsideRepository(host.runtimeRoot, "runtimeRoot");
  assertOutsideRepository(host.fsq.rootPath, "fsq.rootPath");
  assertDisjointPaths(
    host.runtimeRoot,
    host.fsq.rootPath,
    "runtimeRoot and fsq.rootPath",
  );

  const sourcePolicy = parseSourcePolicy(await readJson(
    resolve(input.sourcePolicyPath ?? defaultPolicyPath),
    "APizza FSQ source policy assertion",
  ));
  assertSourcePolicyActive(sourcePolicy, input.now ?? new Date());
  const sourcePolicyDigest = digest(sourcePolicy as unknown as CanonicalJson);
  if (sourcePolicyDigest !== host.expectedSourcePolicyDigest) {
    throw new TypeError("Host manifest does not pin the exact FSQ source policy assertion");
  }

  const canonicalContract = parseCanonicalContract(await readJson(
    resolve(input.canonicalContractPath ?? defaultCanonicalContractPath),
    "APizza canonical input contract",
  ));
  await assertPrivateDirectory(host.fsq.rootPath, "FSQ projection root");
  await assertPrivateFile(
    join(host.fsq.rootPath, host.fsq.relativePath),
    "FSQ projection",
  );

  const fsqResource: JsonFileSnapshotResource = {
    resourceUri: APIZZA_FSQ_SHADOW_SOURCE_URI,
    operation: "snapshot",
    partitions: [host.partition],
    rootPath: host.fsq.rootPath,
    relativePath: host.fsq.relativePath,
    schema: { ...APIZZA_FSQ_RELEASE_ROWS_SCHEMA },
    contract: { ...sourcePolicy.projectionContract },
    expectedContentDigest: host.fsq.expectedContentDigest,
    childIds: [...host.fsq.childIds],
  };
  const timeoutSignal = AbortSignal.timeout(120_000);
  const preflightSignal = input.signal
    ? AbortSignal.any([input.signal, timeoutSignal])
    : timeoutSignal;
  const preflight = await new JsonFileSnapshotResourceReader({
    resources: [fsqResource],
  }).read({
    resourceUri: fsqResource.resourceUri,
    operation: fsqResource.operation,
    partition: host.partition,
    maxRecords: host.fsq.maxRecords,
    maxBytes: 16_777_216,
    timeoutMs: 120_000,
    signal: preflightSignal,
  });
  validateApizzaFsqReleaseRowsV1(preflight.value);
  const canonicalResource = canonicalResourceFrom(canonicalContract, host);
  const definition = createApizzaFsqShadowV1Definition({
    evaluationTime: host.evaluationTime,
    fallbackRetrievedAt: host.fallbackRetrievedAt,
    sourceLicense: sourcePolicy.license,
    sourceAttribution: sourcePolicy.attribution,
    sourcePolicyAssertionDigest: sourcePolicyDigest,
    sourceTermsRef: sourcePolicy.termsRef,
    fsqChildIds: host.fsq.childIds,
    maxFsqRecords: host.fsq.maxRecords,
  });
  const executionLock = createApizzaFsqShadowV1ExecutionLock({
    definition,
    profile: apizzaMichiganProfile,
    deploymentIdentity: host.deploymentIdentity,
  });
  const sourceReadGrants = createApizzaFsqShadowV1ReadGrants({
    definition,
    fsqResource,
    canonicalResource,
  });
  return Object.freeze({
    host: Object.freeze(host),
    sourcePolicy: Object.freeze(sourcePolicy),
    sourcePolicyDigest,
    definition,
    fsqResource,
    canonicalResource,
    deploymentIdentity: host.deploymentIdentity,
    executionLock,
    sourceReadGrants,
  });
}

export async function preparePrivateRuntimeRoot(runtimeRoot: string): Promise<void> {
  assertAbsoluteNormalizedPath(runtimeRoot, "runtimeRoot");
  assertOutsideRepository(runtimeRoot, "runtimeRoot");
  await assertSafeDirectoryCreationPath(runtimeRoot, "runtimeRoot");
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  await assertPrivateDirectory(runtimeRoot, "runtimeRoot");
}

function processExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function preparePrivateGlobalLockDirectory(): Promise<string> {
  if (typeof process.getuid !== "function") {
    throw new Error("APizza FSQ shadow host locking requires an operating-system user ID");
  }
  // Construct the standard OS path without embedding a host-path literal.
  const lockBase = join(sep, process.platform === "darwin" ? "private" : "var", "tmp");
  const root = resolve(lockBase, `map-data-pipeline-${process.getuid()}`);
  const locks = join(root, "locks");
  await mkdir(root, { recursive: true, mode: 0o700 });
  await assertPrivateDirectory(root, "map pipeline host lock root");
  await mkdir(locks, { recursive: true, mode: 0o700 });
  await assertPrivateDirectory(locks, "map pipeline host lock directory");
  return locks;
}

export async function acquireApizzaFsqShadowRunLock(): Promise<ExclusiveRunLock> {
  const lockDirectory = await preparePrivateGlobalLockDirectory();
  const path = join(lockDirectory, "apizza-fsq-shadow.lock");
  const owner = {
    schemaVersion: 1,
    host: hostname(),
    pid: process.pid,
    nonce: randomUUID(),
    acquiredAt: new Date().toISOString(),
  };

  const attempt = async (): Promise<boolean> => {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(`${canonicalize(owner)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  };

  if (!(await attempt())) {
    let existing: unknown = null;
    try {
      existing = JSON.parse(await readFile(path, "utf8"));
    } catch {
      // An unreadable or malformed lock is never assumed safe to remove.
    }
    assertRecord(existing, "existing APizza shadow run lock");
    const live = existing.host === hostname() &&
      typeof existing.pid === "number" &&
      processExists(existing.pid);
    if (live) throw new Error("An APizza FSQ shadow run is already active on this host");
    throw new Error(
      "A stale APizza FSQ shadow run lock requires operator inspection before removal",
    );
  }

  let released = false;
  return Object.freeze({
    path,
    async release() {
      if (released) return;
      const current = JSON.parse(await readFile(path, "utf8")) as PlainRecord;
      if (current.nonce !== owner.nonce || current.pid !== owner.pid) {
        throw new Error("APizza FSQ shadow run lock ownership changed before release");
      }
      await rm(path);
      released = true;
    },
  });
}

export async function runWithApizzaFsqShadowCleanup<T>(input: {
  work: () => Promise<T>;
  cleanups: ReadonlyArray<() => void | Promise<void>>;
  isTerminated: () => boolean;
}): Promise<T> {
  let result: T | undefined;
  let workFailed = false;
  let workError: unknown;
  try {
    result = await input.work();
  } catch (error) {
    workFailed = true;
    workError = error;
  }

  const cleanupErrors: unknown[] = [];
  for (const cleanup of input.cleanups) {
    try {
      await cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  const failures: unknown[] = [];
  if (workFailed) failures.push(workError);
  failures.push(...cleanupErrors);
  if (input.isTerminated()) {
    failures.push(new Error("APizza FSQ shadow runner was terminated"));
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "APizza FSQ shadow runner or cleanup failed");
  }
  return result as T;
}

export function formatApizzaFsqShadowFailure(_error: unknown): string {
  return "APizza FSQ shadow runner failed; inspect private host configuration and run state";
}

export const apizzaFsqShadowHostPaths = Object.freeze({
  sourcePolicy: defaultPolicyPath,
  canonicalContract: defaultCanonicalContractPath,
});
