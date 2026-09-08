# APizza review-file handoff

`projectApizzaReviewV1` is a pure output adapter for FSQ candidate envelopes and
their matching decisions. It emits the JSON shape consumed by the application's
`scripts/ops/import-source-review-queue.mjs`: `entity`, `source`, `source_label`,
`generated_at`, `ambiguous`, and `likely_new`.

Only `ambiguous_review` and `likely_new` decisions become review items. Existing
matches, closure evidence, and excluded records need their separate workflows.
The adapter reconciles candidate and decision identities, rejects duplicate queue
keys, and reports missing stable source IDs as blocked rather than inventing IDs.
A report with blocked items is marked `incomplete`; do not import it as a complete
handoff.

Source data uses an explicit field list. Pipeline source-record and observation
IDs are preserved in `source_data._pipeline`. For ambiguous decisions,
`nearest_place` contains the selected best match to preserve the app's existing
review semantics, even when another place is geographically closer.

The adapter returns data only: it does not open files, connect to a database,
enqueue reviews, change human decisions, or publish places. Its output must stay
in private host storage under the input artifacts' retention restrictions.
The host should verify input artifact digests and retain the originating run's
provenance alongside the output.

## Application check

First run the application's existing importer against the exact private file,
without `--apply` or `--apply-schema`:

```sh
node scripts/ops/import-source-review-queue.mjs \
  --entity pizza --input-file <private-external-review-json>
```

This checks compatibility and reports intended queue rows without adding them.
The app owns queue credentials and the later apply operation. Its current upsert
updates only rows whose status is still `pending`, preserving completed human
decisions and notes. Verify that behavior against the deployed app version before
enabling an import job. Public/canonical writes remain separately disabled.

## Parity evidence

The first 100-record historical host sample agreed with the actual legacy
normalizer and matcher on every normalized payload field and decision field
when replayed against the same saved canonical snapshot. This was a private
host replay, not an independent fresh upstream release test. Complete legacy
ties can depend on unspecified SQL row ordering; broader samples and an explicit
tie policy are still needed before cutover.
