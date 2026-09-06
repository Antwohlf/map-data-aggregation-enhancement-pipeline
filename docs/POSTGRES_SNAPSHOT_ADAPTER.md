# Read-only PostgreSQL snapshot adapter

`@map-pipeline/adapter-postgres` is the first host-owned real-data boundary in
the extraction. It exists only for read-only shadow runs. It cannot write
state, evidence, review decisions, canonical records, or public records.

## Trust boundary

Pipeline definitions and plugins receive only a logical
`postgres-view://...` URI. The trusted host maps that URI to a fixed database,
dedicated role, private versioned view, selected columns, column types, unique
cursor, database-instance UUID, and contract digests. The DSN is supplied only
to the host-side reader and is never passed to plugin code or recorded in
artifacts.

Every acquisition uses one `REPEATABLE READ READ ONLY` transaction. Before
reading rows, the adapter verifies:

- `session_user` and `current_user` are the exact configured reader role;
- the role can log in, has `NOINHERIT`, and has no superuser, database-create,
  role-create, replication, or RLS-bypass attribute;
- a locked singleton relation contains the expected database-instance UUID and
  is owned by a role the reader cannot assume;
- the input relation is a view with the exact contract comment, view-definition
  digest, columns, and safe output types;
- the text cursor is non-null, non-empty, unique across the full snapshot, and
  at most 256 UTF-8 bytes.

Rows are read with `C`-collated keyset pagination. The database returns only
JSON payload prefixes within the remaining broker byte grant; the adapter also
recomputes canonical byte and record counts and fails instead of truncating.
Snapshot metadata records the database-instance digest, view binding digest,
transaction snapshot ID, capture time, cursor range, and contract identity.
The shadow executor compares that metadata with a separate host-owned grant.

An abort owns and drains pending connection acquisition before it settles.
Checked-out clients have an error listener for their full lease, and database
failures expose only a normalized message and safe SQLSTATE.

## Provisioning APizza v1

The public contract is
`profiles/apizzamichigan/contracts/canonical-match-v1.json`. It intentionally
includes lifecycle-closed rows because the first shadow baseline must match the
legacy candidate set. Correcting that behavior requires a new contract version
and a separately reviewed parity change.

Calculate the contract digest with:

```sh
npm run digest:json -- profiles/apizzamichigan/contracts/canonical-match-v1.json
```

Review, then run the adjacent `provision-canonical-match-v1.sql` with `psql` as
the database owner. Supply its three required psql variables and use a stable,
random UUID generated once for this database. Provisioning first disables login,
terminates existing reader sessions, resets authority, and commits with the role
still disabled. Then run the adjacent
`activate-canonical-match-reader-v1.sql` interactively: it rotates the password
with `\password`, enables login, and verifies the runtime posture. This prevents
an old credential or session from racing provisioning, and keeps the replacement
password out of the repository and shell history.

The runtime credential must be the fixed
`map_pipeline_apizza_shadow_reader` login—not `postgres`, a Supabase
`service_role`, an `anon`/`authenticated` identity, or an inherited product
role. The adapter rejects a reader with any role memberships, and provisioning
removes memberships, refuses a reader that owns database objects, and clears
its direct privileges in the database with `DROP OWNED` before restoring the
exact pipeline grants below. Run it with an administrator authorized to alter
both dedicated roles and execute `DROP OWNED`; insufficient authority aborts
the transaction.

- `CONNECT` to `pizza_enrichment`;
- `USAGE` on private `pipeline_control` and `pipeline_input` schemas;
- `SELECT` on `pipeline_control.database_identity`;
- `SELECT` on `pipeline_input.apizza_canonical_match_v1`.

The pipeline schemas must not be exposed through Supabase's Data API. If a
future deployment uses Supabase, keep them outside the exposed schema list and
retain the template's explicit revocations from `PUBLIC`, `anon`,
`authenticated`, and `service_role`.

PostgreSQL roles always inherit privileges granted to `PUBLIC`; the template
does not globally change those database-wide defaults or revoke access outside
the two private pipeline schemas from other roles. Before provisioning, audit
application schemas for unsafe `PUBLIC` grants—especially executable
security-definer routines. The adapter itself exposes no arbitrary-query API
and executes only its fixed, attested read sequence.

After provisioning, start a transaction, set
`search_path = pg_catalog, pg_temp`, query `pg_get_viewdef` for the exact view,
and compute
`computePostgresViewDefinitionDigest` over the returned text. The host resource
binding pins that digest, the contract digest, the database UUID, and the
adapter-generated reader binding digest. Do not copy those attestations into a
plugin config.

## Current deployment status

The adapter and shadow runtime are implemented and tested, but no iMac role,
view, credential, or scheduler has been changed. The legacy APizza jobs remain
authoritative until matching parity, repeated shadow runs, rollback rehearsal,
and an explicit no-dual-writer cutover all pass.
