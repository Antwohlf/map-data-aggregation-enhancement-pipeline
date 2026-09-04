import assert from "node:assert/strict";
import test from "node:test";

import { evaluateAdmission } from "./admission.js";
import type { ResourceReservation } from "./types.js";

const heavy: ResourceReservation = {
  admissionGroup: "source-heavy",
  maxCpuUnits: 4,
  maxRssBytes: 8_000_000_000,
  maxChildProcesses: 2,
  maxWallTimeMs: 900_000,
  maxArtifactBytes: 2_000_000_000,
  minFreeDiskBytes: 20_000_000_000,
};

const limits = {
  maxCpuUnits: 8,
  maxRssBytes: 24_000_000_000,
  maxChildProcesses: 8,
  minFreeDiskBytes: 20_000_000_000,
  groups: { "source-heavy": { maxConcurrency: 1 } },
};

test("host-wide admission groups serialize heavy work across profiles", () => {
  const decision = evaluateAdmission({
    limits,
    active: [heavy],
    candidate: heavy,
    observedFreeDiskBytes: 100_000_000_000,
  });
  assert.equal(decision.admitted, false);
  assert(decision.reasons.some((reason) => reason.includes("is full")));
});

test("free-disk watermark includes the candidate artifact reservation", () => {
  const decision = evaluateAdmission({
    limits,
    active: [],
    candidate: heavy,
    observedFreeDiskBytes: 21_000_000_000,
  });
  assert.equal(decision.admitted, false);
  assert(decision.reasons.some((reason) => reason.includes("free-disk")));
});

test("disk admission includes active reservations in other groups", () => {
  const other = { ...heavy, admissionGroup: "other" };
  const decision = evaluateAdmission({
    limits: {
      ...limits,
      groups: {
        "source-heavy": { maxConcurrency: 1 },
        other: { maxConcurrency: 1 },
      },
    },
    active: [other],
    candidate: heavy,
    observedFreeDiskBytes: 23_000_000_000,
  });
  assert.equal(decision.admitted, false);
  assert(decision.reasons.some((reason) => reason.includes("free-disk")));
});

test("invalid active reservations fail closed", () => {
  const decision = evaluateAdmission({
    limits,
    active: [{ ...heavy, maxCpuUnits: -100 }],
    candidate: { ...heavy, maxCpuUnits: 9 },
    observedFreeDiskBytes: 100_000_000_000,
  });
  assert.equal(decision.admitted, false);
  assert(
    decision.reasons.some((reason) => reason.includes("active[0] maxCpuUnits")),
  );
  assert(decision.reasons.some((reason) => reason.includes("CPU reservation")));
});
