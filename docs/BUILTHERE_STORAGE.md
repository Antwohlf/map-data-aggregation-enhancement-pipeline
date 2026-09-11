# BuiltHere storage and recovery

The website database contains published projects, tips, human decisions, current
source proposals needed to remove an override, and publication receipts. Source
downloads, scan cursors, pending commands and acquisition/review artifacts belong
in the private BuiltHere workspace. Food queues and credentials are separate.

The production command requires the website's `20260911000000_storage_guard`
migration. It checks that the trigger is enabled before any publication. That
trigger rejects new official observations with SQLSTATE 54000 at 450,000,000
bytes, reserving room for the website and human decisions. Exact existing receipt
replays remain available above the threshold. This is a conservative operational
budget, not a claim about provider billing measurements.

The runner preserves the last successfully published source/mapped/version hash
per source identity in each city's checkpoint. Unchanged refreshes produce no
database commands or per-page review files. A→B→A remains a change; a source
proposal suppressed by a manual override is still recorded. Failed/pending
commands keep exact idempotency keys until receipt recovery and atomic checkpoint
completion. Completed city scans wait 24 hours before another full scan. Partial
scans continue under the existing per-run batch and shared compute limits.

The default local budget is 512,000,000 bytes. File replacements and delivery
records reserve space before publication. Crossing either budget stops the job;
there is no automatic deletion, paid upgrade, database switch, or retry loop
that expands these budgets. Empty successful review pages are not archived.
Raw ArcGIS records are processed in memory; retained delivery artifacts contain
the allowlisted mapped command, receipt and sanitized review outcomes.

## Operating procedure

1. Keep ingestion paused during storage recovery. Check both PostgreSQL relation
   sizes and the provider's project/branch usage; storage does not reset monthly.
2. Produce a full custom-format `pg_dump` with a client matching the server major
   version, into a private directory outside all Git repositories. Use an
   exported repeatable-read snapshot if recording table fingerprints alongside
   the dump. Supply credentials through a private environment/password file.
3. SHA-256 the dump, copy it to another private host, verify that checksum, and
   restore into a disposable database with the production encoding and locale.
   Compare counts and ordered content fingerprints for every product and audit
   table. Restoring with `--no-owner --no-privileges` tests contents; role grants
   must be verified separately before any real recovery.
4. For an existing installation, preserve both checkpoints and all pending
   commands. Seed the new `versions` dictionary from the latest source event per
   source/identity in the verified snapshot using `commandVersion`. Do this only
   while the writer is paused; never replace a nonempty ledger or use another
   product's state. A missing ledger is safe but incurs one publication pass.
5. Install the additive guard, verify runtime privileges and exact replay, then
   install the runtime. Above budget, leave ingestion disabled. Resumption needs
   approved storage recovery and a new read-only size check.
6. Before each recovery or migration, make another verified snapshot. Retain
   backups and existing audit data until the owner approves a retention/archive
   operation. Provider point-in-time history alone is not an independent backup.

## Retention and rollback

Human decisions, ratings, notes, photos, current source proposals, pending work,
and live project rows are never cleanup candidates. The website repository owns
the read-only audit candidate query. A candidate inventory is not deletion
authorization. Archiving an idempotency receipt changes replay availability and
requires an explicit replay horizon, archive verification and approval.

Real changed observations still grow audit storage. Periodically review the
budgets and archive eligible history through an approved maintenance procedure.
This bounded design stops before exhaustion; it does not claim indefinite free
storage or silently discard history. `DELETE` and ordinary `VACUUM` may leave
allocated relation space; a rewrite needs working space and may take locks.

To roll back runtime code, pause the BuiltHere service and restore its prior
commit. Keep the SQL guard enabled; the old runner is not safe to resume because
it republishes completed scans. Checkpoints are backward-compatible JSON with
additional fields, and pre-rollout private copies preserve exact recovery state.
Do not restore an old database snapshot over newer human decisions.
