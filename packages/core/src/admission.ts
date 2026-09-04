import type { ResourceReservation } from "./types.js";

export interface HostAdmissionLimits {
  maxCpuUnits: number;
  maxRssBytes: number;
  maxChildProcesses: number;
  minFreeDiskBytes: number;
  groups: Readonly<Record<string, { maxConcurrency: number }>>;
}

export interface AdmissionDecision {
  admitted: boolean;
  reasons: string[];
}

export function evaluateAdmission(input: {
  limits: HostAdmissionLimits;
  active: readonly ResourceReservation[];
  candidate: ResourceReservation;
  observedFreeDiskBytes: number;
}): AdmissionDecision {
  const { limits, active, candidate, observedFreeDiskBytes } = input;
  const reasons: string[] = [];
  for (const [name, value] of Object.entries({
    maxCpuUnits: limits.maxCpuUnits,
    maxRssBytes: limits.maxRssBytes,
    maxChildProcesses: limits.maxChildProcesses,
    minFreeDiskBytes: limits.minFreeDiskBytes,
    observedFreeDiskBytes,
  })) {
    if (!Number.isSafeInteger(value) || value < 0) {
      reasons.push(`${name} must be a non-negative safe integer`);
    }
  }
  for (const [name, value] of Object.entries(candidate)) {
    if (name === "admissionGroup") continue;
    if (!Number.isSafeInteger(value) || value < 0) {
      reasons.push(`candidate ${name} must be a non-negative safe integer`);
    }
  }
  active.forEach((reservation, index) => {
    if (!reservation.admissionGroup || !limits.groups[reservation.admissionGroup]) {
      reasons.push(`active[${index}] has an unknown admission group`);
    }
    for (const [name, value] of Object.entries(reservation)) {
      if (name === "admissionGroup") continue;
      if (!Number.isSafeInteger(value) || value < 0) {
        reasons.push(
          `active[${index}] ${name} must be a non-negative safe integer`,
        );
      }
    }
  });
  const group = limits.groups[candidate.admissionGroup];
  if (!group) {
    reasons.push(`unknown admission group ${candidate.admissionGroup}`);
  } else {
    if (!Number.isSafeInteger(group.maxConcurrency) || group.maxConcurrency <= 0) {
      reasons.push(`admission group ${candidate.admissionGroup} has an invalid limit`);
    }
    const activeInGroup = active.filter(
      (reservation) => reservation.admissionGroup === candidate.admissionGroup,
    ).length;
    if (activeInGroup >= group.maxConcurrency) {
      reasons.push(`admission group ${candidate.admissionGroup} is full`);
    }
  }

  const totalCpu = active.reduce((sum, item) => sum + item.maxCpuUnits, 0);
  const totalRss = active.reduce((sum, item) => sum + item.maxRssBytes, 0);
  const totalChildren = active.reduce(
    (sum, item) => sum + item.maxChildProcesses,
    0,
  );
  if (![totalCpu, totalRss, totalChildren].every(Number.isSafeInteger)) {
    reasons.push("active reservation totals must be safe integers");
  }
  if (candidate.maxCpuUnits > limits.maxCpuUnits) {
    reasons.push("candidate CPU reservation exceeds host limit");
  }
  if (candidate.maxRssBytes > limits.maxRssBytes) {
    reasons.push("candidate RSS reservation exceeds host limit");
  }
  if (candidate.maxChildProcesses > limits.maxChildProcesses) {
    reasons.push("candidate child-process reservation exceeds host limit");
  }
  if (totalCpu + candidate.maxCpuUnits > limits.maxCpuUnits) {
    reasons.push("CPU reservation exceeds host limit");
  }
  if (totalRss + candidate.maxRssBytes > limits.maxRssBytes) {
    reasons.push("RSS reservation exceeds host limit");
  }
  if (totalChildren + candidate.maxChildProcesses > limits.maxChildProcesses) {
    reasons.push("child-process reservation exceeds host limit");
  }

  const requiredFreeDisk = Math.max(
    limits.minFreeDiskBytes,
    candidate.minFreeDiskBytes,
    ...active.map((reservation) => reservation.minFreeDiskBytes),
  );
  const reservedArtifactBytes = active.reduce(
    (sum, reservation) => sum + reservation.maxArtifactBytes,
    candidate.maxArtifactBytes,
  );
  if (observedFreeDiskBytes - reservedArtifactBytes < requiredFreeDisk) {
    reasons.push("artifact reservation would cross the free-disk watermark");
  }

  return { admitted: reasons.length === 0, reasons };
}
