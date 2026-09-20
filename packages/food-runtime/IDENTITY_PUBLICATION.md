# Canonical IDs and publication holds

Existing public IDs are permanent: personal reviews and photos depend on them.
New website/manual rows use 500,000,000–999,999,999 via their identity sequences.
New pipeline imports use 1,000,000,000–2,147,483,647 under an exclusive table
lock held through insertion. Existing lower IDs remain valid. Never reset a
public sequence to MAX(id): explicitly inserted pipeline IDs use another range.

Before deploying this publisher, apply `scripts/ops/sql/publication-holds.sql`
to the local enrichment database. Apply `public-manual-id-range.sql` to the
public database once, after backing up sequence settings. Its preconditions
deliberately reject reapplication or unexpected high IDs.

The publisher reads active `publication_holds` at startup and reports their
count. Scheduled scans exclude them; explicitly requesting a held ID fails.
A missing registry or lack of read permission fails closed. All eligible
records still undergo the existing stable-identity checks before any writes
or checkpoint advancement. A hold never establishes identity or grants
permission to publish a new record.

Review `reason` and `evidence` before releasing a hold. Record a nonempty
`resolution` and `released_at` only after the source and public identities
are verified. Do not fabricate Google/OSM identifiers for legacy records.
When releasing an older record, run an explicit bounded publish/replay so
an existing chronological checkpoint cannot leave it stranded.

For ID repairs, stop and drain food writers, back up PostgreSQL and the SQLite
queue, and rehearse on a restored database. Update canonical foreign-key-like
columns and known embedded canonical references transactionally. Queue jobs
are addressed by `(place_type, osm_id)` and do not need numeric rekeying.
Keep historical evidence and an old-to-new mapping receipt. Preserve public
reviews, IDs and photo relationships and compare them exactly after repair.
