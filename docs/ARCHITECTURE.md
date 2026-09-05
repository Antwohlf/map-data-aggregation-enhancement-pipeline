# Architecture

The shared unit is an execution contract, not a universal map entity.

```text
external scheduler
  -> profile planner
  -> ordered, locked plugins
  -> immutable durability boundaries
  -> profile-owned review or target adapter
```

Human review separates discovery and publication into two workflows. Delivery
is at least once, so writable sinks must be transactional and idempotent. A
source acquisition checkpoint advances only after its artifact is finalized;
a delivery watermark advances only after all required sinks verify receipts.

Every plugin runs as supervised trusted code with a scrubbed environment. That
is process isolation, not a security sandbox. The runtime broker authorizes
effects, while database roles/functions, OS credential access, and deployment
identity enforce the boundary outside the plugin process.

A pipeline definition requests effects. A product profile states policy, and a
trusted deployment manifest grants the exact profile, stage, identity,
resource, operations, and bound. Those documents must agree before apply mode
is possible. The deployment pins canonical digests of the exact definition,
profile policy, plugin catalog, target contract, and host policy. The
authorization context recomputes those digests, then snapshots and freezes all
five documents; a caller cannot swap a same-ID profile policy after readiness.
Host limits and admission groups come from one host-owned policy shared by
every profile on that machine. Plugins do not provide the record count used for
authorization; the broker derives it from broker-owned dataset metadata or the
completed operation. Plugin context contains secret identifiers, never
resolved secret values.

Job identity includes profile, pipeline and version, task, plugin and version,
entity, and mode. Checkpoint identity also includes stage, source namespace,
target, partition, and a distinct preview/apply mode. This prevents a shared
OSM record or a plugin upgrade from aliasing work across Pizza and Taco.

Each source stage binds its declared adapter, exact read effect and operations,
every output port, artifact class, and observed child dataset to a profile-owned
source policy. Every source read must have exactly one binding, and every
source output must appear in exactly one binding. Source plugins are leaf
acquisition nodes and cannot accept pipeline inputs; enrichment belongs in a
separate transform so parent restrictions cannot be dropped. Apply readiness
checks only policies referenced by that pipeline, so one approved vertical
slice is not blocked by unrelated pending sources.
Unknown, cross-profile, adapter-mismatched, resource-mismatched, unlabeled,
over-retained, or incompletely licensed outputs fail closed. Per-child sources
must map every observed child identity to its own terms reference.

The broker, rather than the plugin, mints each `DatasetRef`. An authorized read
returns an opaque acquisition handle. The broker derives observed child IDs,
schema, payload field names, digests, and record counts while staging the
artifact, then copies the approved policy ID, adapter, effect, operations,
resource, output port, child identities, profile ID, policy version/digest,
artifact class, restrictions, and calculated expiry into the final reference.
Runtime consumers validate every output through the frozen authorization
context and reject an unregistered handle or a reference that does not
reproduce the declared binding and output schema or conform to the source
allowed-field list. Quarantine is a normal declared output port and has no
separate `StageResult` escape hatch.

Before invoking any plugin, the executor resolves the exact declared
input-port-to-registered-handle map and mints an opaque, context-owned stage
invocation with explicit run and stage-run identities. Missing, extra,
wrong-producer, foreign-profile, stale-policy, noncanonical-retention, and
expired inputs are rejected. The plugin receives an invocation-bound broker
facade and cannot select an invocation on individual calls. The executor closes
the invocation in a `finally` boundary, so cached broker operations and
capabilities cannot be replayed. Transform and review staging/finalization
accepts only that invocation, never a plugin-supplied parent list. The broker
therefore preserves the complete source-policy ancestry, earliest expiry, most
restrictive redistribution decision, and union of attribution requirements.
Consumer mutations (`canonical.write` and `public.write`) require a registered
input belonging to the same invocation. Artifact, evidence, and review writes
use a separate one-shot capability bound to the invocation, declared output
port, and broker-owned staged artifact. State writes use a one-shot capability
bound to a broker-owned checkpoint proposal digest. `public.write` re-resolves
every ancestry stamp against the frozen current profile and rejects unrelated,
expired, malformed, foreign, stale, revoked, or redistribution-forbidden
subjects even when the effect grant itself exists.

Source/plugin bindings allow only `raw`, `derived`, and `review_evidence`.
These classes always expire within both the effective source limit and the
provisional class ceiling. Plugins cannot emit `audit_metadata`; only the broker
may mint non-expiring audit metadata with the fixed
`mapdata.broker-audit-metadata@1` schema, exact minimal field set, restricted
artifact policy, and no source payload ancestry. The provisional retention
ceiling is separate from effective approval.

Profile declarations in this scaffold are deliberately inert. Execution,
state-store, job-store, artifact-store, and production adapter implementations
are later milestones.
