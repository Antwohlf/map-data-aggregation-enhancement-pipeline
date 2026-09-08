# APizzaMichigan FSQ migration slice

Status: complete read-only shadow composition and fail-closed host runner; no
real-data policy approval or cutover authority.

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
- The APizza-owned pure v1 matcher now accepts normalized candidates plus the
  complete canonical snapshot, simulates the legacy candidate prefetch/grid,
  and emits deterministic, authority-safe decisions and a reconciled report.
  Synthetic goldens cover all thresholds, legacy name/identifier quirks,
  top-ten pruning, method-agnostic ranking, closed routing, missing source IDs,
  and UTF-8 tie-breaking. See `docs/APIZZA_MATCHING_V1.md`.
- The five-stage read-only shadow definition now joins a bounded FSQ OS release
  projection, real-row normalization, the canonical PostgreSQL snapshot,
  matching, and an independently reconciled required report sink.
- The FSQ projection is validated against an exact 15-field contract before it
  becomes a broker-owned ephemeral dataset. The registry-owned raw value is
  released after normalization and never enters the artifact store or SQLite
  state; trusted in-process normalization temporarily receives a separate
  memory copy.
- Downstream artifacts retain the exact FSQ and PostgreSQL source attestations,
  while the terminal report contains only counts and digests. Tests exercise
  active and closed rows, reject unknown/private fields before persistence, and
  prove the definition contains no product, evidence, review, or state writer.
- A real-data host runner now validates an owner-only manifest and projection,
  binds the checked-in source policy and database contract, obtains only a
  dedicated read-only DSN from the host environment, uses a cross-process lock,
  supports host cancellation, and emits no host paths or source rows.
- The checked-in source policy remains pending. Credential provisioning,
  release provenance, owner policy approval, restricted-projection privacy
  approval, and measured iMac resource bounds remain explicit activation
  gates. See `docs/APIZZA_FSQ_SHADOW_HOST.md`.

## Missing parity gates

The source-audited matching transform is wired into a complete executable
shadow definition, but it has only been exercised with synthetic inputs. No
record-by-record database-backed legacy comparison is claimed yet.

Before any shadow run, this slice still needs:

1. An independently captured report that diffs every normalized and routed record against the legacy
   runner at the pinned script and scope-config commits, including malformed
   shapes, duplicate IDs, scope boundaries, future closure, and every alias.
2. A recorded decision for the pre-existing FSQ projection file: an explicit
   zero-day raw-file exception, classification as an approved restricted
   projection with documented privacy controls, or replacement with a true
   streaming acquisition adapter.
3. Restart, fault, artifact-backup, and restore tests required by Phase 1.
4. Owner approval of the checked-in FSQ OS Places license/NOTICE evidence,
   exact release identity, and restricted-projection privacy classification.
   Synthetic approval is not FSQ source approval.
5. Provisioning and multiple complete shadow runs with every product writer
   absent.

The legacy FSQ exporters currently discard closed rows and must not be reused
unchanged for parity. The v1 release contract requires closed rows so both the
active and closed-evidence paths are represented.

The iMac scheduler and all legacy writers remain unchanged and authoritative.
