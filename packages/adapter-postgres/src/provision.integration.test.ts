import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { digest, type CanonicalJson } from "@map-pipeline/core";
import { Pool } from "pg";

import {
  computePostgresViewDefinitionDigest,
  PostgresSnapshotResourceReader,
  type PostgresSnapshotResource,
} from "./index.js";

const adminConnectionString = process.env.MAP_PIPELINE_TEST_POSTGRES_PROVISION_URL;
const contractPath = fileURLToPath(new URL(
  "../../../profiles/apizzamichigan/contracts/canonical-match-v1.json",
  import.meta.url,
));
const provisioningPath = fileURLToPath(new URL(
  "../../../profiles/apizzamichigan/contracts/provision-canonical-match-v1.sql",
  import.meta.url,
));
const databaseInstanceId = "018f4c5e-7a6b-7def-8abc-abcdef123456";
const readerRole = "map_pipeline_apizza_shadow_reader";
const ownerRole = "map_pipeline_contract_owner";

interface ContractDocument {
  name: string;
  version: number;
  resourceUri: string;
  operation: "snapshot";
  partition: string;
  databaseName: string;
  databaseRole: string;
  databaseContractOwner: string;
  databaseIdentityRelation: { schema: string; name: string };
  relation: { schema: string; name: string; kind: "view" };
  snapshotSchema: { name: string; version: number };
  cursor: {
    columns: string[];
    schema: { name: string; version: number };
  };
  columns: Array<{
    name: string;
    type: "text" | "double precision" | "boolean" | "integer";
    nullable: boolean;
  }>;
}

function runProvisioning(input: {
  connectionString: string;
  sql: string;
  contractDigest: string;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const contractComment = [
      "map-pipeline-contract",
      `apizza-canonical-match@1`,
      input.contractDigest,
    ].join(":");
    const psqlContainer = process.env.MAP_PIPELINE_TEST_PSQL_CONTAINER;
    const psqlConnection = new URL(input.connectionString);
    if (psqlContainer) {
      psqlConnection.hostname = "127.0.0.1";
      psqlConnection.port = "5432";
    }
    const command = psqlContainer ? "docker" : "psql";
    const commandPrefix = psqlContainer
      ? ["exec", "-i", psqlContainer, "psql"]
      : [];
    const child = spawn(command, [...commandPrefix,
      "-X",
      psqlConnection.toString(),
      "-v",
      `database_instance_id=${databaseInstanceId}`,
      "-v",
      `contract_digest=${input.contractDigest}`,
      "-v",
      `contract_comment=${contractComment}`,
    ], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 8_192) stderr += chunk;
    });
    child.once("error", () => reject(new Error("Could not execute the psql provisioning client")));
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(
        `psql provisioning failed with exit code ${code ?? "unknown"}: ${stderr.trim()}`,
      ));
    });
    child.stdin.end(input.sql);
  });
}

function roleConnectionString(base: string): string {
  const url = new URL(base);
  url.username = readerRole;
  url.password = ["ci", "fake", "only"].join("-");
  url.searchParams.set("sslmode", "disable");
  return url.toString();
}

test(
  "the checked-in APizza provisioning template is idempotent and least-privileged",
  {
    skip: adminConnectionString
      ? false
      : "MAP_PIPELINE_TEST_POSTGRES_PROVISION_URL is not set",
  },
  async () => {
    const contractText = await readFile(contractPath, "utf8");
    const contractValue = JSON.parse(contractText) as CanonicalJson;
    const contract = contractValue as unknown as ContractDocument;
    const contractDigest = digest(contractValue);
    const provisioningSql = await readFile(provisioningPath, "utf8");
    const admin = new Pool({ connectionString: adminConnectionString!, max: 1 });
    let staleReader: Pool | undefined;
    try {
      await admin.query(`
        CREATE ROLE map_pipeline_ci_stale_membership NOLOGIN;
        CREATE ROLE map_pipeline_ci_foreign_owner NOLOGIN;
        CREATE ROLE ${ownerRole} NOLOGIN;
        CREATE ROLE ${readerRole} LOGIN;
        CREATE ROLE anon NOLOGIN;
        CREATE ROLE authenticated NOLOGIN;
        CREATE ROLE service_role NOLOGIN;
        GRANT map_pipeline_ci_stale_membership TO ${readerRole};
        GRANT ${readerRole} TO anon;
        GRANT ${ownerRole} TO authenticated;
        CREATE SCHEMA foreign_app AUTHORIZATION map_pipeline_ci_foreign_owner;
        SET ROLE map_pipeline_ci_foreign_owner;
        CREATE TABLE foreign_app.secret_data (id integer PRIMARY KEY);
        CREATE PROCEDURE foreign_app.stale_procedure()
          LANGUAGE sql AS 'INSERT INTO foreign_app.secret_data VALUES (1) ON CONFLICT DO NOTHING';
        GRANT SELECT ON foreign_app.secret_data TO ${readerRole};
        GRANT EXECUTE ON PROCEDURE foreign_app.stale_procedure() TO ${readerRole};
        RESET ROLE;
        CREATE TABLE public.pizza_places (
          id bigint PRIMARY KEY,
          name text,
          address text,
          state text,
          google_place_id text,
          website_url text,
          phone text,
          lat numeric,
          lng numeric,
          lifecycle_status text
        );
        INSERT INTO public.pizza_places
          (id, name, address, state, google_place_id, website_url, phone, lat, lng,
            lifecycle_status)
        VALUES
          (1, 'Historical Pizza', '1 Main St', 'MI', NULL, NULL, NULL, 42.1, -83.1,
            'closed'),
          (2, 'No Coordinates', '2 Main St', 'MI', NULL, NULL, NULL, NULL, NULL, NULL);
        GRANT ALL PRIVILEGES ON public.pizza_places TO ${readerRole};
      `);

      staleReader = new Pool({
        connectionString: roleConnectionString(adminConnectionString!),
        max: 1,
      });
      staleReader.on("error", () => {
        // Expected when provisioning terminates the pre-existing idle session.
      });
      await staleReader.query("SELECT pg_backend_pid()");

      await runProvisioning({
        connectionString: adminConnectionString!,
        sql: provisioningSql,
        contractDigest,
      });
      await assert.rejects(() => staleReader!.query("SELECT 1"));
      await staleReader.end();
      staleReader = undefined;

      await admin.query(`
        GRANT USAGE ON SCHEMA pipeline_control, pipeline_input
          TO anon, authenticated, service_role;
        GRANT SELECT ON pipeline_control.database_identity,
          pipeline_input.apizza_canonical_match_v1
          TO anon, authenticated, service_role;
        GRANT ALL PRIVILEGES ON pipeline_input.apizza_canonical_match_v1 TO ${readerRole};
      `);

      await runProvisioning({
        connectionString: adminConnectionString!,
        sql: provisioningSql,
        contractDigest,
      });

      await admin.query("BEGIN");
      await admin.query("SET LOCAL search_path = pg_catalog, pg_temp");
      const viewDefinitionResult = await admin.query<{ view_definition: string }>(
        "SELECT pg_get_viewdef('pipeline_input.apizza_canonical_match_v1'::regclass, true) AS view_definition",
      );
      await admin.query("ROLLBACK");
      const viewDefinition = viewDefinitionResult.rows[0]!.view_definition;
      const contractComment = [
        "map-pipeline-contract",
        `${contract.name}@${contract.version}`,
        contractDigest,
      ].join(":");
      const posture = await admin.query<Record<string, unknown>>(`
        SELECT
          (SELECT count(*) = 0
            FROM pg_auth_members AS membership
            JOIN pg_roles AS member ON member.oid = membership.member
            JOIN pg_roles AS granted ON granted.oid = membership.roleid
            WHERE member.rolname IN ('${readerRole}', '${ownerRole}')
              OR granted.rolname IN ('${readerRole}', '${ownerRole}')) AS memberships_clear,
          has_table_privilege('${readerRole}', 'pipeline_input.apizza_canonical_match_v1',
            'SELECT') AS reader_view_select,
          has_table_privilege('${readerRole}', 'pipeline_control.database_identity',
            'SELECT') AS reader_identity_select,
          has_table_privilege('${readerRole}', 'public.pizza_places', 'SELECT')
            AS reader_base_select,
          has_table_privilege('${readerRole}', 'foreign_app.secret_data', 'SELECT')
            AS reader_foreign_select,
          NOT EXISTS (
            SELECT 1 FROM information_schema.routine_privileges
            WHERE grantee = '${readerRole}' AND specific_schema = 'foreign_app'
          ) AS reader_foreign_routines_clear,
          has_table_privilege('${readerRole}', 'pipeline_input.apizza_canonical_match_v1',
            'INSERT,UPDATE,DELETE') AS reader_view_write,
          has_schema_privilege('anon', 'pipeline_input', 'USAGE') AS anon_schema_usage,
          has_table_privilege('authenticated', 'pipeline_input.apizza_canonical_match_v1',
            'SELECT') AS authenticated_view_select,
          has_table_privilege('service_role', 'pipeline_control.database_identity',
            'SELECT') AS service_identity_select,
          pg_get_userbyid(view.relowner) = '${ownerRole}' AS view_owner_ok,
          pg_get_userbyid(identity.relowner) = '${ownerRole}' AS identity_owner_ok,
          obj_description(view.oid, 'pg_class') = '${contractComment}' AS comment_ok,
          NOT (SELECT rolcanlogin FROM pg_roles WHERE rolname = '${readerRole}')
            AS reader_login_disabled
        FROM pg_class AS view
        JOIN pg_class AS identity
          ON identity.oid = 'pipeline_control.database_identity'::regclass
        WHERE view.oid = 'pipeline_input.apizza_canonical_match_v1'::regclass
      `);
      assert.deepEqual(posture.rows, [{
        memberships_clear: true,
        reader_view_select: true,
        reader_identity_select: true,
        reader_base_select: false,
        reader_foreign_select: false,
        reader_foreign_routines_clear: true,
        reader_view_write: false,
        anon_schema_usage: false,
        authenticated_view_select: false,
        service_identity_select: false,
        view_owner_ok: true,
        identity_owner_ok: true,
        comment_ok: true,
        reader_login_disabled: true,
      }]);

      assert.equal(contract.databaseName, "pizza_enrichment");
      assert.equal(contract.databaseRole, readerRole);
      assert.equal(contract.databaseContractOwner, ownerRole);
      assert.equal(contract.relation.kind, "view");
      await admin.query(`ALTER ROLE ${readerRole} LOGIN`);
      const columnTypes = Object.fromEntries(
        contract.columns.map(({ name, type }) => [name, type]),
      ) as PostgresSnapshotResource["columnTypes"];
      const columnNullability = Object.fromEntries(
        contract.columns.map(({ name, nullable }) => [name, nullable]),
      );
      const resource: PostgresSnapshotResource = {
        resourceUri: contract.resourceUri,
        operation: contract.operation,
        partitions: [contract.partition],
        databaseName: contract.databaseName,
        databaseRole: contract.databaseRole,
        databaseContractOwner: contract.databaseContractOwner,
        databaseInstanceId,
        databaseIdentityRelation: contract.databaseIdentityRelation,
        schema: contract.snapshotSchema,
        contract: {
          name: contract.name,
          version: contract.version,
          digest: contractDigest,
          viewDefinitionDigest: computePostgresViewDefinitionDigest(viewDefinition),
          cursorSchema: contract.cursor.schema,
        },
        relation: contract.relation,
        columns: contract.columns.map(({ name }) => name),
        columnTypes,
        columnNullability,
        orderBy: contract.cursor.columns,
        pageSize: 1,
      };
      const reader = new PostgresSnapshotResourceReader({
        resources: [resource],
        connectionString: roleConnectionString(adminConnectionString!),
      });
      try {
        const result = await reader.read({
          resourceUri: resource.resourceUri,
          operation: resource.operation,
          partition: contract.partition,
          maxRecords: 10,
          maxBytes: 64 * 1024,
          timeoutMs: 10_000,
          signal: new AbortController().signal,
        });
        assert.deepEqual(result.value, {
          version: 1,
          rows: [{
            canonical_place_id: "1",
            name: "Historical Pizza",
            address: "1 Main St",
            state: "MI",
            google_place_id: null,
            website_url: null,
            phone: null,
            lat: 42.1,
            lng: -83.1,
          }],
        });
        assert.equal(result.snapshot.contractDigest, contractDigest);
      } finally {
        await reader.close();
      }
    } finally {
      await staleReader?.end();
      await admin.end();
    }
  },
);
