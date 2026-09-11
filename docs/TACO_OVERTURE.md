# Taco Overture delivery

Taco uses `food-source-overture-taco-v1` and
`overture-taco-taxonomy-v1`: Mexican, taco and Tex-Mex restaurant taxonomy matches,
US geography and retained Overture release/category/provider attribution. The
existing Pizza acquisition path is independent.

Each regional Taco manifest now has a private `.delivery.json` checkpoint.
Delivery reconstructs rows from durable manifest tiles, so an interruption between
manifest and cumulative-output writes cannot mix releases. At most 2,500 rows
are sent to the existing match/review graph per work unit. Pending rows replay
exactly after failure. Acknowledgement happens only after matching, review queue
import, and the existing guarded creation path succeed. Human decisions and
protected rating/note/photo fields retain their existing authority.

All acquired rows must be acknowledged before another acquisition or release
renewal. Existing manifests begin delivery at zero: replaying a previously
reviewed row preserves the queue's human decision. Do not seed an assumed offset
from a historical 2,500-row report: earlier acquisitions may never have reached it.

Incomplete acquisition/delivery becomes due after one hour; fully delivered
scans retain the seven-day refresh cadence. Acquisition still uses one tile per
work unit, two DuckDB threads, a 2 GB memory cap and the shared host resource gate.
The plan command uses the same backlog calculation as execution.

Run `npm test` for coverage of taxonomy, entity credentials and queues, bounded
page delivery, retry acknowledgement, changed-prefix rejection, cross-product
manifest rejection and release rollover interruption. A code merge does not
activate a host: update the pinned host revision and verify a bounded Taco-only
canary separately. Retain manifests/checkpoints during rollback; pausing the Taco
source task is safer than resuming the old truncated delivery path.
