import assert from "node:assert/strict";
import test from "node:test";

import {
  ApplyNotReadyError,
  PIPELINE_API_VERSION,
  assertApplyReady,
  computeHostPolicyDigest,
  createApplyAuthorizationContext,
  type PipelineDefinition,
} from "@map-pipeline/core";
import { apizzaMichiganProfile } from "./apizzamichigan/src/index.js";
import { buildHereCityProfile } from "./builthere-city/src/index.js";
import { tacoBoutMichiganProfile } from "./tacoboutmichigan/src/index.js";

const profiles = [
  apizzaMichiganProfile,
  tacoBoutMichiganProfile,
  buildHereCityProfile,
];

test("all scaffold profiles are inert and have no write authority", () => {
  for (const profile of profiles) {
    assert.equal(profile.deploymentEnabled, false);
    assert.deepEqual(profile.effectPolicy, []);
    assert.equal(profile.pluginLockDigest, null);
    assert.equal(profile.targetContract.digest, null);
    assert.deepEqual(profile.targetContract.supportedVersions, []);
    for (const source of profile.sources) {
      assert.equal(source.policyStatus, "pending");
      assert.equal(source.artifactPolicy, "forbidden");
      assert.equal(source.termsRef, null);
      assert.equal(source.retentionDays, null);
      assert.deepEqual(source.upstreamTermsRefs, []);
      assert(source.provisionalRetention.rawMaxDays <= 30);
      assert(source.provisionalRetention.derivedMaxDays <= 30);
      assert(source.provisionalRetention.reviewEvidenceAfterTerminalDays <= 30);
      if (source.adapter === "official-website") {
        assert.equal(source.provisionalRetention.rawMaxDays, 0);
      }
    }
  }
});

test("inert profile declarations are immutable at every level", () => {
  assert(Object.isFrozen(apizzaMichiganProfile));
  assert(Object.isFrozen(apizzaMichiganProfile.sources));
  assert(Object.isFrozen(apizzaMichiganProfile.sources[0]));
  assert(Object.isFrozen(apizzaMichiganProfile.targetContract));
  assert(Object.isFrozen(apizzaMichiganProfile.effectPolicy));

  assert.throws(() => {
    (apizzaMichiganProfile as { deploymentEnabled: boolean }).deploymentEnabled = true;
  }, TypeError);
  assert.throws(() => {
    (apizzaMichiganProfile.effectPolicy as unknown[]).push({});
  }, TypeError);
  assert.throws(() => {
    (apizzaMichiganProfile.sources[0] as { policyStatus: string }).policyStatus =
      "approved";
  }, TypeError);
});

test("pizza and taco inventory all live source classes with independent policies", () => {
  assert.deepEqual(
    tacoBoutMichiganProfile.sources.map((source) => source.namespace),
    ["openstreetmap", "foursquare", "overture", "official-website"],
  );
  assert(
    apizzaMichiganProfile.sources.some(
      (source) => source.namespace === "official-website",
    ),
  );
  const pizzaIds = new Set(
    apizzaMichiganProfile.sources.map((source) => source.id),
  );
  for (const source of tacoBoutMichiganProfile.sources) {
    assert(!pizzaIds.has(source.id));
  }
});

const disabledDefinition: PipelineDefinition = {
  apiVersion: PIPELINE_API_VERSION,
  kind: "Pipeline",
  metadata: { name: "cannot-run", version: 1 },
  profile: "placeholder",
  stages: [],
  requiredSinks: [],
  optionalSinks: [],
};

const inertHostPolicy = {
  id: "untrusted-test-host",
  version: 1,
  limits: {
    maxCpuUnits: 1,
    maxRssBytes: 1,
    maxChildProcesses: 1,
    minFreeDiskBytes: 1,
  },
  admissionGroups: {},
};

test("every real scaffold profile rejects apply before evaluating self-requests", () => {
  for (const profile of profiles) {
    assert.throws(
      () =>
        assertApplyReady({
          definition: { ...disabledDefinition, profile: profile.id },
          catalog: {},
          profile,
          deployment: {
            profile: profile.id,
            deploymentIdentity: "untrusted-test",
            enabled: true,
            pluginLockDigest: `sha256:${"0".repeat(64)}`,
            targetContractVersion: 1,
            targetContractDigest: `sha256:${"1".repeat(64)}`,
            effectAuthorizations: [],
            hostPolicyDigest: computeHostPolicyDigest(inertHostPolicy),
            secretProvider: "test_stub",
          },
          hostPolicy: inertHostPolicy,
        }),
      ApplyNotReadyError,
    );
  }
});

test("fabricated grants cannot activate the Taco profile", () => {
  assert.throws(
    () =>
      createApplyAuthorizationContext({
        definition: {
          ...disabledDefinition,
          profile: tacoBoutMichiganProfile.id,
        },
        catalog: {},
        profile: tacoBoutMichiganProfile,
        deployment: {
          profile: tacoBoutMichiganProfile.id,
          deploymentIdentity: "fabricated",
          enabled: true,
          pluginLockDigest: `sha256:${"0".repeat(64)}`,
          targetContractVersion: 1,
          targetContractDigest: `sha256:${"1".repeat(64)}`,
          effectAuthorizations: [
            {
              profile: tacoBoutMichiganProfile.id,
              stageId: "sink",
              deploymentIdentity: "fabricated",
              effectClass: "public.write",
              resourceUri: "postgres://taco/public",
              operations: ["upsert"],
              maxRecords: 1,
              verification: "post_read",
            },
          ],
          hostPolicyDigest: computeHostPolicyDigest(inertHostPolicy),
          secretProvider: "keychain",
        },
        hostPolicy: inertHostPolicy,
      }),
    ApplyNotReadyError,
  );
});
