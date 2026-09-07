import assert from "node:assert/strict";
import test from "node:test";

import { canonicalize, digest, type CanonicalJson } from "@map-pipeline/core";

import type {
  PostgresClientProvider,
  PostgresReadClient,
  PostgresSnapshotResource,
} from "./index.js";
import {
  computePostgresSnapshotReaderBindingDigest,
  PostgresSnapshotReadError,
  PostgresSnapshotResourceReader,
} from "./index.js";

const RESOURCE_URI = "postgres-view://pipeline-input/apizza-canonical-match-v1";
const CONTRACT_DIGEST = `sha256:${"a".repeat(64)}`;
const VIEW_DEFINITION = " SELECT pizza_places.id::text AS canonical_place_id, pizza_places.name FROM pizza_places;";
const VIEW_DEFINITION_DIGEST = digest({ viewDefinition: VIEW_DEFINITION });
const resource: PostgresSnapshotResource = {
  resourceUri: RESOURCE_URI,
  operation: "snapshot",
  partitions: ["US"],
  databaseName: "pizza_enrichment",
  databaseRole: "map_pipeline_apizza_shadow_reader",
  databaseContractOwner: "map_pipeline_contract_owner",
  databaseInstanceId: "018f4c5e-7a6b-7def-8abc-1234567890ab",
  databaseIdentityRelation: { schema: "pipeline_control", name: "database_identity" },
  schema: { name: "apizza.canonical-match-snapshot", version: 1 },
  contract: {
    name: "apizza-canonical-match",
    version: 1,
    digest: CONTRACT_DIGEST,
    viewDefinitionDigest: VIEW_DEFINITION_DIGEST,
    cursorSchema: { name: "apizza.canonical-place-id-cursor", version: 1 },
  },
  relation: { schema: "pipeline_input", name: "apizza_canonical_match_v1" },
  columns: ["canonical_place_id", "name"],
  columnTypes: { canonical_place_id: "text", name: "text" },
  columnNullability: { canonical_place_id: false, name: true },
  orderBy: ["canonical_place_id"],
};

type Step =
  | Array<Record<string, unknown>>
  | Error
  | ((sql: string, values: unknown[] | undefined) => Array<Record<string, unknown>>);

function encodeRow(row: Record<string, unknown>): Record<string, unknown> {
  const payload = JSON.stringify(row);
  return {
    __pipeline_cursor: row.canonical_place_id,
    __pipeline_payload: payload,
    __pipeline_payload_bytes: Buffer.byteLength(payload, "utf8"),
  };
}

class ScriptedClient implements PostgresReadClient {
  readonly queries: Array<{ sql: string; values: unknown[] | undefined }> = [];
  readonly releases: boolean[] = [];
  readonly #steps: Step[];

  constructor(
    rows: Array<Record<string, unknown>>,
    options: {
      dataStep?: Step;
      dataSteps?: Step[];
      identityOverrides?: Record<string, unknown>;
      invalidCursor?: boolean;
    } = {},
  ) {
    this.#steps = [
      [],
      [],
      [{ statement_timeout: "30000ms", lock_timeout: "2000ms", idle_timeout: "30000ms" }],
      [{ read_only: "on", isolation: "repeatable read" }],
      [{
        database_name: resource.databaseName,
        database_role: resource.databaseRole,
        database_session_role: resource.databaseRole,
        role_can_login: true,
        role_inherits: false,
        role_has_memberships: false,
        role_connection_limit: 2,
        role_superuser: false,
        role_create_database: false,
        role_create_role: false,
        role_replication: false,
        role_bypass_rls: false,
        contract_owner_role: resource.databaseContractOwner,
        contract_owner_can_login: false,
        contract_owner_inherits: false,
        contract_owner_has_memberships: false,
        contract_owner_superuser: false,
        contract_owner_create_database: false,
        contract_owner_create_role: false,
        contract_owner_replication: false,
        contract_owner_bypass_rls: false,
        database_instance_id: resource.databaseInstanceId,
        snapshot_id: "100:200:",
        captured_at: "2026-09-06T12:00:00.000Z",
        contract_comment: `map-pipeline-contract:${resource.contract.name}@1:${CONTRACT_DIGEST}`,
        relation_kind: "v",
        view_security_barrier: true,
        view_options: ["security_barrier=true"],
        relation_owner: "map_pipeline_contract_owner",
        view_owner_membership: false,
        view_definition: VIEW_DEFINITION,
        identity_relation_kind: "r",
        identity_relation_owner: "map_pipeline_contract_owner",
        identity_owner_membership: false,
        column_types: JSON.stringify(resource.columnTypes),
        ...options.identityOverrides,
      }],
      [{ __pipeline_has_invalid_cursor: options.invalidCursor ?? false }],
      ...(options.dataSteps ?? [options.dataStep ?? rows.map(encodeRow)]),
      [],
    ];
  }

  async query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> {
    this.queries.push({ sql, values });
    const step = this.#steps.shift();
    if (step instanceof Error) throw step;
    if (typeof step === "function") return { rows: step(sql, values) };
    if (!step) throw new Error("Unexpected query");
    return { rows: step };
  }

  release(destroy = false): void {
    this.releases.push(destroy);
  }
}

function provider(client: ScriptedClient): PostgresClientProvider & { connects: number } {
  return {
    connects: 0,
    async connect() {
      this.connects += 1;
      return client;
    },
    async close() {},
  };
}

function readerWith(client: ScriptedClient) {
  return new PostgresSnapshotResourceReader({
    resources: [resource],
    provider: provider(client),
  });
}

function readerWithResource(client: ScriptedClient, configuredResource: PostgresSnapshotResource) {
  return new PostgresSnapshotResourceReader({
    resources: [configuredResource],
    provider: provider(client),
  });
}

function readOptions(overrides: Partial<{
  resourceUri: string;
  operation: string;
  maxRecords: number;
  maxBytes: number;
  partition: string;
  timeoutMs: number;
  signal: AbortSignal;
}> = {}) {
  return {
    resourceUri: RESOURCE_URI,
    operation: "snapshot",
    partition: "US",
    maxRecords: 10,
    maxBytes: 4096,
    timeoutMs: 60_000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

test("reads a complete deterministic snapshot in a read-only repeatable-read transaction", async () => {
  const client = new ScriptedClient([
    { canonical_place_id: "1", name: "Alpha Pizza" },
    { canonical_place_id: "2", name: "Beta Pizza" },
  ]);
  const result = await readerWith(client).read(readOptions());

  assert.deepEqual(result.value, {
    version: 1,
    rows: [
      { canonical_place_id: "1", name: "Alpha Pizza" },
      { canonical_place_id: "2", name: "Beta Pizza" },
    ],
  });
  assert.deepEqual(result.schema, resource.schema);
  assert.deepEqual(result.observedChildIds, []);
  assert.deepEqual(result.snapshot, {
    snapshotId: "100:200:",
    sourceInstanceDigest: "sha256:2e4ae94a65adac00aea01e1ec9a79e9a8c3e822aa36c86167af5aecdb4d3ca56",
    readerBindingDigest: "sha256:169c8be90f1236aaa1060657c3a10a714134ca99974e22470244ccf970ed9070",
    capturedAt: "2026-09-06T12:00:00.000Z",
    consistency: "repeatable_read",
    cursorSchema: resource.contract.cursorSchema,
    startExclusive: null,
    endInclusive: ["2"],
    complete: true,
    contractName: resource.contract.name,
    contractVersion: 1,
    contractDigest: CONTRACT_DIGEST,
  });
  assert.equal(client.queries[0]?.sql, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  assert.equal(client.queries[1]?.sql, "SET LOCAL search_path = pg_catalog, pg_temp");
  assert.deepEqual(client.queries[2]?.values, ["30000ms", "2000ms", "30000ms"]);
  assert.match(client.queries[4]?.sql ?? "", /FROM "pipeline_control"\."database_identity"/);
  assert.match(client.queries[5]?.sql ?? "", /GROUP BY "canonical_place_id"/);
  assert.match(client.queries[6]?.sql ?? "", /FROM "pipeline_input"\."apizza_canonical_match_v1"/);
  assert.match(client.queries[6]?.sql ?? "", /ORDER BY "canonical_place_id"/);
  const transferBudget = 4096 - Buffer.byteLength(
    canonicalize({ version: 1, rows: [] } as CanonicalJson),
    "utf8",
  ) + 1;
  assert.deepEqual(client.queries[6]?.values, [11, transferBudget, transferBudget]);
  assert.equal(client.queries[7]?.sql, "ROLLBACK");
  assert.deepEqual(client.releases, [false]);
});

test("exports the exact validated reader binding digest used by snapshot attestations", () => {
  assert.equal(
    computePostgresSnapshotReaderBindingDigest(resource),
    "sha256:169c8be90f1236aaa1060657c3a10a714134ca99974e22470244ccf970ed9070",
  );
  assert.throws(
    () => computePostgresSnapshotReaderBindingDigest({
      ...resource,
      orderBy: ["missing_column"],
    }),
    /must be selected/,
  );
});

test("rejects an unregistered logical URI without opening a connection", async () => {
  const client = new ScriptedClient([]);
  const clientProvider = provider(client);
  const reader = new PostgresSnapshotResourceReader({ resources: [resource], provider: clientProvider });
  await assert.rejects(
    () => reader.read(readOptions({ resourceUri: "postgres-view://pipeline-input/taco-v1" })),
    /not registered/,
  );
  assert.equal(clientProvider.connects, 0);
});

test("uses cap-plus-one and fails instead of truncating an oversized snapshot", async () => {
  const client = new ScriptedClient([
    { canonical_place_id: "1", name: "Alpha" },
    { canonical_place_id: "2", name: "Beta" },
    { canonical_place_id: "3", name: "Gamma" },
  ]);
  await assert.rejects(
    () => readerWith(client).read(readOptions({ maxRecords: 2 })),
    /exceeds the authorized 2-record limit/,
  );
  const transferBudget = 4096 - Buffer.byteLength(
    canonicalize({ version: 1, rows: [] } as CanonicalJson),
    "utf8",
  ) + 1;
  assert.deepEqual(client.queries[6]?.values, [3, transferBudget, transferBudget]);
  assert.equal(client.queries.at(-1)?.sql, "ROLLBACK");
  assert.deepEqual(client.releases, [true]);
});

test("fails closed on duplicate order keys and unexpected columns", async () => {
  const duplicate = new ScriptedClient([
    { canonical_place_id: "1", name: "Alpha" },
    { canonical_place_id: "1", name: "Other" },
  ], { invalidCursor: true });
  await assert.rejects(
    () => readerWith(duplicate).read(readOptions()),
    /cursor must be unique, bounded, and non-empty/,
  );

  const extra = new ScriptedClient([
    { canonical_place_id: "1", name: "Alpha", private_notes: "must not cross" },
  ]);
  await assert.rejects(
    () => readerWith(extra).read(readOptions()),
    /unexpected columns/,
  );
});

test("checks snapshot-wide cursor uniqueness before keyset pagination", async () => {
  const client = new ScriptedClient([
    { canonical_place_id: "same", name: "First" },
    { canonical_place_id: "same", name: "Second" },
  ], { invalidCursor: true });
  await assert.rejects(
    () => readerWithResource(client, { ...resource, pageSize: 1 }).read(readOptions()),
    /cursor must be unique, bounded, and non-empty/,
  );
  assert.match(client.queries[5]?.sql ?? "", /count\(\*\) > 1/);
  assert.equal(client.queries.some(({ sql }) => sql.includes("WITH page AS")), false);
});

test("uses bounded keyset pages inside one snapshot", async () => {
  const client = new ScriptedClient([], {
    dataSteps: [
      [encodeRow({ canonical_place_id: "1", name: "Alpha" })],
      [encodeRow({ canonical_place_id: "2", name: "Beta" })],
      [],
    ],
  });
  const result = await readerWithResource(client, { ...resource, pageSize: 1 }).read(readOptions());
  assert.equal((result.value as { rows: unknown[] }).rows.length, 2);
  assert.deepEqual(client.queries[6]?.values?.slice(0, 1), [1]);
  assert.deepEqual(client.queries[7]?.values?.slice(0, 2), ["1", 1]);
  assert.deepEqual(client.queries[8]?.values?.slice(0, 2), ["2", 1]);
});

test("enforces the byte bound before returning an acquisition", async () => {
  const client = new ScriptedClient([
    { canonical_place_id: "1", name: "A deliberately long pizza name" },
  ]);
  await assert.rejects(
    () => readerWith(client).read(readOptions({ maxBytes: 8 })),
    /exceeds the authorized 8-byte limit/,
  );
  assert.equal(client.queries.at(-1)?.sql, "ROLLBACK");
  assert.deepEqual(client.releases, [true]);
});

test("redacts database error details while retaining a safe SQLSTATE", async () => {
  const failure = Object.assign(
    new Error("password=do-not-log host=private-host relation=private_table"),
    { code: "42501" },
  );
  const client = new ScriptedClient([], { dataStep: failure });
  await assert.rejects(
    () => readerWith(client).read(readOptions()),
    (error: unknown) => {
      assert.ok(error instanceof PostgresSnapshotReadError);
      assert.equal(error.message, "Postgres snapshot read failed (SQLSTATE 42501)");
      assert.doesNotMatch(error.message, /do-not-log|private-host|private_table/);
      return true;
    },
  );
  assert.equal(client.queries.at(-1)?.sql, "ROLLBACK");
  assert.deepEqual(client.releases, [true]);
});

test("requires a dedicated credential-bearing DSN and fixed safe identifiers", () => {
  assert.throws(
    () => new PostgresSnapshotResourceReader({
      resources: [resource],
      connectionString: "postgresql://broad-user@localhost/pizza_enrichment",
    }),
    /dedicated username and password/,
  );
  const remoteDsn = new URL("postgresql://db.example.invalid/pizza_enrichment");
  remoteDsn.username = "map_pipeline_reader";
  remoteDsn.password = ["unit", "test", "only"].join("-");
  assert.throws(
    () => new PostgresSnapshotResourceReader({
      resources: [resource],
      connectionString: remoteDsn.toString(),
    }),
    /sslmode=verify-full/,
  );
  remoteDsn.searchParams.append("sslmode", "verify-full");
  remoteDsn.searchParams.append("sslmode", "no-verify");
  assert.throws(
    () => new PostgresSnapshotResourceReader({
      resources: [resource],
      connectionString: remoteDsn.toString(),
    }),
    /sslmode=verify-full/,
  );
  const identityOverrideDsn = new URL("postgresql://localhost/pizza_enrichment");
  identityOverrideDsn.username = "map_pipeline_reader";
  identityOverrideDsn.password = ["unit", "test", "only"].join("-");
  identityOverrideDsn.searchParams.set("user", "postgres");
  assert.throws(
    () => new PostgresSnapshotResourceReader({
      resources: [resource],
      connectionString: identityOverrideDsn.toString(),
    }),
    /permit only one optional/,
  );
  assert.throws(
    () => new PostgresSnapshotResourceReader({
      resources: [{
        ...resource,
        relation: { schema: "pipeline_input", name: "view; drop table pizza_places" },
      }],
      provider: provider(new ScriptedClient([])),
    }),
    /lowercase PostgreSQL identifier/,
  );
  assert.throws(
    () => new PostgresSnapshotResourceReader({
      resources: [{
        ...resource,
        contract: { ...resource.contract, viewDefinitionDigest: "not-a-digest" },
      }],
      provider: provider(new ScriptedClient([])),
    }),
    /resource contract is invalid/,
  );
  assert.throws(
    () => new PostgresSnapshotResourceReader({
      resources: [{
        ...resource,
        columnTypes: { canonical_place_id: "integer", name: "text" },
      }],
      provider: provider(new ScriptedClient([])),
    }),
    /cursor column must have the text type/,
  );
});

test("rejects broad roles and drifted database-owned contracts", async () => {
  const mismatches: Array<Record<string, unknown>> = [
    { database_session_role: "postgres" },
    { role_inherits: true },
    { role_has_memberships: true },
    { role_connection_limit: -1 },
    { role_connection_limit: 3 },
    { role_superuser: true },
    { role_create_database: true },
    { role_create_role: true },
    { role_replication: true },
    { role_bypass_rls: true },
    { contract_owner_role: "postgres" },
    { contract_owner_can_login: true },
    { contract_owner_inherits: true },
    { contract_owner_has_memberships: true },
    { contract_owner_superuser: true },
    { contract_owner_create_database: true },
    { contract_owner_create_role: true },
    { contract_owner_replication: true },
    { contract_owner_bypass_rls: true },
    { identity_owner_membership: true },
    { relation_kind: "r" },
    { view_security_barrier: false },
    { view_options: ["security_barrier=true", "security_invoker=true"] },
    { relation_owner: "postgres" },
    { view_owner_membership: true },
    { view_definition: `${VIEW_DEFINITION} SELECT 1;` },
    { database_instance_id: "018f4c5e-7a6b-7def-8abc-000000000000" },
    { identity_relation_owner: "postgres" },
    { column_types: JSON.stringify({ canonical_place_id: "text", name: "bigint" }) },
  ];
  for (const identityOverrides of mismatches) {
    const client = new ScriptedClient([], { identityOverrides });
    await assert.rejects(
      () => readerWith(client).read(readOptions()),
      /relation contract identity does not match/,
    );
    assert.equal(client.queries.some(({ sql }) => sql.includes("WITH page AS")), false);
  }
});

test("rejects cursor bytes that bypass a faulty transport provider", async () => {
  const oversizedCursor = "x".repeat(257);
  const client = new ScriptedClient([], {
    dataStep: [encodeRow({ canonical_place_id: oversizedCursor, name: "Alpha" })],
  });
  await assert.rejects(
    () => readerWith(client).read(readOptions()),
    /cursor must be a unique, strictly increasing, non-empty string/,
  );
});

test("rejects values that do not match their attested PostgreSQL output types", async () => {
  const client = new ScriptedClient([], {
    dataStep: [encodeRow({ canonical_place_id: "1", name: false })],
  });
  await assert.rejects(
    () => readerWith(client).read(readOptions()),
    /name does not match its attested PostgreSQL type/,
  );
});

test("rejects null values for contractually non-null output columns", async () => {
  const client = new ScriptedClient([], {
    dataStep: [encodeRow({ canonical_place_id: "1", name: null })],
  });
  const strictName = {
    ...resource,
    columnNullability: { canonical_place_id: false, name: false },
  };
  await assert.rejects(
    () => readerWithResource(client, strictName).read(readOptions()),
    /name violates its non-null contract/,
  );
});
