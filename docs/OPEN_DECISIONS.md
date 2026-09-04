# Owner decisions and remaining gates

Confirmed on 2026-09-04:

1. The generalized repository is public under Apache-2.0.
2. Permitted operational raw artifacts have a provisional maximum retention of
   30 days. Community-tip PII and raw website bodies never enter ordinary
   artifacts. Unverified sources remain `pending` and artifact-forbidden.
3. The first BuildHere cutover reproduces legacy Ann Arbor mapper output. Known
   status/year-date corrections use a separately reviewed transform and
   backfill.
4. The active legacy Taco publisher remains authoritative until an explicit
   no-dual-writer cutover.
5. BuildHere v1 includes field-level manual overrides.
6. BuildHere uses PII-free views and product-owned stored procedures rather than
   broad raw-table grants.
7. Ann Arbor is the first preview-only BuildHere vertical slice.
8. Taco's target contract remains owned by `apizzamichigan` for now.

Remaining implementation gates are source-by-source terms and redistribution
review, the exact BuildHere field matrix and target contract, a verified preview
execution context, real adapters/stores/sinks, iMac Node 22/SQLite fault tests,
and rehearsed no-dual-writer cutovers. None of these profiles can apply today.
