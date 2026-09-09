# Shared host compute admission

Trusted product runtimes use the same `executeTrustedHostStagesAsync` executor
with product-owned registered nodes. They share expensive host work by setting
the same absolute `PIPELINE_HOST_RESOURCE_ROOT` in their private environment.
Without that setting, local developer runs do not participate in host admission.

`withHostCompute` serializes food source acquisition, individual Ollama requests,
and BuiltHere acquisition. It does not hold the slot for the lifetime of a
continuous classifier, or while a source waits for its next scheduled run.
Small database operations and website serving do not need the slot. This is
cooperative admission, not a CPU or memory sandbox: unrelated programs and
lightweight food maintenance workers are outside it.

The shared directory belongs to the runtime account and must remain private.
Queue tickets identify processes, never source records or credentials. A failed
callback releases its lease. Recovery must not grant a slot while a crashed
worker's child processes could still be using it. Before any manual cleanup,
stop the relevant scheduled jobs and verify their process groups have drained;
never delete a live lease just to make the queue advance.

Production food process supervision terminates the full worker process group
on restart. Product data checkpoints and pending enrichment jobs are separate
from compute admission and must not be restored from an old backup during a
code rollout.
