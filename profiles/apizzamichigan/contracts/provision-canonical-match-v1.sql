-- psql provisioning template for the APizza read-only shadow input.
-- Required psql variables:
--   database_instance_id  stable UUID generated once for this database
--   contract_digest       digest of canonical-match-v1.json
--   contract_comment      map-pipeline-contract:apizza-canonical-match@1:<digest>
--
-- Set the reader password separately with psql's interactive \password command.
-- Never place it in this file, shell history, or the pipeline definition.

\set ON_ERROR_STOP on

BEGIN;

SET LOCAL search_path = pg_catalog, pg_temp;

DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'map_pipeline_contract_owner') THEN
    CREATE ROLE map_pipeline_contract_owner
      NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'map_pipeline_apizza_shadow_reader') THEN
    CREATE ROLE map_pipeline_apizza_shadow_reader
      NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
      CONNECTION LIMIT 2;
  END IF;
END
$role$;

ALTER ROLE map_pipeline_contract_owner
  NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE map_pipeline_apizza_shadow_reader
  NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  CONNECTION LIMIT 2;

DO $reader_sessions$
DECLARE
  reader_pid integer;
BEGIN
  FOR reader_pid IN
    SELECT pid FROM pg_stat_activity
    WHERE usename = 'map_pipeline_apizza_shadow_reader'
      AND pid <> pg_backend_pid()
  LOOP
    IF NOT pg_terminate_backend(reader_pid, 5000) THEN
      RAISE EXCEPTION 'reader session % could not be terminated', reader_pid;
    END IF;
  END LOOP;
END
$reader_sessions$;

DO $memberships$
DECLARE
  member_role text;
  granted_role text;
BEGIN
  FOR member_role, granted_role IN
    SELECT member.rolname, granted.rolname
    FROM pg_auth_members AS membership
    JOIN pg_roles AS member ON member.oid = membership.member
    JOIN pg_roles AS granted ON granted.oid = membership.roleid
    WHERE member.rolname IN ('map_pipeline_contract_owner', 'map_pipeline_apizza_shadow_reader')
      OR granted.rolname IN ('map_pipeline_contract_owner', 'map_pipeline_apizza_shadow_reader')
  LOOP
    EXECUTE format(
      'REVOKE %I FROM %I',
      granted_role,
      member_role
    );
  END LOOP;
END
$memberships$;

DO $reader_ownership$
DECLARE
  reader_oid oid;
BEGIN
  SELECT oid INTO STRICT reader_oid
  FROM pg_roles
  WHERE rolname = 'map_pipeline_apizza_shadow_reader';

  IF EXISTS (
    SELECT 1
    FROM pg_shdepend
    WHERE refclassid = 'pg_authid'::regclass
      AND refobjid = reader_oid
      AND deptype = 'o'
  ) THEN
    RAISE EXCEPTION
      'map_pipeline_apizza_shadow_reader must not own database objects';
  END IF;
END
$reader_ownership$;

-- The ownership guard above makes this a privilege reset, never an object drop.
-- DROP OWNED revokes grants regardless of which object owner issued them.
DROP OWNED BY map_pipeline_apizza_shadow_reader;
ALTER ROLE map_pipeline_apizza_shadow_reader SET default_transaction_read_only = on;
ALTER ROLE map_pipeline_apizza_shadow_reader SET statement_timeout = '30s';
ALTER ROLE map_pipeline_apizza_shadow_reader SET lock_timeout = '2s';
ALTER ROLE map_pipeline_apizza_shadow_reader SET idle_in_transaction_session_timeout = '30s';

DO $database$
BEGIN
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO map_pipeline_apizza_shadow_reader',
    current_database()
  );
END
$database$;

CREATE SCHEMA IF NOT EXISTS pipeline_control AUTHORIZATION map_pipeline_contract_owner;
CREATE SCHEMA IF NOT EXISTS pipeline_input AUTHORIZATION map_pipeline_contract_owner;
REVOKE ALL ON SCHEMA pipeline_control, pipeline_input FROM PUBLIC;
GRANT USAGE ON SCHEMA pipeline_control, pipeline_input
  TO map_pipeline_apizza_shadow_reader;

SET ROLE map_pipeline_contract_owner;

CREATE TABLE IF NOT EXISTS pipeline_control.database_identity (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  database_instance_id uuid NOT NULL UNIQUE
);
INSERT INTO pipeline_control.database_identity (singleton, database_instance_id)
VALUES (true, :'database_instance_id'::uuid)
ON CONFLICT (singleton) DO NOTHING;

RESET ROLE;

GRANT SELECT (id, name, address, state, google_place_id, website_url, phone, lat, lng)
  ON public.pizza_places TO map_pipeline_contract_owner;

SET ROLE map_pipeline_contract_owner;

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
WHERE lat IS NOT NULL AND lng IS NOT NULL
  AND lat::double precision BETWEEN -90 AND 90
  AND lng::double precision BETWEEN -180 AND 180;

COMMENT ON VIEW pipeline_input.apizza_canonical_match_v1 IS :'contract_comment';

RESET ROLE;

REVOKE ALL ON pipeline_control.database_identity FROM PUBLIC;
REVOKE ALL ON pipeline_input.apizza_canonical_match_v1 FROM PUBLIC;
REVOKE ALL ON pipeline_control.database_identity
  FROM map_pipeline_apizza_shadow_reader;
REVOKE ALL ON pipeline_input.apizza_canonical_match_v1
  FROM map_pipeline_apizza_shadow_reader;

DO $api_roles$
DECLARE
  api_role text;
BEGIN
  FOR api_role IN
    SELECT rolname
    FROM pg_roles
    WHERE rolname IN ('anon', 'authenticated', 'service_role')
  LOOP
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON SCHEMA pipeline_control, pipeline_input FROM %I',
      api_role
    );
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON pipeline_control.database_identity, pipeline_input.apizza_canonical_match_v1 FROM %I',
      api_role
    );
  END LOOP;
END
$api_roles$;

GRANT SELECT ON pipeline_control.database_identity
  TO map_pipeline_apizza_shadow_reader;
GRANT SELECT ON pipeline_input.apizza_canonical_match_v1
  TO map_pipeline_apizza_shadow_reader;

SELECT :'contract_comment' =
  ('map-pipeline-contract:apizza-canonical-match@1:' || :'contract_digest')
  AS contract_comment_ok
\gset
\if :contract_comment_ok
\else
  \warn 'contract_comment does not contain the exact supplied contract_digest'
  \quit 3
\endif

SELECT count(*) = 1
  AND min(database_instance_id::text)::uuid = :'database_instance_id'::uuid AS identity_ok
FROM pipeline_control.database_identity
\gset
\if :identity_ok
\else
  \warn 'database identity does not match the requested singleton UUID'
  \quit 3
\endif

SELECT obj_description(
  'pipeline_input.apizza_canonical_match_v1'::regclass,
  'pg_class'
) = :'contract_comment' AS contract_comment_installed
\gset
\if :contract_comment_installed
\else
  \warn 'view contract comment was not installed exactly'
  \quit 3
\endif

COMMIT;
