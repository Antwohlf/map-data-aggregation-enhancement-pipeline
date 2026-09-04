# Map Data Aggregation and Enhancement Pipeline

[![CI](https://github.com/Antwohlf/map-data-aggregation-enhancement-pipeline/actions/workflows/ci.yml/badge.svg)](https://github.com/Antwohlf/map-data-aggregation-enhancement-pipeline/actions/workflows/ci.yml)

Pre-alpha extraction scaffold for reusable, profile-driven map data pipelines.
The runtime mechanics are shared; source authority, transformations, review
policy, and destination mappings remain owned by the APizzaMichigan,
TacoboutMichigan, and BuildHere.city profiles.

This is a public, Apache-2.0-licensed repository. It contains no production
credentials or runtime state. All real product profiles remain inert until
their source terms, target contracts, and deployment manifests are approved.

## Current scope

- Versioned transport, port, plugin, effect, and profile contracts.
- Ordered-stage definition validation against a structurally valid plugin
  catalog.
- Stable source/observation identity helpers.
- Cross-profile job and preview/apply checkpoint identity helpers.
- A fail-closed, verified apply-authorization context.
- Initial product-profile declarations that do not share business policy.
- A validation-only CLI and sanitized example definition.

The scaffold does **not** execute plugins or write databases. Real profiles have
no effect policy or plugin-lock binding. The existing application pipelines
remain authoritative until source-by-source cutover gates and rollback
rehearsals pass.

## Known intentional limits

The CLI currently validates definition/catalog JSON Schema and semantic wiring
only. It does not execute plugins, verify installed package integrity, resolve
and validate each plugin's configuration schema, or load trusted profile and
deployment manifests. `assertApplyReady` defines a fail-closed join contract for
a future executor; it is not evidence that an executor exists or that a
deployment is safe to enable. A separately verified preview execution context
is also a future milestone; the synthetic preview-named sink is definition
validation only.

Likewise, the SDK exposes only effect descriptions and secret identifiers. A
future broker must calculate record bounds from broker-owned data, resolve
secrets outside plugin context, and perform the authorized operation. Real
adapters, transforms, job/state/artifact stores, and sinks are not implemented
in this scaffold.

## Development

Use Node 22, matching the preferred iMac worker baseline.

```sh
npm install
npm run check
npm test
npm run validate:example
```

## Dependency rule

`core <- sdk <- profiles/adapters/cli`

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
- Ann Arbor is the first preview-only BuildHere vertical slice.
- Source retention follows [the source-data policy](docs/SOURCE_DATA_POLICY.md).

## License

Code and documentation are licensed under Apache-2.0. The generated synthetic
fixture identified as `CC0-1.0` in `fixtures/manifest.json` is dedicated under
that fixture-specific license; no third-party source data is included.
