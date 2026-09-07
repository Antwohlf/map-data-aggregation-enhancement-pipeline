# APizzaMichigan matching v1

Status: pure legacy-source port for shadow comparison; no deployment or write authority.

`profiles/apizzamichigan/src/matching-v1.ts` is the APizza-owned matching and
routing component. It consumes two immutable inputs:

- normalized `apizza.source-candidate@1` records; and
- one complete, bounded `apizza.canonical-match-snapshot@1` document from the
  attested PostgreSQL reader.

It produces a canonically ordered decision array and a deterministic summary.
The component has no database, filesystem, network, environment, clock, review,
or product-write access. Its plugin wrapper asks the broker only to persist
derived preview artifacts. The outputs remain non-authoritative and inherit the
canonical snapshot's `redistribution: forbidden` restriction.

## Legacy provenance

The behavior was extracted from
`scripts/ops/source-input-sample-report.mjs` in `Antwohlf/apizzamichigan` at
commit `f555431074d7e4902d2b0dc54cb0f9d62206ba56`. Anthony Wohlfeil authored the
source implementation and is publishing this extracted implementation under
this repository's Apache-2.0 license.

The checked-in tests are synthetic, contain no real Foursquare or canonical
place data, and were derived by an independent line-by-line source audit. They
pin all method thresholds, identifier rules, active/closed routing, top-ten
pruning, authority behavior, and the known ranking quirks. A separately
captured, executable legacy-runner golden is still required before an iMac
shadow run can claim record-for-record parity.

## Preserved v1 behavior

- Text is lowercased, NFKD-normalized, stripped of combining marks, converts
  `&` to `and`, removes non-ASCII alphanumerics, and collapses whitespace.
- Exact normalized names score `1`; substring names score `0.85`; otherwise the
  score is the count of candidate tokens found in the canonical token set,
  divided by the larger token-array length. This intentionally preserves the
  legacy asymmetric, duplicate-sensitive calculation.
- Only normalized phone or website values are identifiers. A `source_id` is
  never compared with `google_place_id`. Equal root homepages are rejected,
  while the legacy `string.includes("/")` store-URL test is preserved.
- Haversine distance uses a 6,371,000 metre Earth radius.
- The ordered, inclusive method thresholds remain 100m identifier; 25m/.99;
  75m/.99; 50m/.60; 100m/.35; and 25m spatial-only.
- V1 pins the legacy runtime defaults: 100m maximum distance, 0.02-degree
  matching cells, 1-degree prefetch tiles, 100 tiles per simulated batch, and a
  ten-place nearby cutoff. Arbitrary runtime values are rejected before loops
  begin.
- Candidate-dependent 1-degree prefetch boxes, their latitude-based longitude
  approximation, the 0.02-degree grid, and its latitude-derived search radius
  are simulated against the complete snapshot. This preserves the legacy
  high-latitude omission risks for parity rather than silently correcting them.
- Nearby places are distance-sorted and truncated to ten before match methods
  compete. Every method except `no_match` has equal rank; name score then
  distance choose the winner. A weak or spatial-only row can therefore beat an
  exact identifier, and an exact identifier in position eleven is ignored.
- Active exact/strong decisions are matched, weak/spatial-only decisions are
  ambiguous, and no-match decisions are likely new. Closed records become
  evidence only for an exact/strong match with a real source ID. The legacy
  `includeWeak` option remains intentionally ineffective and is not exposed.
- Lifecycle-closed canonical rows remain eligible because the v1 canonical
  contract intentionally applies no lifecycle filter.

The report distinguishes the complete canonical snapshot size from the subset
selected by the simulated legacy prefetch. It also records the simulated tile
and query counts, grid size, every normalized candidate route, and all legacy
decision buckets without a wall-clock timestamp.

## Deliberate deterministic and audit additions

The legacy SQL had no `ORDER BY`, and complete distance/name ties inherited
database insertion order. V1 adds a UTF-8 byte-order canonical-place-ID
tie-break both before the top-ten cut and after name/distance ranking. This can
change only cases for which the legacy result was unspecified. IDs `1`, `10`,
and `2` are pinned as `1`, `10`, `2`.

The shadow output also emits total decisions that the legacy report omitted:

- filtered, unusable, and out-of-scope rows are `not_compared`; and
- rejected closed evidence is `closed_evidence_dropped`.

These additions make input and decision counts reconcile. They do not grant
review or write authority. `stable_source_id_present` states only whether the
legacy source-ID identity gate can be evaluated; it is not source-policy,
review, evidence, or import authorization. The report's
`legacy_active_matches_with_source_id` count is likewise descriptive of the
legacy algorithm, not permission to write those rows.
Distances and name scores remain lossless in the internal decision artifact;
rounding belongs to a later presentation-only report adapter.

## Remaining gates

This component is not a cutover. Before running it on the iMac, the repository
still needs a complete shadow definition and host composition joining the real
FSQ acquisition/normalization path to the already defined canonical snapshot
source. Before any writer moves, it also needs an independently captured legacy
golden, repeated shadow comparisons, fault/restart and artifact restore tests,
approved FSQ terms, a rollback rehearsal, and an explicit no-dual-writer
cutover.
