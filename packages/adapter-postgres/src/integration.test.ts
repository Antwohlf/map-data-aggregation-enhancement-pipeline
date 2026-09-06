import assert from "node:assert/strict";
import test from "node:test";

import { Pool } from "pg";

import {
  computePostgresViewDefinitionDigest,
  PostgresSnapshotResourceReader,
  type PostgresSnapshotResource,
} from "./index.js";

const adminConnectionString = process.env.MAP_PIPELINE_TEST_POSTGRES_ADMIN_URL;
const contractDigest = `sha256:${"a".repeat(64)}`;
const contractComment = `map-pipeline-contract:apizza-canonical-match@1:${contractDigest}`;
const databaseInstanceId = "018f4c5e-7a6b-7def-8abc-1234567890ab";
const readerRole = "map_pipeline_ci_shadow_reader";
const ownerRole = "map_pipeline_ci_contract_owner";

function roleConnectionString(base: string, role: string): string {
  const url = new URL(base);
  url.username = role;
  url.password = ["ci", "fake", "only"].join("-");
  url.searchParams.set("sslmode", "disable");
  return url.toString();
}

function resource(input: {
  databaseRole: string;
  viewDefinition: string;
  databaseInstanceId?: string;
}): PostgresSnapshotResource {
  return {
    resourceUri: "postgres-view://pipeline-input/apizza-canonical-match-v1",
    operation: "snapshot",
    partitions: ["US"],
    databaseName: "pizza_enrichment",
    databaseRole: input.databaseRole,
    databaseContractOwner: ownerRole,
    databaseInstanceId: input.databaseInstanceId ?? databaseInstanceId,
    databaseIdentityRelation: { schema: "pipeline_control", name: "database_identity" },
    schema: { name: "apizza.canonical-match-snapshot", version: 1 },
    contract: {
      name: "apizza-canonical-match",
      version: 1,
      digest: contractDigest,
      viewDefinitionDigest: computePostgresViewDefinitionDigest(input.viewDefinition),
      cursorSchema: { name: "apizza.canonical-place-id-cursor", version: 1 },
    },
    relation: { schema: "pipeline_input", name: "apizza_canonical_match_v1" },
    columns: [
      "canonical_place_id",
      "name",
      "address",
      "state",
      "google_place_id",
      "website_url",
      "phone",
      "lat",
      "lng",
    ],
    columnTypes: {
      canonical_place_id: "text",
      name: "text",
      address: "text",
      state: "text",
      google_place_id: "text",
      website_url: "text",
      phone: "text",
      lat: "double precision",
      lng: "double precision",
    },
    columnNullability: {
      canonical_place_id: false,
      name: true,
      address: true,
      state: true,
      google_place_id: true,
      website_url: true,
      phone: true,
      lat: false,
      lng: false,
    },
    orderBy: ["canonical_place_id"],
    pageSize: 1,
  };
}

test(
  "real PostgreSQL enforces the APizza snapshot, role, bounds, and DDL attestations",
  { skip: adminConnectionString ? false : "MAP_PIPELINE_TEST_POSTGRES_ADMIN_URL is not set" },
  async () => {
    const admin = new Pool({ connectionString: adminConnectionString!, max: 1 });
    try {
      await admin.query(`
        CREATE ROLE ${ownerRole}
          NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
        CREATE ROLE ${readerRole}
          LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
          CONNECTION LIMIT 2;
        CREATE ROLE map_pipeline_ci_broad_reader
          LOGIN NOINHERIT NOSUPERUSER CREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
        ALTER ROLE ${readerRole} SET default_transaction_read_only = on;
        ALTER ROLE ${readerRole} SET search_path = shadow_attacker, pg_catalog;
        CREATE SCHEMA shadow_attacker;
        CREATE FUNCTION shadow_attacker.current_database() RETURNS name
          LANGUAGE sql IMMUTABLE AS 'SELECT ''spoofed''::name';
        GRANT USAGE ON SCHEMA shadow_attacker TO ${readerRole};
        CREATE SCHEMA pipeline_control AUTHORIZATION ${ownerRole};
        CREATE SCHEMA pipeline_input AUTHORIZATION ${ownerRole};
        REVOKE ALL ON SCHEMA pipeline_control, pipeline_input FROM PUBLIC;
        GRANT USAGE ON SCHEMA pipeline_control, pipeline_input
          TO ${readerRole}, map_pipeline_ci_broad_reader;
        SET ROLE ${ownerRole};
        CREATE TABLE pipeline_control.database_identity (
          singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
          database_instance_id uuid NOT NULL UNIQUE
        );
        INSERT INTO pipeline_control.database_identity (database_instance_id)
        VALUES ('${databaseInstanceId}'::uuid);
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
          (1, 'Alpha Pizza', '1 Main St', 'MI', NULL, NULL, NULL, 42.1, -83.1, NULL),
          (2, 'Beta Pizza', '2 Main St', 'MI', 'google-2', 'https://example.invalid',
            '+13135550100', 42.2, -83.2, NULL),
          (3, 'Historical Pizza', '3 Main St', 'MI', NULL, NULL, NULL, 42.3, -83.3,
            'closed'),
          (4, 'No Coordinates', '4 Main St', 'MI', NULL, NULL, NULL, NULL, NULL, NULL);
        GRANT SELECT (id, name, address, state, google_place_id, website_url, phone, lat, lng)
          ON public.pizza_places TO ${ownerRole};
        SET ROLE ${ownerRole};
        CREATE VIEW pipeline_input.apizza_canonical_match_v1
        WITH (security_barrier = true)
        AS
        SELECT
          id::text AS canonical_place_id,
          name::text AS name,
          address::text AS address,
          state::text AS state,
          google_place_id::text AS google_place_id,
          website_url::text AS website_url,
          phone::text AS phone,
          lat::double precision AS lat,
          lng::double precision AS lng
        FROM public.pizza_places
        WHERE lat IS NOT NULL AND lng IS NOT NULL;
        COMMENT ON VIEW pipeline_input.apizza_canonical_match_v1 IS '${contractComment}';
        RESET ROLE;
        GRANT SELECT ON pipeline_control.database_identity
          TO ${readerRole}, map_pipeline_ci_broad_reader;
        GRANT SELECT ON pipeline_input.apizza_canonical_match_v1
          TO ${readerRole}, map_pipeline_ci_broad_reader;
      `);

      await admin.query("BEGIN");
      await admin.query("SET LOCAL search_path = pg_catalog, pg_temp");
      const definitionResult = await admin.query<{ view_definition: string }>(
        "SELECT pg_get_viewdef('pipeline_input.apizza_canonical_match_v1'::regclass, true) AS view_definition",
      );
      await admin.query("ROLLBACK");
      const viewDefinition = definitionResult.rows[0]!.view_definition;
      const configuredResource = resource({ databaseRole: readerRole, viewDefinition });
      const reader = new PostgresSnapshotResourceReader({
        resources: [configuredResource],
        connectionString: roleConnectionString(adminConnectionString!, readerRole),
      });
      try {
        const result = await reader.read({
          resourceUri: configuredResource.resourceUri,
          operation: "snapshot",
          partition: "US",
          maxRecords: 10,
          maxBytes: 64 * 1024,
          timeoutMs: 10_000,
          signal: new AbortController().signal,
        });
        assert.deepEqual(result.value, {
          version: 1,
          rows: [
            {
              canonical_place_id: "1",
              name: "Alpha Pizza",
              address: "1 Main St",
              state: "MI",
              google_place_id: null,
              website_url: null,
              phone: null,
              lat: 42.1,
              lng: -83.1,
            },
            {
              canonical_place_id: "2",
              name: "Beta Pizza",
              address: "2 Main St",
              state: "MI",
              google_place_id: "google-2",
              website_url: "https://example.invalid",
              phone: "+13135550100",
              lat: 42.2,
              lng: -83.2,
            },
            {
              canonical_place_id: "3",
              name: "Historical Pizza",
              address: "3 Main St",
              state: "MI",
              google_place_id: null,
              website_url: null,
              phone: null,
              lat: 42.3,
              lng: -83.3,
            },
          ],
        });
        assert.equal(result.snapshot.consistency, "repeatable_read");
        assert.equal(result.snapshot.complete, true);
        assert.equal(result.snapshot.contractDigest, contractDigest);
      } finally {
        await reader.close();
      }

      const privileges = await admin.query<{
        view_select: boolean;
        identity_select: boolean;
        base_select: boolean;
        view_insert: boolean;
      }>(`
        SELECT
          has_table_privilege('${readerRole}', 'pipeline_input.apizza_canonical_match_v1', 'SELECT')
            AS view_select,
          has_table_privilege('${readerRole}', 'pipeline_control.database_identity', 'SELECT')
            AS identity_select,
          has_table_privilege('${readerRole}', 'public.pizza_places', 'SELECT') AS base_select,
          has_table_privilege('${readerRole}', 'pipeline_input.apizza_canonical_match_v1', 'INSERT')
            AS view_insert
      `);
      assert.deepEqual(privileges.rows, [{
        view_select: true,
        identity_select: true,
        base_select: false,
        view_insert: false,
      }]);

      const broadReader = new PostgresSnapshotResourceReader({
        resources: [resource({ databaseRole: "map_pipeline_ci_broad_reader", viewDefinition })],
        connectionString: roleConnectionString(
          adminConnectionString!,
          "map_pipeline_ci_broad_reader",
        ),
      });
      try {
        await assert.rejects(
          () => broadReader.read({
            resourceUri: configuredResource.resourceUri,
            operation: "snapshot",
            partition: "US",
            maxRecords: 10,
            maxBytes: 64 * 1024,
            timeoutMs: 10_000,
            signal: new AbortController().signal,
          }),
          /relation contract identity does not match/,
        );
      } finally {
        await broadReader.close();
      }

      await admin.query(`
        INSERT INTO public.pizza_places
          (id, name, address, state, google_place_id, website_url, phone, lat, lng)
        VALUES (5, repeat('x', 10000), '5 Main St', 'MI', NULL, NULL, NULL, 42.5, -83.5)
      `);
      const boundedReader = new PostgresSnapshotResourceReader({
        resources: [configuredResource],
        connectionString: roleConnectionString(adminConnectionString!, readerRole),
      });
      try {
        await assert.rejects(
          () => boundedReader.read({
            resourceUri: configuredResource.resourceUri,
            operation: "snapshot",
            partition: "US",
            maxRecords: 10,
            maxBytes: 256,
            timeoutMs: 10_000,
            signal: new AbortController().signal,
          }),
          /exceeds the authorized 256-byte limit/,
        );
      } finally {
        await boundedReader.close();
      }

      await admin.query(`
        SET ROLE ${ownerRole};
        CREATE OR REPLACE VIEW pipeline_input.apizza_canonical_match_v1
        WITH (security_barrier = true)
        AS
        SELECT
          id::text AS canonical_place_id,
          name::text AS name,
          address::text AS address,
          state::text AS state,
          google_place_id::text AS google_place_id,
          website_url::text AS website_url,
          phone::text AS phone,
          lat::double precision AS lat,
          lng::double precision AS lng
        FROM public.pizza_places
        WHERE lat IS NOT NULL AND lng IS NOT NULL AND id > 0;
        RESET ROLE;
      `);
      const driftReader = new PostgresSnapshotResourceReader({
        resources: [configuredResource],
        connectionString: roleConnectionString(adminConnectionString!, readerRole),
      });
      try {
        await assert.rejects(
          () => driftReader.read({
            resourceUri: configuredResource.resourceUri,
            operation: "snapshot",
            partition: "US",
            maxRecords: 10,
            maxBytes: 64 * 1024,
            timeoutMs: 10_000,
            signal: new AbortController().signal,
          }),
          /relation contract identity does not match/,
        );
      } finally {
        await driftReader.close();
      }
    } finally {
      await admin.end();
    }
  },
);
