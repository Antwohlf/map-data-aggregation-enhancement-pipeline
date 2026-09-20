# Restaurant quality desk

A read-only working dashboard of current local PostgreSQL and SQLite data.
It includes publication holds, duplicate identity and nearby-name candidates,
invalid/missing coordinates, failed jobs, weak/invalid classifications, missing
source evidence, old/never-run enrichment and missing menu links. Exact totals
are separate from bounded samples (150 per issue/product); every hold is shown.
A record may have multiple flags. A duplicate candidate is not a merge decision.

Run with existing read-only database credentials in the runtime environment:

```sh
node scripts/ops/restaurant-quality-report.mjs --output /private/quality.json
node scripts/ops/build-restaurant-quality-dashboard.mjs --input /private/quality.json --output /private/quality-desk
```

The exporter opens a repeatable-read PostgreSQL transaction and the queue in
read-only mode. It excludes personal ratings, review notes, photos and secrets.
Evidence links prefer first-party/OSM pages; API query strings are removed.
A missing queue reports unavailability rather than zero failures.

The resulting `index.html` works as a standalone file. To reload newly exported
JSON without rebuilding, serve the output directory over a local HTTP server.
Refresh the export before reloading; the dashboard never runs enrichment itself.
Snapshot age is explicit and turns stale after24hours. Search and CSV export
apply to the displayed samples. CSV cells neutralize formula prefixes.

Filters, pagination, selected evidence, public-review links and CSV download
were verified with the real September20 snapshot at desktop and390px widths.
No schema change, publishing action, merge or retry is exposed in this UI.
