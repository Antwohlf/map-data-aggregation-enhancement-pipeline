import assert from "node:assert/strict";
import test from "node:test";

import {
  bindLegacyImport,
  queueMutators,
  topologyCutoverIssues,
  type LegacyStateDescriptor,
  type ServiceTopologyEntry,
} from "./migration.js";

const digest = (character: string): string => `sha256:${character.repeat(64)}`;

const checkpoint: LegacyStateDescriptor = {
  kind: "delivery_checkpoint",
  contentDigest: digest("a"),
  schemaVersion: 1,
  sourcePathDigest: digest("b"),
  profile: null,
  target: null,
  referencedArtifacts: [{ contentDigest: digest("f"), relocatable: true }],
};

test("an unscoped legacy checkpoint is bound to an explicit profile and target", () => {
  const bound = bindLegacyImport(checkpoint, {
      kind: "delivery_checkpoint",
      profile: "apizzamichigan",
      target: "apizza-production",
      expectedContentDigest: digest("a"),
      expectedSourcePathDigest: digest("b"),
      supportedSchemaVersions: [1],
    });
  assert.equal(bound.profile, "apizzamichigan");
  assert.equal(bound.target, "apizza-production");
  assert(Object.isFrozen(bound));
  assert(Object.isFrozen(bound.referencedArtifacts));
  assert(Object.isFrozen(bound.referencedArtifacts[0]));
  assert.throws(() => {
    (bound.referencedArtifacts as unknown[]).push({});
  }, TypeError);
  assert.throws(() => {
    (bound.referencedArtifacts[0] as { relocatable: boolean }).relocatable = false;
  }, TypeError);
  assert.throws(() =>
    bindLegacyImport(
      { ...checkpoint, profile: "tacoboutmichigan" },
      {
        kind: "delivery_checkpoint",
        profile: "apizzamichigan",
        target: "apizza-production",
        expectedContentDigest: digest("a"),
        expectedSourcePathDigest: digest("b"),
        supportedSchemaVersions: [1],
      },
    ),
  );
});

test("legacy state cannot be swapped between source paths", () => {
  assert.throws(() =>
    bindLegacyImport(checkpoint, {
      kind: "delivery_checkpoint",
      profile: "tacoboutmichigan",
      target: "taco-production",
      expectedContentDigest: digest("a"),
      expectedSourcePathDigest: digest("c"),
      supportedSchemaVersions: [1],
    }),
  );
});

test("queue quiescence inventory includes reconcilers and retry feeders", () => {
  const makeService = (
    id: string,
    queueRoles: ServiceTopologyEntry["queueRoles"],
  ): ServiceTopologyEntry => ({
    id,
    profile: "shared",
    mode: queueRoles.includes("observer") ? "observe" : "apply",
    desiredSchedule: { kind: "interval", everyMs: 300_000 },
    liveSchedule: { kind: "interval", everyMs: 300_000 },
    desiredState: "present",
    liveState: "loaded",
    definitionPresent: true,
    desiredCommandDigest: digest("d"),
    liveCommandDigest: digest("d"),
    queueRoles,
    queueBindings: queueRoles.includes("observer")
      ? []
      : [
          {
            queueId: "legacy-main",
            storeUri: "sqlite://legacy/jobs",
            lockIdentity: "legacy-main-writer",
            producesTasks: queueRoles.includes("producer") ? ["classify"] : [],
            consumesTasks: queueRoles.some((role) =>
              ["consumer", "reconciler", "retry_feeder"].includes(role),
            )
              ? ["classify"]
              : [],
          },
        ],
    targetWriteScopes: queueRoles.includes("manual_writer")
      ? ["postgres://legacy/review"]
      : [],
    stateRefs: [],
    admissionGroups: [],
    credentialRefs: [],
  });
  const services = [
    makeService("source", ["producer"]),
    makeService("scraper-downstream-producer", ["producer"]),
    makeService("worker", ["consumer"]),
    makeService("reconciler", ["reconciler"]),
    makeService("retry-feeder", ["retry_feeder"]),
    makeService("manual", ["manual_writer"]),
    makeService("status", ["observer"]),
  ];

  assert.deepEqual(
    queueMutators(services).map((service) => service.id),
    [
      "source",
      "scraper-downstream-producer",
      "worker",
      "reconciler",
      "retry-feeder",
      "manual",
    ],
  );
  assert.deepEqual(
    topologyCutoverIssues(services, {
      claimsReconciled: true,
      enqueueRoutingSwitched: true,
      legacyWritersDisabled: true,
    }),
    [],
  );
});

test("topology cutover blocks orphaned services and desired/live drift", () => {
  const orphaned: ServiceTopologyEntry = {
    id: "classifier-reconciler",
    profile: "shared",
    mode: "apply",
    desiredSchedule: { kind: "interval", everyMs: 600_000 },
    liveSchedule: { kind: "interval", everyMs: 300_000 },
    desiredState: "absent",
    liveState: "loaded",
    definitionPresent: false,
    desiredCommandDigest: digest("d"),
    liveCommandDigest: digest("e"),
    queueRoles: ["reconciler"],
    queueBindings: [
      {
        queueId: "legacy-main",
        storeUri: "sqlite://legacy/jobs",
        lockIdentity: "legacy-main-writer",
        producesTasks: [],
        consumesTasks: ["classify"],
      },
    ],
    targetWriteScopes: [],
    stateRefs: [],
    admissionGroups: [],
    credentialRefs: [],
  };
  const issues = topologyCutoverIssues([orphaned], {
    claimsReconciled: false,
    enqueueRoutingSwitched: false,
    legacyWritersDisabled: false,
  });
  assert(issues.some((issue) => issue.includes("schedules differ")));
  assert(issues.some((issue) => issue.includes("loaded but not desired")));
  assert(issues.some((issue) => issue.includes("without a service definition")));
  assert(issues.some((issue) => issue.includes("command digests differ")));
  assert(issues.some((issue) => issue.includes("claims are not reconciled")));
  assert(issues.some((issue) => issue.includes("enqueue routing")));
  assert(issues.some((issue) => issue.includes("legacy writers")));
});

test("topology cutover requires observed schedules and command identities", () => {
  const incomplete: ServiceTopologyEntry = {
    id: "pizza-publisher",
    profile: "apizzamichigan",
    mode: "apply",
    desiredSchedule: null,
    liveSchedule: null,
    desiredState: "present",
    liveState: "loaded",
    definitionPresent: true,
    desiredCommandDigest: null,
    liveCommandDigest: null,
    queueRoles: [],
    queueBindings: [],
    targetWriteScopes: ["postgres://apizza/public"],
    stateRefs: [],
    admissionGroups: ["supabase-publication"],
    credentialRefs: ["apizza-writer"],
  };
  const issues = topologyCutoverIssues([incomplete], {
    claimsReconciled: true,
    enqueueRoutingSwitched: true,
    legacyWritersDisabled: true,
  });
  assert(issues.some((issue) => issue.includes("desired schedule")));
  assert(issues.some((issue) => issue.includes("live schedule")));
  assert(issues.some((issue) => issue.includes("desired command")));
  assert(issues.some((issue) => issue.includes("live command")));
});

test("topology cutover rejects two loaded writers for one target scope", () => {
  const writer = (id: string): ServiceTopologyEntry => ({
    id,
    profile: "apizzamichigan",
    mode: "apply",
    desiredSchedule: { kind: "interval", everyMs: 900_000 },
    liveSchedule: { kind: "interval", everyMs: 900_000 },
    desiredState: "present",
    liveState: "loaded",
    definitionPresent: true,
    desiredCommandDigest: digest("d"),
    liveCommandDigest: digest("d"),
    queueRoles: [],
    queueBindings: [],
    targetWriteScopes: ["postgres://apizza/public"],
    stateRefs: [],
    admissionGroups: ["supabase-publication"],
    credentialRefs: ["apizza-writer"],
  });
  const issues = topologyCutoverIssues(
    [writer("legacy-publisher"), writer("new-publisher")],
    {
      claimsReconciled: true,
      enqueueRoutingSwitched: true,
      legacyWritersDisabled: true,
    },
  );
  assert(issues.some((issue) => issue.includes("both loaded writers")));
});
