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
is possible. The trusted plugin-catalog and host-policy digests are computed
from their canonical contents during that join; a caller cannot supply a digest
claim separately. Host limits and admission groups come from one host-owned
policy shared by every profile on that machine. Plugins do not provide the
record count used for authorization; the future broker derives it from
broker-owned dataset metadata or the completed operation. Plugin context
contains secret identifiers, never resolved secret values.

Job identity includes profile, pipeline and version, task, plugin and version,
entity, and mode. Checkpoint identity also includes stage, source namespace,
target, partition, and a distinct preview/apply mode. This prevents a shared
OSM record or a plugin upgrade from aliasing work across Pizza and Taco.

Source plugins bind explicit profile-owned source-policy IDs. Apply readiness
checks only policies referenced by that pipeline, so one approved vertical
slice is not blocked by unrelated pending sources. Unknown, cross-profile,
pending, over-retained, or incompletely licensed policy references fail closed.
The provisional retention ceiling is separate from effective approval.

Profile declarations in this scaffold are deliberately inert. Execution,
state-store, job-store, artifact-store, and production adapter implementations
are later milestones.
