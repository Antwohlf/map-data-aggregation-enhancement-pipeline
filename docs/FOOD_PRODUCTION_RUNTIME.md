# Food production compatibility runtime

`packages/food-runtime` extracts the existing Pizza and Taco acquisition,
review, enrichment, and guarded publication jobs from the website repository.
It has no import or execution dependency on a website checkout.

This is a compatibility process adapter, not a claim that every legacy step
already runs through the artifact executor. The executor's read-only shadow
gates remain unchanged. This runtime preserves the established database and
human-review contracts while individual steps can subsequently be replaced.

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

## Code versus private state

Install the root lockfile with `npm ci`. Use a separate host-owned directory
with mode 0700 for `.env`, optional `.env.local`, SQLite queue, source snapshots,
reports, checkpoints, logs, and Python environment. Never commit that directory.
The host must supply its existing narrow database credentials. This change
does not create or broaden database grants.

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

The FSQ/Overture exporters require a host Python environment at
`scripts/.fsq-venv` with the existing provider dependencies. Recreate it at its
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
