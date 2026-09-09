# Map Data Aggregation and Enhancement Pipeline

[![CI](https://github.com/Antwohlf/map-data-aggregation-enhancement-pipeline/actions/workflows/ci.yml/badge.svg)](https://github.com/Antwohlf/map-data-aggregation-enhancement-pipeline/actions/workflows/ci.yml)

Pre-alpha extraction implementation for reusable, profile-driven map data pipelines.
The runtime mechanics are shared; source authority, transformations, review
policy, and destination mappings remain owned by the APizzaMichigan,
TacoboutMichigan, and BuildHere.city profiles.

This is a public, Apache-2.0-licensed repository. It contains no production
credentials or runtime state. Generic executor product profiles remain inert
until their source terms, target contracts, and deployment manifests are approved.
The [food production runtime](docs/FOOD_PRODUCTION_RUNTIME.md) runs the extracted
Pizza/Taco jobs using registered trusted-host stages. The BuiltHere runtime adds
city-specific acquisition, transformation, review, and database-contract output
stages to that same executor. These trusted-host runtimes are distinct from the
experimental, preview-only broker described below; they are not a sandbox for
untrusted plugins.

## Current scope

- Versioned transport, port, plugin, effect, and profile contracts.
- Ordered-stage definition validation against a structurally valid plugin
  catalog.
- Stable source/observation identity helpers.
- Cross-profile job and preview/apply checkpoint identity helpers.
- A fail-closed, verified apply-authorization context.
- Deployment pinning for the exact definition and profile policy, not only the
  plugin catalog and target.
- Exact source adapter/resource/output/artifact bindings with structured
  per-child terms coverage.
- Broker-owned dataset provenance and retention-expiry contracts.
- Initial product-profile declarations that do not share business policy.
- Metadata-only, exact-byte locks for the app-owned Pizza and Taco boundary
  artifacts. These observations are explicitly separate from activation target
  digests and cannot authorize writes.
- A validation-only general CLI and sanitized example definition.
- A preview-only ordered executor with static reservation preflight and timeout
  signaling.
- Immutable, content-addressed filesystem artifacts and SQLite run state.
- A manifest-verified synthetic-fixture adapter.
- A separately gated read-only shadow executor, with a frozen exact
  profile/definition/catalog/host identity bundle, and an attested PostgreSQL
  snapshot adapter.
- A digest-pinned immutable JSON adapter with broker-owned ephemeral datasets
  for zero-raw-artifact source contracts.
- An executable APizzaMichigan FSQ-shaped fixture preview.
- An APizza-owned, pure two-input legacy-source matcher with synthetic boundary
  goldens and no product-write authority.
- A five-stage APizza FSQ shadow definition: ephemeral FSQ projection,
  normalization, canonical Postgres snapshot, matching, and a receipt-backed
  verifier.
- A fail-closed APizza host runner that composes that definition from an
  owner-only manifest, checked-in source policy and DB contract, dedicated
  read-only DSN, private projection, cross-process lock, and host cancellation.

The repository executes local synthetic previews. It also contains a distinct
non-authoritative shadow runtime that can join one exact host-registered,
bounded FSQ OS release projection to one exact host-configured PostgreSQL view
under a dedicated read-only credential. That shadow runtime does **not** download the upstream
FSQ release, retain a raw source artifact, or write product databases. Real
profiles in the experimental broker have no effect policy or plugin-lock binding.
Production activation is separately controlled through the trusted-host runtime,
private task configuration, scoped database credentials, and deployment checks.

## Known intentional limits

The general CLI currently validates definition/catalog JSON Schema and semantic
wiring only. It does not execute plugins, verify installed package integrity, resolve
and validate each plugin's configuration schema, or load trusted profile and
deployment manifests. `assertApplyReady` defines a fail-closed join contract for
a future apply executor; it is not evidence that the preview executor can apply
or that a deployment is safe to enable. The JSON files under `examples/` remain
shape-validation examples only; the typed APizza fixture command and synthetic
shadow tests are the executable paths in this milestone.

Likewise, the SDK exposes only effect descriptions and secret identifiers. The
broker contract calculates record bounds from broker-owned data, resolves
secrets outside plugin context, stamps source policy and expiry onto finalized
dataset references, and performs the authorized operation. Source reads return
opaque acquisition handles; the broker binds reads to the declared adapter,
requires the adapter's schema identity to match the output declaration, runs a
host-owned validator for that schema version, and derives field names, digests,
and record counts before finalization. The executor mints
an opaque, run-scoped stage invocation from the complete declared input-port
map and exposes only an invocation-bound broker facade to the plugin. Input
writes must name an exact invocation input; output and state writes use
separate, one-shot broker capabilities bound to a staged output or checkpoint
proposal. The executor closes the invocation at its completion/failure boundary, making
cached capabilities unusable; returning while a broker operation is still in
flight fails the stage. Expired inputs are rejected before plugin code runs.
Output receipts are opaque broker-minted values bound to the committed output,
not plugin-authored claims. Stage results have only declared output ports—quarantine is an ordinary
declared output, never a side channel—and the preview executor rejects every
handle absent from its run-scoped broker registry. For zero-raw-retention
contracts, the broker can instead hold a validated source value in memory,
preserve only its snapshot attestation in downstream provenance, and release
the registry-owned value after its last declared consumer or a run failure.
Trusted in-process plugin code necessarily receives a separate value graph
while consuming it; only an isolated worker could forcibly revoke that copy.
The fixture runtime
implements those controls only for approved synthetic reads and preview
artifact writes. The separately constructed read-only shadow runtime also
requires an exact host-owned source grant and matching snapshot attestation; it
still permits no non-preview writes. Both runtimes run plugins in-process with
ambient Node authority and must use trusted plugins; this milestone is not a
security sandbox. The FSQ source policy permits restricted read-only comparison
under a host-pinned manifest; it grants no product-write authority. Broker-mediated
apply execution remains a future milestone. The separate trusted-host path has
process supervision, shared compute admission, external-source adapters, food
worker queues, and product-specific publication adapters; its database access is
restricted by actual task credentials, not by the preview broker.

This repository has no release tags or published packages. Until the first
tag, the untagged `v1alpha1` contract is intentionally mutable and has no
compatibility guarantee; experimental consumers must pin a commit. The first
tagged contract will receive a new API/schema version if its shape differs from
the version documented at that tag.

## Development

Use Node 22.13 or newer within the Node 22 line (the iMac currently runs
Node 22.20), or Node 24. The minimum is explicit because this preview runtime
uses the built-in `node:sqlite` module added in Node 22.13.

```sh
npm install
npm run check
npm test
npm run validate:example
npm run preview:apizza-fsq -- --partition US
```

The preview writes only to the ignored `.map-pipeline/` directory. See
[the preview runtime documentation](docs/PREVIEW_RUNTIME.md) for its guarantees
and intentional limitations.
The PostgreSQL boundary is documented in
[the snapshot-adapter guide](docs/POSTGRES_SNAPSHOT_ADAPTER.md).
The non-authorizing cross-repository contract join is documented in
[the application boundary-lock guide](docs/APP_BOUNDARY_LOCKS.md).
The APizza host composition and remaining activation gate are documented in
[the FSQ shadow host guide](docs/APIZZA_FSQ_SHADOW_HOST.md).
The pure application review-file adapter is documented in
[the APizza review handoff guide](docs/APIZZA_REVIEW_HANDOFF.md).

## Dependency rule

```text
core <- sdk
core <- state/artifact stores
core + sdk <- executor/adapters
executor + adapters <- product profiles
```

Core code never imports a product profile. Profiles may share an adapter, such
as OSM, without sharing configuration, authority, taxonomy, checkpoints, or
target policy.

## Confirmed migration decisions

- The active legacy Taco publisher remains authoritative until an explicit
  no-dual-writer cutover.
- Taco's target contract remains owned by `apizzamichigan` for now.
- BuildHere initially preserves legacy mapper output, including known Ann Arbor
  edge cases; corrections use a later transform version and backfill.
- BuildHere v1 supports field-level manual overrides and uses product-owned
  stored procedures plus PII-free views.
- BuildHere verification changes require a distinct audited reviewer-decision
  event; they are not generic field overrides.
- No out-of-band production Project edits were reported, so no override seed
  import is planned; a read-only pre-apply drift audit still fails closed.
- Ann Arbor is the first preview-only BuildHere vertical slice.
- Source retention follows [the source-data policy](docs/SOURCE_DATA_POLICY.md).

## License

Code and documentation are licensed under Apache-2.0. The generated synthetic
fixture identified as `CC0-1.0` in `fixtures/manifest.json` is dedicated under
that fixture-specific license; no third-party source data is included.
