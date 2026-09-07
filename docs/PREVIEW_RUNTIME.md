# Preview runtime

The first executable extraction slice is intentionally non-production. It
proves that the shared repository can run an ordered workflow with durable
state and artifacts while every real product profile remains fail-closed.

## Included

- An ordered, preview-only executor.
- Exact plugin-manifest matching against the supplied catalog.
- Static, per-run reservation checks for CPU, RSS, child processes, disk
  watermark, and the candidate's configured admission group.
- One active run per executor instance, plus per-stage wall-time abort
  signaling and draining of in-flight broker calls before durable failure. A
  plugin that returns with a broker call still in flight fails its stage.
- A run-scoped broker registry for all dataset handles.
- A fixture runtime with broker-authorized `fixture://` reads and
  `preview://` artifact writes only.
- A separately constructed read-only shadow runtime with exact host-owned
  source grants, snapshot attestations, and the same `preview://`-only output
  boundary.
- Immutable content-addressed JSON objects and manifests.
- SQLite run, stage-attempt, and profile/mode-bound checkpoint state.
- A fixture reader that accepts only manifest-listed, synthetic, PII-free,
  redistribution-reviewed inputs with matching file digests.
- Adapter-identity dispatch plus host-owned payload validators for every
  versioned output schema.
- Broker-minted, registry-backed delivery receipts tied to the exact committed
  output port and content digest.

The executable APizzaMichigan slice models the existing FSQ input shape:

```text
synthetic FSQ-shaped fixture
  -> APizza-specific normalization and routing
  -> immutable candidate artifact
  -> verified preview report receipt
```

Run it with:

```sh
npm run preview:apizza-fsq -- --partition US
```

Use `--runtime-root <path>` to keep state and artifacts elsewhere. Disk
admission is measured on the filesystem that contains that runtime root. The default
is `.map-pipeline/apizza-fsq-preview`, which is excluded from Git and the public
repository audit.

## Safety boundary

The fixture executor rejects network reads, state effects requested by plugins,
evidence/review/canonical/public writes, secrets, non-`fixture://` source
bindings, and non-`preview://` outputs before starting a run. The read-only
shadow executor permits network or artifact reads only when one exact
host-owned grant matches the stage, adapter, policy binding, logical resource,
operation, record cap, partition, and expected snapshot attestation. It rejects
the same state and non-preview writes. Neither executor passes its run ledger or
resolved credentials to plugins.

Shadow artifacts are explicitly marked `preview_source`, carry the shadow
runtime-policy digest and source-snapshot descriptor, and have no approved
profile-policy stamps. This makes the non-authoritative boundary machine
checkable: apply readiness cannot accept them as production source evidence.

Plugins are trusted, in-process Node.js code in this milestone. They retain
ambient process authority and can bypass the broker by importing Node APIs;
the broker restrictions are therefore correctness controls, not a sandbox.
Do not load third-party or untrusted plugins, and do not treat this runtime as
safe for a real deployment until out-of-process execution and OS-level
credential/environment isolation exist.

The fixture source is not a legal approval for Foursquare data and contains no
Foursquare records. It exists to exercise APizza-specific mapping and routing.
The real `apizza-fsq-v1` source policy therefore remains pending, forbidden,
and deployment-disabled.

## Not yet implemented

- Real FSQ, Wikidata, ArcGIS, OSM, Overture, ATP, or website acquisition.
- Installed-package integrity verification or plugin configuration-schema loading.
- Out-of-process plugin supervision and scrubbed environments.
- Hard process termination for a plugin that ignores its abort signal.
- A host-wide or cross-process admission lease shared by executor instances.
- Streaming JSON serialization or an isolated heap limit. `maxArtifactBytes`
  prevents oversized disk writes, but canonicalization still occurs in process
  memory before the byte count is known.
- Restart/resume from a partially completed run.
- Durable job workers, claims, heartbeats, retries, or cancellation recovery.
- Artifact garbage collection, backup, and restore rehearsal.
- A complete APizza shadow definition, terminal verified match report, and
  independently captured record-by-record legacy parity evidence. The pure
  APizza matcher and its synthetic source-audited goldens are implemented.
- Evidence, review, canonical, or public database sinks.
- Apply mode.

These are migration gates, not optional polish. No iMac launchd service points
at this repository yet. The PostgreSQL shadow boundary and its provisioning
requirements are described in `docs/POSTGRES_SNAPSHOT_ADAPTER.md`; activation
still requires the remaining gate in the extraction RFC.
