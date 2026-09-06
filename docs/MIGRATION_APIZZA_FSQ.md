# APizzaMichigan FSQ migration slice

Status: synthetic preview only; no cutover authority.

This implementation formally selects FSQ as the first executable
APizzaMichigan extraction slice. FSQ was chosen
before OSM because the extraction RFC requires OSM to migrate last among Pizza
discovery sources. OSM has materially more planner, tiling, manifest, timeout,
cooldown, and partial-progress state.

## Legacy reference

The pre-match field contract is based on
`scripts/ops/source-input-sample-report.mjs` in `Antwohlf/apizzamichigan`, last
changed by commit `f555431074d7e4902d2b0dc54cb0f9d62206ba56`. The new profile
preserves the legacy FSQ aliases and normalized fields for source ID,
coordinates, name, address, locality, region, postcode, country, website,
phone, categories, source URL, confidence, spider, and closed status.

Legacy scope is read from `config/source-pipeline.json`, pinned here at commit
`b3136f385806cb7ca0655a6631cf828e34eb4b7f` with SHA-256
`a0f2b554171be87d5f3d67a349dadf8afc18410a62af8822adcc1a7d7a2373fa`.
The preview embeds the relevant geographic and pizza-eligibility values; it is
an approximation pending an independently captured legacy routing golden.

The new transport adds profile-scoped source-record and observation identities,
lineage and a versioned schema. Its pre-match route ports the legacy
usable/active-or-closed/scope/pizza eligibility order and terms. Those
additions do not grant source authority or publication permission.

## Current evidence

- A generated, CC0 synthetic fixture covers both FSQ ID aliases, coordinate
  aliases, category shapes, a non-pizza row, and a missing-identity row.
- Contract tests pin the legacy-normalized payload before matching.
- A read-only direct comparison against the pinned legacy module produced
  canonical payload equality for all four fixture rows with expected scalar
  input shapes. The current golden pins this implementation; it is not yet an
  independently captured legacy routing golden.
- The mixed Michigan/New York fixture is honestly labeled with the legacy
  pipeline's US partition. It produces four immutable candidates: three ready
  for matching (including the identity-free row, as legacy does) and one
  filtered as non-pizza.
- Missing external IDs use a profile-owned `fallback-v1` identity derived from
  normalized name/location fields, excluding retrieval time; retrieval changes
  create a new observation without changing the fallback source key.
- Closed-date routing uses the definition-pinned evaluation timestamp rather
  than the machine clock. Candidate ordering breaks source-key ties with the
  raw observation identity.
- The required report sink returns a broker-minted receipt bound to its exact
  output handle, port, and content digest.
- The APizza run records all three stage attempts; the SQLite store separately
  has a close/reopen persistence test for run, attempt, and checkpoint data.
- Fixture-preview construction rejects network, database, evidence, review,
  canonical, and public effects. A distinct read-only shadow executor accepts
  only exact host-granted reads and still rejects every non-preview write.
- The first canonical-input contract and PostgreSQL snapshot adapter now pin a
  private view, exact safe columns/types, a unique bounded cursor, database and
  role identity, repeatable-read snapshot, and view/contract digests.

## Missing parity gates

The preview ports the legacy geographic eligibility filter, but the legacy
report also performs canonical database lookup, distance/name matching,
evidence routing, and review-candidate classification. Those stages are not
represented yet. A read-only attempt to run the complete legacy report against
the synthetic fixture could not connect to local Postgres, so no
record-by-record database-backed comparison is claimed.

Before any shadow run, this slice still needs:

1. The current scope, distance, name, and routing rules as APizza-owned
   transforms with golden parity cases.
2. A report that diffs every normalized and routed record against the legacy
   runner at the pinned script and scope-config commits, including malformed
   shapes, duplicate IDs, scope boundaries, future closure, and every alias.
3. Restart, fault, artifact-backup, and restore tests required by Phase 1.
4. Approved source terms and a real acquisition adapter. Synthetic approval is
   not FSQ source approval.
5. Provisioning and multiple complete shadow runs with every writable sink
   absent.

The iMac scheduler and all legacy writers remain unchanged and authoritative.
