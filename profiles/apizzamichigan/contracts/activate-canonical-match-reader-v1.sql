-- Interactive final activation after provision-canonical-match-v1.sql commits.
-- The provisioning transaction deliberately leaves this role unable to log in.

\set ON_ERROR_STOP on

\password map_pipeline_apizza_shadow_reader

ALTER ROLE map_pipeline_apizza_shadow_reader LOGIN;

SELECT rolcanlogin
  AND NOT rolinherit
  AND NOT rolsuper
  AND NOT rolcreatedb
  AND NOT rolcreaterole
  AND NOT rolreplication
  AND NOT rolbypassrls
  AND rolconnlimit BETWEEN 1 AND 2 AS reader_activated_safely
FROM pg_roles
WHERE rolname = 'map_pipeline_apizza_shadow_reader'
\gset
\if :reader_activated_safely
\else
  \warn 'reader activation posture did not verify'
  \quit 3
\endif
