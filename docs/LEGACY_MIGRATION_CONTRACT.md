# Legacy migration contract

Migration inventory has four independent state classes:

1. Planner state: due work, attempts, cooldowns, and source partitions.
2. Acquisition state: OSM tiles/pages, manifests, checksums, and relocatable
   artifact references.
3. Delivery state: profile- and target-bound publication checkpoints and
   receipts.
4. Worker queue: jobs, claims, attempts, results, and control state.

A migration may not treat these as one checkpoint file. Every imported object
is checksummed, schema-versioned, explicitly bound to a profile and target, and
verified with the old checkout unavailable. The approved import manifest binds
both content and source-path digests and produces an immutable, non-null
profile/target descriptor. Unscoped legacy publication checkpoints cannot be
accepted through a binding for another Pizza or Taco path.

Queue migration inventories and quiesces every writer: producers, consumers,
reconcilers/reapers, retry feeders, scraper-created downstream jobs, and manual
writers. It also reconstructs desired work suppressed by legacy uniqueness
keys before asserting cross-profile parity.

The service-topology inventory comes from both desired service files and the
live process/service manager. A loaded service with no file is still a mutator.
Desired and live schedules and command digests are recorded separately, along
with queue/store/lock identity, produced and consumed task types, and target
write scopes. Cutover is blocked until claims are reconciled, enqueue routing
has switched, and legacy writers are disabled. These are externally collected
facts checked by the contract; the declarations alone are not proof.
Missing schedules or command identities fail closed, as do two loaded apply
services claiming the same target-write scope.
Backups cover all four state classes plus referenced artifacts and are restored
with WAL/integrity checks before cutover.
