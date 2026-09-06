import { Pool, type PoolClient } from "pg";

import {
  canonicalize,
  digest,
  type CanonicalJson,
  type ResourceReadResult,
  type ResourceReader,
  type SchemaRef,
  type StagePluginManifest,
} from "@map-pipeline/core";
import { definePlugin, type StagePlugin } from "@map-pipeline/sdk";

export const POSTGRES_READONLY_ADAPTER = "postgres-readonly" as const;

const MAX_ROW_LIMIT = 1_000_000;
const MAX_BYTE_LIMIT = 1_073_741_824;
const MAX_CURSOR_BYTES = 256;
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

export interface PostgresSnapshotResource {
  /** Logical policy URI only. Never put a host, database name, or credentials here. */
  resourceUri: string;
  operation: "snapshot";
  partitions: readonly string[];
  databaseName: string;
  databaseRole: string;
  /** Exact non-login role that owns the locked identity table and source view. */
  databaseContractOwner: string;
  /** Stable non-secret ID read from a locked, DB-owned singleton relation. */
  databaseInstanceId: string;
  databaseIdentityRelation: {
    schema: string;
    name: string;
  };
  schema: SchemaRef;
  contract: {
    name: string;
    version: number;
    digest: string;
    /** digest({ viewDefinition: pg_get_viewdef(relation, true) }) */
    viewDefinitionDigest: string;
    cursorSchema: SchemaRef;
  };
  relation: {
    schema: string;
    name: string;
  };
  columns: readonly string[];
  /** Exact view output types; unsafe int8/numeric/date values must be cast by the view. */
  columnTypes: Readonly<Record<string, "text" | "double precision" | "boolean" | "integer">>;
  /** Exact nullability contract enforced again on every decoded row. */
  columnNullability: Readonly<Record<string, boolean>>;
  /** Columns that form the deterministic, unique total order of the result. */
  orderBy: readonly string[];
  pageSize?: number;
  maxRowBytes?: number;
}

export interface PostgresReadClient {
  query(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>> }>;
  release(destroy?: boolean): void;
}

export interface PostgresClientProvider {
  connect(signal: AbortSignal): Promise<PostgresReadClient>;
  close(): Promise<void>;
}

export interface PostgresSnapshotReaderOptions {
  resources: readonly PostgresSnapshotResource[];
  /** A secret DSN supplied by the trusted host, never by a plugin or pipeline definition. */
  connectionString?: string;
  /** Test/custom provider. Exactly one of provider and connectionString is required. */
  provider?: PostgresClientProvider;
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
  idleTransactionTimeoutMs?: number;
  connectionTimeoutMs?: number;
  /** Receives only a normalized message/SQLSTATE for idle pool failures. */
  onBackgroundError?: (error: PostgresSnapshotReadError) => void;
}

export class PostgresSnapshotReadError extends Error {
  override readonly name = "PostgresSnapshotReadError";
}

export function computePostgresSourceInstanceDigest(databaseInstanceId: string): string {
  return digest({ databaseInstanceId });
}

export function computePostgresViewDefinitionDigest(viewDefinition: string): string {
  return digest({ viewDefinition });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new PostgresSnapshotReadError("Postgres snapshot read was aborted");
}

function assertCanonicalJson(value: unknown, path: string): asserts value is CanonicalJson {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) return;
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertCanonicalJson(child, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new PostgresSnapshotReadError(`${path} is not canonical JSON`);
    }
    for (const [key, child] of Object.entries(value)) {
      assertCanonicalJson(child, `${path}.${key}`);
    }
    return;
  }
  throw new PostgresSnapshotReadError(`${path} is not canonical JSON`);
}

function assertColumnValue(
  value: unknown,
  type: PostgresSnapshotResource["columnTypes"][string],
  nullable: boolean,
  path: string,
): asserts value is CanonicalJson {
  if (value === null) {
    if (nullable) return;
    throw new PostgresSnapshotReadError(`${path} violates its non-null contract`);
  }
  const valid = type === "text"
    ? typeof value === "string"
    : type === "boolean"
    ? typeof value === "boolean"
    : type === "integer"
    ? typeof value === "number" && Number.isSafeInteger(value)
    : typeof value === "number" && Number.isFinite(value);
  if (!valid) {
    throw new PostgresSnapshotReadError(`${path} does not match its attested PostgreSQL type`);
  }
  assertCanonicalJson(value, path);
}

function assertIdentifier(value: string, label: string): void {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a lowercase PostgreSQL identifier`);
  }
}

function quoteIdentifier(value: string): string {
  assertIdentifier(value, "PostgreSQL identifier");
  return `"${value}"`;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function assertCanonicalResourceUri(resourceUri: string): void {
  let resource: URL;
  try {
    resource = new URL(resourceUri);
  } catch {
    throw new TypeError("Postgres snapshot resource URI is invalid");
  }
  if (
    resource.protocol !== "postgres-view:" ||
    resource.username ||
    resource.password ||
    resource.port ||
    resource.search ||
    resource.hash ||
    resource.toString() !== resourceUri
  ) {
    throw new TypeError("Postgres snapshot resource URI must be a canonical postgres-view:// URI");
  }
}

function validateConnectionString(connectionString: string): void {
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new TypeError("Postgres connection string must be a URL");
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    !parsed.username ||
    !parsed.password ||
    parsed.pathname.length < 2
  ) {
    throw new TypeError(
      "Postgres connection string must identify a database with dedicated username and password",
    );
  }
  const loopback = parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]";
  const queryEntries = [...parsed.searchParams.entries()];
  const allowedSslMode = loopback ? [undefined, "disable"] : ["verify-full"];
  if (
    queryEntries.some(([key]) => key !== "sslmode") ||
    parsed.searchParams.getAll("sslmode").length > 1 ||
    !allowedSslMode.includes(parsed.searchParams.get("sslmode") ?? undefined)
  ) {
    throw new TypeError(
      loopback
        ? "Loopback Postgres connection strings permit only one optional sslmode=disable parameter"
        : "Remote Postgres connection strings must use only one sslmode=verify-full parameter",
    );
  }
}

function timeout(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > 300_000) {
    throw new TypeError(`${label} must be an integer from 1 through 300000 milliseconds`);
  }
  return resolved;
}

function safeDatabaseFailure(error: unknown): PostgresSnapshotReadError {
  const code = error && typeof error === "object" && "code" in error &&
    typeof error.code === "string" && /^[A-Z0-9]{5}$/.test(error.code)
    ? ` (SQLSTATE ${error.code})`
    : "";
  return new PostgresSnapshotReadError(`Postgres snapshot read failed${code}`);
}

class NodePostgresClientProvider implements PostgresClientProvider {
  readonly #pool: Pool;
  readonly #onBackgroundError: ((error: PostgresSnapshotReadError) => void) | undefined;
  #closePromise: Promise<void> | null = null;

  constructor(
    connectionString: string,
    connectionTimeoutMs: number,
    onBackgroundError?: (error: PostgresSnapshotReadError) => void,
  ) {
    validateConnectionString(connectionString);
    this.#onBackgroundError = onBackgroundError;
    this.#pool = new Pool({
      connectionString,
      application_name: "map-pipeline-postgres-reader",
      max: 1,
      connectionTimeoutMillis: connectionTimeoutMs,
      idleTimeoutMillis: 10_000,
      allowExitOnIdle: true,
    });
    this.#pool.on("error", (error) => {
      this.#reportBackgroundError(error);
    });
  }

  #reportBackgroundError(error: unknown): void {
    try {
      this.#onBackgroundError?.(safeDatabaseFailure(error));
    } catch {
      // Observability hooks cannot be allowed to crash or alter reader control flow.
    }
  }

  #wrapCheckedOutClient(client: PoolClient): PostgresReadClient {
    let released = false;
    const checkedOutErrorListener = (error: Error) => {
      this.#reportBackgroundError(error);
    };
    client.on("error", checkedOutErrorListener);
    return {
      async query(sql, values) {
        const result = await client.query(sql, values);
        return { rows: result.rows as Array<Record<string, unknown>> };
      },
      release(destroy = false) {
        if (released) return;
        released = true;
        client.removeListener("error", checkedOutErrorListener);
        client.release(destroy);
      },
    };
  }

  async connect(signal: AbortSignal): Promise<PostgresReadClient> {
    if (signal.aborted) throw abortReason(signal);
    const pending = new Promise<PostgresReadClient>((resolve, reject) => {
      this.#pool.connect((error, client) => {
        if (error || !client) {
          reject(error ?? new Error("Postgres pool returned no client"));
          return;
        }
        // This callback runs inside ReadyForQuery handling. Attach the lease
        // listener before resolving so a later frame parsed in the same turn
        // cannot hit an unobserved checked-out-client window.
        resolve(this.#wrapCheckedOutClient(client));
      });
    });
    let abortListener: (() => void) | undefined;
    const aborted = new Promise<{ kind: "aborted" }>((resolve) => {
      abortListener = () => resolve({ kind: "aborted" });
      signal.addEventListener("abort", abortListener, { once: true });
    });
    try {
      const outcome = await Promise.race([
        pending.then(
          (client) => ({ kind: "connected" as const, client }),
          (error: unknown) => ({ kind: "failed" as const, error }),
        ),
        aborted,
      ]);
      if (outcome.kind === "aborted") {
        // node-postgres cannot cancel Pool.connect(). Own the pending operation until
        // it settles, then destroy any late lease before surfacing the abort.
        const lateLease = await pending.then((lease) => lease, () => null);
        lateLease?.release(true);
        throw abortReason(signal);
      }
      if (outcome.kind === "failed") throw outcome.error;
      const client = outcome.client;
      if (signal.aborted) {
        client.release(true);
        throw abortReason(signal);
      }
      return client;
    } finally {
      if (abortListener) signal.removeEventListener("abort", abortListener);
    }
  }

  async close(): Promise<void> {
    this.#closePromise ??= this.#pool.end();
    await this.#closePromise;
  }
}

interface ValidatedResource extends PostgresSnapshotResource {
  columns: readonly string[];
  orderBy: readonly string[];
  pageSize: number;
  maxRowBytes: number;
  firstPageQuery: string;
  nextPageQuery: string;
  uniquenessQuery: string;
  bindingDigest: string;
}

function validateResource(resource: PostgresSnapshotResource): ValidatedResource {
  assertCanonicalResourceUri(resource.resourceUri);
  if (resource.operation !== "snapshot") {
    throw new TypeError("Postgres snapshot resources support only the snapshot operation");
  }
  if (!resource.partitions.length || new Set(resource.partitions).size !== resource.partitions.length) {
    throw new TypeError("Postgres snapshot partitions must be non-empty and unique");
  }
  if (resource.partitions.some((partition) => !partition || partition.trim() !== partition)) {
    throw new TypeError("Postgres snapshot partitions must be non-empty trimmed text");
  }
  assertIdentifier(resource.databaseName, "Postgres database name");
  assertIdentifier(resource.databaseRole, "Postgres database role");
  assertIdentifier(resource.databaseContractOwner, "Postgres contract owner role");
  assertIdentifier(resource.databaseIdentityRelation.schema, "Postgres identity schema");
  assertIdentifier(resource.databaseIdentityRelation.name, "Postgres identity relation");
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
    resource.databaseInstanceId,
  )) {
    throw new TypeError("Postgres database instance ID must be a lowercase UUID");
  }
  if (!resource.schema.name || !Number.isSafeInteger(resource.schema.version) || resource.schema.version < 1) {
    throw new TypeError("Postgres snapshot resource schema is invalid");
  }
  if (
    !resource.contract.name ||
    !Number.isSafeInteger(resource.contract.version) ||
    resource.contract.version < 1 ||
    !/^sha256:[a-f0-9]{64}$/.test(resource.contract.digest) ||
    !/^sha256:[a-f0-9]{64}$/.test(resource.contract.viewDefinitionDigest) ||
    !resource.contract.cursorSchema.name ||
    !Number.isSafeInteger(resource.contract.cursorSchema.version) ||
    resource.contract.cursorSchema.version < 1
  ) {
    throw new TypeError("Postgres snapshot resource contract is invalid");
  }
  assertIdentifier(resource.relation.schema, "Postgres relation schema");
  assertIdentifier(resource.relation.name, "Postgres relation name");
  if (!resource.columns.length || new Set(resource.columns).size !== resource.columns.length) {
    throw new TypeError("Postgres snapshot columns must be non-empty and unique");
  }
  if (resource.orderBy.length !== 1) {
    throw new TypeError("Postgres snapshot v1 requires one unique text cursor column");
  }
  for (const column of resource.columns) assertIdentifier(column, "Postgres snapshot column");
  const typeKeys = Object.keys(resource.columnTypes).sort();
  const nullabilityKeys = Object.keys(resource.columnNullability).sort();
  const sortedColumns = [...resource.columns].sort();
  if (
    typeKeys.length !== resource.columns.length ||
    typeKeys.some((key, index) => key !== sortedColumns[index]) ||
    Object.values(resource.columnTypes).some(
      (type) => !["text", "double precision", "boolean", "integer"].includes(type),
    )
  ) {
    throw new TypeError("Postgres snapshot column types must exactly cover safe selected columns");
  }
  if (
    nullabilityKeys.length !== resource.columns.length ||
    nullabilityKeys.some((key, index) => key !== sortedColumns[index]) ||
    Object.values(resource.columnNullability).some((nullable) => typeof nullable !== "boolean")
  ) {
    throw new TypeError("Postgres snapshot nullability must exactly cover selected columns");
  }
  for (const column of resource.orderBy) {
    assertIdentifier(column, "Postgres snapshot order column");
    if (!resource.columns.includes(column)) {
      throw new TypeError("Every Postgres snapshot order column must be selected");
    }
  }
  if (resource.columnTypes[resource.orderBy[0]!] !== "text") {
    throw new TypeError("Postgres snapshot cursor column must have the text type");
  }
  if (resource.columnNullability[resource.orderBy[0]!] !== false) {
    throw new TypeError("Postgres snapshot cursor column must be non-nullable");
  }
  const pageSize = resource.pageSize ?? 500;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 5_000) {
    throw new TypeError("Postgres snapshot page size must be an integer from 1 through 5000");
  }
  const maxRowBytes = resource.maxRowBytes ?? 65_536;
  if (!Number.isSafeInteger(maxRowBytes) || maxRowBytes < 1 || maxRowBytes > 1_048_576) {
    throw new TypeError("Postgres snapshot row byte limit must be an integer from 1 through 1048576");
  }
  const cursor = quoteIdentifier(resource.orderBy[0]!);
  const selectedColumns = resource.columns.map(quoteIdentifier).join(", ");
  const payloadExpression = `jsonb_build_object(${resource.columns.flatMap((column) => [
    `'${column}'`,
    quoteIdentifier(column),
  ]).join(", ")})::text`;
  const rawTextBytes = resource.columns
    .filter((column) => resource.columnTypes[column] === "text")
    .map((column) => `coalesce(octet_length(${quoteIdentifier(column)}), 0)`)
    .join(" + ") || "0";
  const encodedSelect = (maxRowParameter: string) => [
    "encoded AS (",
    `  SELECT ${cursor} AS __pipeline_cursor,`,
    `    CASE WHEN (${rawTextBytes}) <= ${maxRowParameter}`,
    `      THEN ${payloadExpression} ELSE NULL END AS __pipeline_payload`,
    "  FROM page",
    ")",
    ", sized AS (",
    "  SELECT __pipeline_cursor, __pipeline_payload,",
    `    coalesce(octet_length(__pipeline_payload), ${maxRowParameter} + 1)`,
    "      AS __pipeline_payload_bytes,",
    `    sum(coalesce(octet_length(__pipeline_payload), ${maxRowParameter} + 1) + 1) OVER (`,
    "      ORDER BY __pipeline_cursor COLLATE \"C\" ROWS UNBOUNDED PRECEDING",
    "    ) AS __pipeline_cumulative_bytes",
    "  FROM encoded",
    ")",
    `SELECT CASE WHEN octet_length(__pipeline_cursor) <= ${MAX_CURSOR_BYTES}`,
    "    THEN __pipeline_cursor ELSE NULL END AS __pipeline_cursor,",
    "  __pipeline_payload_bytes,",
  ];
  const firstPageQuery = [
    "WITH page AS (",
    `  SELECT ${selectedColumns}`,
    `  FROM ${quoteIdentifier(resource.relation.schema)}.${quoteIdentifier(resource.relation.name)}`,
    `  ORDER BY ${cursor} COLLATE "C"`,
    "  LIMIT $1",
    "),",
    ...encodedSelect("$3"),
    "  CASE WHEN __pipeline_cumulative_bytes <= $2 AND __pipeline_payload_bytes <= $3",
    "    THEN __pipeline_payload ELSE NULL END AS __pipeline_payload",
    "FROM sized",
    "ORDER BY __pipeline_cursor COLLATE \"C\"",
  ].join("\n");
  const nextPageQuery = [
    "WITH page AS (",
    `  SELECT ${selectedColumns}`,
    `  FROM ${quoteIdentifier(resource.relation.schema)}.${quoteIdentifier(resource.relation.name)}`,
    `  WHERE ${cursor} COLLATE "C" > $1 COLLATE "C"`,
    `  ORDER BY ${cursor} COLLATE "C"`,
    "  LIMIT $2",
    "),",
    ...encodedSelect("$4"),
    "  CASE WHEN __pipeline_cumulative_bytes <= $3 AND __pipeline_payload_bytes <= $4",
    "    THEN __pipeline_payload ELSE NULL END AS __pipeline_payload",
    "FROM sized",
    "ORDER BY __pipeline_cursor COLLATE \"C\"",
  ].join("\n");
  const uniquenessQuery = [
    "SELECT EXISTS (",
    "  SELECT 1",
    `  FROM ${quoteIdentifier(resource.relation.schema)}.${quoteIdentifier(resource.relation.name)}`,
    `  GROUP BY ${cursor}`,
    `  HAVING ${cursor} IS NULL OR ${cursor} = ''`,
    `    OR octet_length(${cursor}) > ${MAX_CURSOR_BYTES}`,
    "    OR count(*) > 1",
    "  LIMIT 1",
    ") AS __pipeline_has_invalid_cursor",
  ].join("\n");
  const bindingDigest = digest({
    adapter: POSTGRES_READONLY_ADAPTER,
    queryVersion: 4,
    resourceUri: resource.resourceUri,
    operation: resource.operation,
    partitions: [...resource.partitions],
    databaseName: resource.databaseName,
    databaseRole: resource.databaseRole,
    databaseContractOwner: resource.databaseContractOwner,
    sourceInstanceDigest: computePostgresSourceInstanceDigest(resource.databaseInstanceId),
    databaseIdentityRelation: {
      schema: resource.databaseIdentityRelation.schema,
      name: resource.databaseIdentityRelation.name,
    },
    schema: { name: resource.schema.name, version: resource.schema.version },
    contract: {
      name: resource.contract.name,
      version: resource.contract.version,
      digest: resource.contract.digest,
      viewDefinitionDigest: resource.contract.viewDefinitionDigest,
      cursorSchema: {
        name: resource.contract.cursorSchema.name,
        version: resource.contract.cursorSchema.version,
      },
    },
    relation: { schema: resource.relation.schema, name: resource.relation.name },
    columns: [...resource.columns],
    columnTypes: Object.fromEntries(
      [...resource.columns].sort().map((column) => [column, resource.columnTypes[column]!]),
    ),
    columnNullability: Object.fromEntries(
      [...resource.columns].sort().map((column) => [column, resource.columnNullability[column]!]),
    ),
    orderBy: [...resource.orderBy],
    pageSize,
    maxRowBytes,
  });
  return Object.freeze({
    ...structuredClone(resource),
    columns: Object.freeze([...resource.columns]),
    orderBy: Object.freeze([...resource.orderBy]),
    pageSize,
    maxRowBytes,
    firstPageQuery,
    nextPageQuery,
    uniquenessQuery,
    bindingDigest,
  });
}

export class PostgresSnapshotResourceReader implements ResourceReader {
  readonly #provider: PostgresClientProvider;
  readonly #ownsProvider: boolean;
  readonly #resources: ReadonlyMap<string, ValidatedResource>;
  readonly #statementTimeoutMs: number;
  readonly #lockTimeoutMs: number;
  readonly #idleTransactionTimeoutMs: number;
  #closePromise: Promise<void> | null = null;

  constructor(options: PostgresSnapshotReaderOptions) {
    if (Boolean(options.provider) === Boolean(options.connectionString)) {
      throw new TypeError("Exactly one of provider and connectionString is required");
    }
    const connectionTimeoutMs = timeout(
      options.connectionTimeoutMs,
      10_000,
      "Postgres connection timeout",
    );
    this.#statementTimeoutMs = timeout(
      options.statementTimeoutMs,
      30_000,
      "Postgres statement timeout",
    );
    this.#lockTimeoutMs = timeout(options.lockTimeoutMs, 2_000, "Postgres lock timeout");
    this.#idleTransactionTimeoutMs = timeout(
      options.idleTransactionTimeoutMs,
      30_000,
      "Postgres idle transaction timeout",
    );
    this.#provider = options.provider ?? new NodePostgresClientProvider(
      options.connectionString!,
      connectionTimeoutMs,
      options.onBackgroundError,
    );
    this.#ownsProvider = !options.provider;
    const resources = options.resources.map(validateResource);
    if (!resources.length || new Set(resources.map(({ resourceUri }) => resourceUri)).size !== resources.length) {
      throw new TypeError("Postgres snapshot resource URIs must be non-empty and unique");
    }
    this.#resources = new Map(resources.map((resource) => [resource.resourceUri, resource]));
  }

  async read(input: {
    resourceUri: string;
    operation: string;
    partition: string;
    maxRecords: number;
    maxBytes: number;
    timeoutMs: number;
    signal: AbortSignal;
  }): Promise<ResourceReadResult> {
    const resource = this.#resources.get(input.resourceUri);
    if (!resource || input.operation !== resource.operation) {
      throw new PostgresSnapshotReadError("Postgres snapshot resource or operation is not registered");
    }
    if (!resource.partitions.includes(input.partition)) {
      throw new PostgresSnapshotReadError("Postgres snapshot partition is not registered");
    }
    if (
      !Number.isSafeInteger(input.maxRecords) ||
      input.maxRecords < 0 ||
      input.maxRecords > MAX_ROW_LIMIT
    ) {
      throw new TypeError(`Postgres record limit must be between 0 and ${MAX_ROW_LIMIT}`);
    }
    if (
      !Number.isSafeInteger(input.maxBytes) ||
      input.maxBytes < 0 ||
      input.maxBytes > MAX_BYTE_LIMIT
    ) {
      throw new TypeError(
        `Postgres byte limit must be between 0 and ${MAX_BYTE_LIMIT}`,
      );
    }
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1) {
      throw new TypeError("Postgres read timeout must be a positive safe integer");
    }
    if (input.signal.aborted) throw abortReason(input.signal);

    let client: PostgresReadClient | undefined;
    let released = false;
    let transactionOpen = false;
    const release = (destroy: boolean) => {
      if (!client || released) return;
      released = true;
      client.release(destroy);
    };
    const abort = () => release(true);

    try {
      client = await this.#provider.connect(input.signal);
      input.signal.addEventListener("abort", abort, { once: true });
      if (input.signal.aborted) throw abortReason(input.signal);

      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      transactionOpen = true;
      await client.query("SET LOCAL search_path = pg_catalog, pg_temp");
      const cleanupReserveMs = Math.min(1_000, Math.floor(input.timeoutMs / 10));
      const databaseWorkTimeoutMs = Math.max(1, input.timeoutMs - cleanupReserveMs);
      await client.query(
        [
          "SELECT",
          "  set_config('statement_timeout', $1, true) AS statement_timeout,",
          "  set_config('lock_timeout', $2, true) AS lock_timeout,",
          "  set_config('idle_in_transaction_session_timeout', $3, true) AS idle_timeout",
        ].join("\n"),
        [
          `${Math.min(this.#statementTimeoutMs, databaseWorkTimeoutMs)}ms`,
          `${Math.min(this.#lockTimeoutMs, databaseWorkTimeoutMs)}ms`,
          `${Math.min(this.#idleTransactionTimeoutMs, databaseWorkTimeoutMs)}ms`,
        ],
      );
      const settings = await client.query([
        "SELECT",
        "  current_setting('transaction_read_only') AS read_only,",
        "  current_setting('transaction_isolation') AS isolation",
      ].join("\n"));
      const settingsRow = settings.rows[0];
      if (
        settings.rows.length !== 1 ||
        settingsRow?.read_only !== "on" ||
        settingsRow.isolation !== "repeatable read"
      ) {
        throw new PostgresSnapshotReadError("Postgres did not enforce the requested read-only snapshot");
      }
      const identity = await client.query([
        "SELECT",
        "  current_database()::text AS database_name,",
        "  current_user::text AS database_role,",
        "  session_user::text AS database_session_role,",
        "  role.rolcanlogin AS role_can_login,",
        "  role.rolinherit AS role_inherits,",
        "  EXISTS (SELECT 1 FROM pg_auth_members AS membership",
        "    WHERE membership.member = role.oid OR membership.roleid = role.oid)",
        "    AS role_has_memberships,",
        "  role.rolconnlimit AS role_connection_limit,",
        "  role.rolsuper AS role_superuser,",
        "  role.rolcreatedb AS role_create_database,",
        "  role.rolcreaterole AS role_create_role,",
        "  role.rolreplication AS role_replication,",
        "  role.rolbypassrls AS role_bypass_rls,",
        "  contract_owner.rolname::text AS contract_owner_role,",
        "  contract_owner.rolcanlogin AS contract_owner_can_login,",
        "  contract_owner.rolinherit AS contract_owner_inherits,",
        "  EXISTS (SELECT 1 FROM pg_auth_members AS membership",
        "    WHERE membership.member = contract_owner.oid",
        "      OR membership.roleid = contract_owner.oid) AS contract_owner_has_memberships,",
        "  contract_owner.rolsuper AS contract_owner_superuser,",
        "  contract_owner.rolcreatedb AS contract_owner_create_database,",
        "  contract_owner.rolcreaterole AS contract_owner_create_role,",
        "  contract_owner.rolreplication AS contract_owner_replication,",
        "  contract_owner.rolbypassrls AS contract_owner_bypass_rls,",
        `  (SELECT CASE WHEN count(*) = 1 THEN min(database_instance_id::text) ELSE NULL END`,
        `    FROM ${quoteIdentifier(resource.databaseIdentityRelation.schema)}.${quoteIdentifier(resource.databaseIdentityRelation.name)})`,
        "    AS database_instance_id,",
        "  pg_current_snapshot()::text AS snapshot_id,",
        "  to_char(transaction_timestamp() AT TIME ZONE 'UTC',",
        "    'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS captured_at,",
        "  obj_description(to_regclass($1), 'pg_class') AS contract_comment,",
        "  relation.relkind::text AS relation_kind,",
        "  relation.reloptions @> ARRAY['security_barrier=true']::text[]",
        "    AS view_security_barrier,",
        "  coalesce(relation.reloptions, ARRAY[]::text[]) AS view_options,",
        "  pg_get_userbyid(relation.relowner)::text AS relation_owner,",
        "  pg_has_role(current_user, relation.relowner, 'MEMBER') AS view_owner_membership,",
        "  CASE WHEN relation.relkind = 'v'",
        "    THEN pg_get_viewdef(relation.oid, true) ELSE NULL END AS view_definition,",
        "  identity_relation.relkind::text AS identity_relation_kind,",
        "  pg_get_userbyid(identity_relation.relowner)::text AS identity_relation_owner,",
        "  pg_has_role(current_user, identity_relation.relowner, 'MEMBER')",
        "    AS identity_owner_membership,",
        "  (SELECT jsonb_object_agg(attribute.attname,",
        "      format_type(attribute.atttypid, attribute.atttypmod))::text",
        "    FROM pg_attribute AS attribute",
        "    WHERE attribute.attrelid = to_regclass($1)",
        "      AND attribute.attnum > 0 AND NOT attribute.attisdropped) AS column_types",
        "FROM pg_roles AS role",
        "JOIN pg_roles AS contract_owner ON contract_owner.rolname = $3",
        "JOIN pg_class AS relation ON relation.oid = to_regclass($1)",
        "JOIN pg_class AS identity_relation ON identity_relation.oid = to_regclass($2)",
        "WHERE role.rolname = current_user",
      ].join("\n"), [
        `${resource.relation.schema}.${resource.relation.name}`,
        `${resource.databaseIdentityRelation.schema}.${resource.databaseIdentityRelation.name}`,
        resource.databaseContractOwner,
      ]);
      const identityRow = identity.rows[0];
      const expectedContractComment = [
        "map-pipeline-contract",
        `${resource.contract.name}@${resource.contract.version}`,
        resource.contract.digest,
      ].join(":");
      let observedColumnTypes: unknown;
      try {
        observedColumnTypes = typeof identityRow?.column_types === "string"
          ? JSON.parse(identityRow.column_types)
          : null;
      } catch {
        observedColumnTypes = null;
      }
      const observedViewDefinitionDigest = typeof identityRow?.view_definition === "string"
        ? computePostgresViewDefinitionDigest(identityRow.view_definition)
        : null;
      if (
        identity.rows.length !== 1 ||
        identityRow?.database_name !== resource.databaseName ||
        identityRow.database_role !== resource.databaseRole ||
        identityRow.database_session_role !== resource.databaseRole ||
        identityRow.role_can_login !== true ||
        identityRow.role_inherits !== false ||
        identityRow.role_has_memberships !== false ||
        typeof identityRow.role_connection_limit !== "number" ||
        identityRow.role_connection_limit < 1 ||
        identityRow.role_connection_limit > 2 ||
        identityRow.role_superuser !== false ||
        identityRow.role_create_database !== false ||
        identityRow.role_create_role !== false ||
        identityRow.role_replication !== false ||
        identityRow.role_bypass_rls !== false ||
        identityRow.contract_owner_role !== resource.databaseContractOwner ||
        identityRow.contract_owner_can_login !== false ||
        identityRow.contract_owner_inherits !== false ||
        identityRow.contract_owner_has_memberships !== false ||
        identityRow.contract_owner_superuser !== false ||
        identityRow.contract_owner_create_database !== false ||
        identityRow.contract_owner_create_role !== false ||
        identityRow.contract_owner_replication !== false ||
        identityRow.contract_owner_bypass_rls !== false ||
        identityRow.database_instance_id !== resource.databaseInstanceId ||
        typeof identityRow?.snapshot_id !== "string" ||
        !identityRow.snapshot_id ||
        typeof identityRow.captured_at !== "string" ||
        !identityRow.captured_at ||
        identityRow.contract_comment !== expectedContractComment ||
        identityRow.relation_kind !== "v" ||
        identityRow.view_security_barrier !== true ||
        !Array.isArray(identityRow.view_options) ||
        identityRow.view_options.length !== 1 ||
        identityRow.view_options[0] !== "security_barrier=true" ||
        identityRow.relation_owner !== resource.databaseContractOwner ||
        identityRow.view_owner_membership !== false ||
        observedViewDefinitionDigest !== resource.contract.viewDefinitionDigest ||
        identityRow.identity_relation_kind !== "r" ||
        identityRow.identity_relation_owner !== resource.databaseContractOwner ||
        identityRow.identity_owner_membership !== false ||
        !observedColumnTypes ||
        typeof observedColumnTypes !== "object" ||
        Array.isArray(observedColumnTypes) ||
        canonicalize(observedColumnTypes as CanonicalJson) !==
          canonicalize(resource.columnTypes as CanonicalJson)
      ) {
        throw new PostgresSnapshotReadError(
          "Postgres database, role, snapshot, or relation contract identity does not match",
        );
      }
      const uniqueness = await client.query(resource.uniquenessQuery);
      if (
        uniqueness.rows.length !== 1 ||
        uniqueness.rows[0]?.__pipeline_has_invalid_cursor !== false
      ) {
        throw new PostgresSnapshotReadError(
          "Postgres snapshot cursor must be unique, bounded, and non-empty",
        );
      }
      const expectedKeys = [...resource.columns].sort();
      const uniqueKeys = new Set<string>();
      const rows: Array<Record<string, CanonicalJson>> = [];
      const maxObservedRecords = input.maxRecords + 1;
      const emptyDocumentBytes = Buffer.byteLength(
        canonicalize({ version: 1, rows: [] }),
        "utf8",
      );
      let serializedRowBytes = 0;
      let cursorValue: string | null = null;
      while (rows.length < maxObservedRecords) {
        if (input.signal.aborted) throw abortReason(input.signal);
        const pageLimit = Math.min(resource.pageSize, maxObservedRecords - rows.length);
        const remainingBytes = Math.max(
          0,
          input.maxBytes - emptyDocumentBytes - serializedRowBytes - rows.length,
        );
        const transferBudget = remainingBytes + (rows.length === 0 ? 1 : 0);
        const page: { rows: Array<Record<string, unknown>> } = cursorValue === null
          ? await client.query(resource.firstPageQuery, [
            pageLimit,
            transferBudget,
            Math.min(resource.maxRowBytes, transferBudget),
          ])
          : await client.query(resource.nextPageQuery, [
            cursorValue,
            pageLimit,
            transferBudget,
            Math.min(resource.maxRowBytes, transferBudget),
          ]);
        if (page.rows.length > pageLimit) {
          throw new PostgresSnapshotReadError("Postgres returned more rows than the requested page");
        }
        for (const encodedRow of page.rows) {
          const rowIndex = rows.length;
          const transportKeys = Object.keys(encodedRow).sort();
          if (
            transportKeys.length !== 3 ||
            transportKeys[0] !== "__pipeline_cursor" ||
            transportKeys[1] !== "__pipeline_payload" ||
            transportKeys[2] !== "__pipeline_payload_bytes" ||
            typeof encodedRow.__pipeline_cursor !== "string" ||
            typeof encodedRow.__pipeline_payload_bytes !== "number" ||
            !Number.isSafeInteger(encodedRow.__pipeline_payload_bytes) ||
            encodedRow.__pipeline_payload_bytes < 0 ||
            (encodedRow.__pipeline_payload !== null &&
              typeof encodedRow.__pipeline_payload !== "string")
          ) {
            throw new PostgresSnapshotReadError(
              `Postgres transport row ${rowIndex} has an invalid bounded shape`,
            );
          }
          if (
            encodedRow.__pipeline_payload === null ||
            encodedRow.__pipeline_payload_bytes > input.maxBytes
          ) {
            throw new PostgresSnapshotReadError(
              `Postgres snapshot exceeds the authorized ${input.maxBytes}-byte limit`,
            );
          }
          let row: Record<string, unknown>;
          try {
            const parsed = JSON.parse(encodedRow.__pipeline_payload) as unknown;
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
              throw new TypeError("row payload is not an object");
            }
            row = parsed as Record<string, unknown>;
          } catch {
            throw new PostgresSnapshotReadError(`Postgres transport row ${rowIndex} is not JSON`);
          }
          const actualKeys = Object.keys(row).sort();
          if (
            actualKeys.length !== expectedKeys.length ||
            actualKeys.some((key, index) => key !== expectedKeys[index])
          ) {
            throw new PostgresSnapshotReadError(`Postgres row ${rowIndex} has unexpected columns`);
          }
          const canonicalRow: Record<string, CanonicalJson> = {};
          for (const column of resource.columns) {
            const fieldValue = row[column];
            assertColumnValue(
              fieldValue,
              resource.columnTypes[column]!,
              resource.columnNullability[column]!,
              `Postgres row ${rowIndex}.${column}`,
            );
            canonicalRow[column] = fieldValue;
          }
          const nextCursor = canonicalRow[resource.orderBy[0]!];
          if (
            typeof nextCursor !== "string" ||
            !nextCursor ||
            Buffer.byteLength(nextCursor, "utf8") > MAX_CURSOR_BYTES ||
            nextCursor !== encodedRow.__pipeline_cursor ||
            (cursorValue !== null && compareUtf8(nextCursor, cursorValue) <= 0) ||
            uniqueKeys.has(nextCursor)
          ) {
            throw new PostgresSnapshotReadError(
              "Postgres snapshot cursor must be a unique, strictly increasing, non-empty string",
            );
          }
          const rowBytes = Buffer.byteLength(canonicalize(canonicalRow), "utf8");
          const projectedBytes = emptyDocumentBytes + serializedRowBytes + rowBytes + rows.length;
          if (projectedBytes > input.maxBytes) {
            throw new PostgresSnapshotReadError(
              `Postgres snapshot exceeds the authorized ${input.maxBytes}-byte limit`,
            );
          }
          serializedRowBytes += rowBytes;
          uniqueKeys.add(nextCursor);
          cursorValue = nextCursor;
          rows.push(canonicalRow);
          if (rows.length > input.maxRecords) {
            throw new PostgresSnapshotReadError(
              `Postgres snapshot exceeds the authorized ${input.maxRecords}-record limit`,
            );
          }
        }
        if (page.rows.length < pageLimit) break;
      }
      const value = {
        version: 1,
        rows,
      } satisfies CanonicalJson;
      const byteCount = Buffer.byteLength(canonicalize(value), "utf8");
      if (byteCount > input.maxBytes) {
        throw new PostgresSnapshotReadError(
          `Postgres snapshot exceeds the authorized ${input.maxBytes}-byte limit`,
        );
      }
      if (input.signal.aborted) throw abortReason(input.signal);
      await client.query("ROLLBACK");
      transactionOpen = false;
      release(false);
      return {
        value,
        observedChildIds: [],
        schema: { ...resource.schema },
        snapshot: {
          snapshotId: identityRow.snapshot_id,
          sourceInstanceDigest: computePostgresSourceInstanceDigest(resource.databaseInstanceId),
          readerBindingDigest: resource.bindingDigest,
          capturedAt: identityRow.captured_at,
          consistency: "repeatable_read",
          cursorSchema: { ...resource.contract.cursorSchema },
          startExclusive: null,
          endInclusive: rows.length
            ? resource.orderBy.map((column) => rows.at(-1)![column]!)
            : null,
          complete: true,
          contractName: resource.contract.name,
          contractVersion: resource.contract.version,
          contractDigest: resource.contract.digest,
        },
      };
    } catch (error) {
      if (input.signal.aborted) throw abortReason(input.signal);
      if (client && transactionOpen && !released) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // The connection is destroyed below; never mask the original failure.
        }
      }
      if (error instanceof PostgresSnapshotReadError || error instanceof TypeError) throw error;
      throw safeDatabaseFailure(error);
    } finally {
      input.signal.removeEventListener("abort", abort);
      release(true);
    }
  }

  async close(): Promise<void> {
    if (!this.#ownsProvider) return;
    this.#closePromise ??= this.#provider.close();
    await this.#closePromise;
  }
}

export interface PostgresSnapshotSourceConfig {
  resourceUri: string;
  outputPort: string;
}

export function createPostgresSnapshotSourcePlugin(
  manifest: StagePluginManifest,
): StagePlugin<PostgresSnapshotSourceConfig> {
  if (manifest.sourceAdapter !== POSTGRES_READONLY_ADAPTER) {
    throw new TypeError(`Postgres source manifest must use ${POSTGRES_READONLY_ADAPTER}`);
  }
  return definePlugin({
    manifest,
    async run(context, _inputs, config) {
      const acquisition = await context.broker.acquire({
        effectClass: "network.read",
        resourceUri: config.resourceUri,
        operation: "snapshot",
      });
      const stagedArtifact = await context.broker.stageSourceArtifact({
        acquisition,
        outputPort: config.outputPort,
        artifactUri: config.resourceUri,
      });
      const output = await context.broker.finalizeSourceArtifactAndCommitAcquisition({
        acquisition,
        stagedArtifact,
        outputPort: config.outputPort,
      });
      return {
        outputs: { [config.outputPort]: output },
        metrics: { records: output.recordCount },
      };
    },
  });
}
