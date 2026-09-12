# Food production compatibility runtime

`packages/food-runtime` extracts the existing Pizza and Taco acquisition,
review, enrichment, and guarded publication jobs from the website repository.
It has no import or execution dependency on a website checkout.

This is a compatibility process adapter, not a claim that every legacy step
already runs through the artifact executor. The executor's read-only shadow
gates remain unchanged. This runtime preserves the established database and
human-review contracts while individual steps can subsequently be replaced.

## Interchangeable trusted-host stages

`@map-pipeline/executor/trusted-host` is the production orchestration path for
trusted host adapters. It validates a complete versioned stage graph before
starting any stage, orders dependencies, supplies only predecessor outputs,
and stops downstream execution on failure. The injected registry owns code;
JSON definitions do not contain executable commands. Source, transform,
review, output, and maintenance are distinct stage kinds.

The food source runner uses configured acquisition, matching, and review nodes
for OSM, FSQ, Overture, and Wikidata. These nodes retain their existing private
files and review contracts. An adapter can be replaced in the registry and
selected by configuration without changing the orchestration loop. Product
configuration keeps Pizza and Taco identities and source policies separate.

This is **trusted host execution**, not a sandbox or broker capability system.
Adapters retain the host process's permissions. The artifact-based preview
executor and its admission restrictions are unchanged; its inert product
declarations do not authorize production writes. There is no automatic retry
or replay of side-effecting stages. Existing source checkpoints, shared locks,
review decisions, and guarded publisher checks remain authoritative.

Scheduled tasks also run as registered trusted-host nodes: publication is an
output adapter, classification/menu parsing are transforms, and housekeeping
is maintenance. Their implementations remain the proven compatibility
entrypoints, with the existing process-group shutdown supervision. ATP and
website draining inside a source cycle remain composite compatibility work;
this bridge does not claim broker-secured artifact-executor parity.

## Product profiles and shared workers

`config/production-tasks.json` selects the product-specific source config,
entity, work limits, and publication arguments. Pizza and Taco have separate
source checkpoints. The `food-shared` profile owns the existing shared SQLite
scraper/classifier queue, retry feeder, reconciliation, menu parser, and backup.
Those workers carry the entity on each job; they must not be launched once per
product against copies of that queue.

New source/review/output implementations belong in their own adapter packages;
the food compatibility code is not a universal dependency for BuiltHere.
BuiltHere has not been cut over by this change.

### Publication identity safety

Local and public numeric IDs are not sufficient proof that two rows describe
the same restaurant. Before preparing any update (including lifecycle-only
updates), publication compares stable source identities and geography. A public
row without a stable identity requires an exact normalized name, compatible
state, and coordinates within 25 metres. Matching stable IDs still reject
coordinate conflicts beyond 250 metres. Website and phone are not identity
evidence because they are enrichment fields that may already be incorrect.

An identity conflict stops the batch before any write or checkpoint advance.
Do not bypass it or overwrite the website's reviewed identity. Pause publication,
back up both sides, and resolve the mapping through a separately reviewed repair.

Source matching similarly sends an identifier match with zero name overlap to
review, rather than automatically linking a replacement business or reused phone.

Taco's formerly deferred Overture source now uses the dedicated
`food-source-overture-taco-v1` adapter and `overture-taco-taxonomy-v1` policy.
It selects Mexican, taco, and Tex-Mex restaurant taxonomy matches rather than
Pizza's category, and rejects cross-product adapter/manifest identities.
Its bounded acquisition and delivery were verified on the production host on
September 11, 2026. The regional scan remains incremental; a successful batch
does not mean the entire configured geography has been scanned. See
[Taco Overture delivery](TACO_OVERTURE.md) for checkpoints, retries, cadence,
and deployment safeguards. OSM and official-website processing retain
their existing configuration and Taco-specific candidate filtering.

### Resumable FSQ acquisition

The food compatibility exporter filters by product, US country, requested
state, open status, and valid coordinates **before** the candidate limit.
Each product/state owns `scripts/.source-cursors/fsq-<entity>-<state>.json` in
its private workspace. A page scans at most one shard and 1,250,000 rows;
candidate limits can stop it earlier at an exact row offset. Fully consumed
Parquet row groups are skipped on resume. This is a local scan, not a claim of
provider-side geographic filtering.

Hugging Face's converted-Parquet branch is resolved to an immutable commit.
The ordered pinned file list, product, query, and geography stay bound to the
cursor until the scan completes. A later release cannot replace an unfinished
scan. The v2 cache uses pinned-URL hashes and verified download sizes, with a
512 MiB managed-cache ceiling and a read/download lock shared across products.
Eviction touches only this new managed cache, not legacy files or review state.
Real source files remain private and must never enter this public repository.

The exporter durably records a pending page before writing its disposable
output. Empty pages are successful progress. Matching, review import, and
configured reviewed-new processing must finish before the runner acknowledges
that page. Failure replays the same pending rows; downstream writes retain
their existing idempotency guards. Dry runs do not acknowledge or move the
cursor. Incomplete scans resume hourly; completed regions wait their configured
refresh interval even while another region still has work.

Do not delete a cursor to recover a downstream error. Correct the error and
retry the pending page. A changed product/geography identity or invalid cursor
fails closed. Python cursor tests cover row and file boundaries, empty pages,
replay, output failure, cross-product rejection, and completed-region pacing.

## Code versus private state

Existing public rows receive a new `updated_at` only when an enrichment,
classification, QA, or explicitly enabled lifecycle value changes. A source
timestamp difference alone does not cause a write; exact replay is a no-op.
Insert payloads retain their existing source-timestamp behavior. Explicit
lifecycle IDs remain eligible when both local lifecycle fields are null, so
an approved clear can remove stale public lifecycle values. Identity checks
still run before payload creation, including no-op and lifecycle-only runs.

Install the root lockfile with `npm ci`. Use a separate host-owned directory
with mode 0700 for `.env`, optional `.env.local`, SQLite queue, source snapshots,
reports, checkpoints, logs, and Python environment. Never commit that directory.
The host must supply its existing narrow database credentials. This change
does not create or broaden database grants.

### Task credentials

The production launcher loads `.env`, then `.env.local`, then optional
`secrets/<profile>.<task>.env`. Publication tasks additionally load
`secrets/publication.env` before their task file. Explicit inherited scheduler
settings take precedence over files. Environment files must be regular,
non-symlink files with no group/other permissions and at most 64 KiB.

Keep Supabase publication credentials exclusively in `secrets/publication.env`
or the individual publication task files, never in the shared dotenv files.
Only publication tasks load that shared publication file. Source tokens are
forwarded only to source tasks; database passwords remain available to tasks
that access the local database. Child helpers preserve inherited task settings
instead of replacing them with shared dotenv values.

Deployment requires stopping and draining the scheduled jobs, backing up the
private environment files, moving publication credentials out of **both**
shared dotenv files, preparing the new code links, and validating source and
publication runs after restart. Filtering the launcher's environment alone is
insufficient: legacy children can still read the shared dotenv files.

This reduces accidental credential inheritance; it is not an operating-system
sandbox. Processes under the same host user can still read that user's private
files. The environment filter targets named Supabase/source credentials and
common secret suffixes, not every possible secret or credential-bearing variable;
the scheduler must not inject unrelated credentials into these jobs.
Restricted database roles also require appropriate host authentication
rules; merely changing `PGUSER` does not restrict a password-free administrator
connection. Coordinate changes to host-wide authentication with other database
clients before applying them. Configure both `PG*` and `LOCAL_DB_*` settings
where a task invokes helpers using both database configuration conventions.

Run `node packages/food-runtime/production.mjs --prepare --workspace "$FOOD_WORKSPACE"`
to link individual runtime code/config files into the private workspace.
Preparation refuses conflicting files or directory symlinks. Mutable directories
remain real private directories. The code checkout must remain at its pinned
revision while jobs are active; prepare a new checkout for later releases.

Run `node packages/food-runtime/production.mjs --profile apizzamichigan --task source --workspace "$FOOD_WORKSPACE"`
to print the command without running it. Add `--execute` only after the
single-writer cutover checks below. Use `tacoboutmichigan` for Taco and
`food-shared` for shared tasks. Plans do not print environment values.

The wrapper reads workspace dotenv files, then preserves inherited scheduler
settings. Product identity and source-state paths are pinned by the profile.
Publication still runs the established guarded preflight; `--execute` on
publication permits the existing bounded writes, not a preview.
Execution refuses a staging marker or an absent existing queue. Clear the
staging marker only after the coordinated stop-and-snapshot checks pass.

The FSQ/Overture exporters require a host Python environment at
`scripts/.fsq-venv` with dependencies pinned in the package's `requirements.txt`.
The migration host was verified with Python 3.9, pyarrow 21.0.0, and duckdb 1.4.5.
Recreate it at its
final path: moving a virtual environment can leave invalid executable paths.
Provide `PG_DUMP_BIN` or a PATH containing the matching PostgreSQL `pg_dump`.
Provide the scraper's browser executable and Ollama settings on the host.

## Cutover and rollback gates

1. Inventory every active scheduler entry and preserve its timing, arguments,
   environment, logs, and original definition privately.
2. Install and test the new pinned checkout; prepare the private workspace.
3. Stop all old writers, including shared queue workers. Confirm their child
   processes have exited before taking the final state snapshot.
4. Back up PostgreSQL and use SQLite's backup API for the queue. Preserve the
   old queue and copy exact source/publication checkpoints, statuses, and needed
   provider caches. Do not copy a live SQLite main file without its WAL state.
5. Repoint the coordinated scheduler set to the wrapper and private workspace.
   Retain the established shared source/publication locks during the switch.
6. Verify a bounded cycle for both products, correct entity routing, review
   preservation, queue continuity, and guarded publication. Inspect actual
   scheduler processes and output timestamps, not only exit codes.
7. Only then remove runtime implementations from the website repository and
   verify its build and external pipeline-status boundary.

For rollback, stop and drain the new writers first. Restore scheduler definitions
and transfer the **latest** runtime queue/checkpoints back using a consistent
backup; do not blindly restore a stale pre-cutover queue after new work has
completed. Database writes are not undone merely by reverting scheduler paths.

## Validation and remaining risks

`npm test` runs the generic executor suite plus the extracted safety tests and
workspace/profile tests. The source implementation starts from the reviewed
website code; the production host may be on an older revision, so inspect
its delta before activation.

Dependencies are pinned to the website lockfile for migration parity. The
legacy Supabase client has a known low-severity auth routing advisory; this
runtime does not use user-driven auth routes. Upgrade it in a separately
verified change, rather than silently changing database-client behavior here.

Repository tests and prepared links do not prove production activation. Record
actual host revision, scheduler cutover, and both product run evidence in a
private deployment record. Until those checks exist, migration is incomplete.
