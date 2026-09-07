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
      assert.equal(source.attributionRef, null);
      assert.equal(source.retentionDays, null);
      assert.deepEqual(source.resourceUris, []);
      assert.deepEqual(source.allowedSchemas, []);
      assert.deepEqual(source.upstreamTerms, []);
      assert(source.provisionalRetention.rawMaxDays <= 30);
      assert(source.provisionalRetention.derivedMaxDays <= 30);
      assert(source.provisionalRetention.reviewEvidenceAfterTerminalDays <= 30);
      if (source.adapter === "official-website") {
        assert.equal(source.provisionalRetention.rawMaxDays, 0);
      }
    }
  }
});

test("Pizza and Taco pin exact app-owned contracts without activating them", () => {
  const expected = [
    {
      profile: apizzaMichiganProfile,
      name: "apizza-pipeline-write-contract",
      path: "contracts/pipeline-targets/apizza-pipeline-write-contract.v1.json",
      digest: "sha256:41a0c211e9f8c474b6487c1b6e4181e2cf8a9db7bc2561de2513a503cdbb96b0",
    },
    {
      profile: tacoBoutMichiganProfile,
      name: "taco-pipeline-write-contract",
      path: "contracts/pipeline-targets/taco-pipeline-write-contract.v1.json",
      digest: "sha256:2820447773a46e6d8a8cb0187a6e329e4241a65632506b3b70055113c9bab21d",
    },
  ] as const;

  for (const item of expected) {
    assert.equal(item.profile.targetContract.ownerRepository, "Antwohlf/apizzamichigan");
    assert.equal(item.profile.targetContract.contractName, item.name);
    assert.deepEqual(item.profile.targetContract.supportedVersions, []);
    assert.equal(item.profile.targetContract.digestKind, "sha256-canonical-json-v1");
    assert.equal(item.profile.targetContract.digest, null);
    assert.equal(item.profile.observedTargetContract?.ownerRepository, "Antwohlf/apizzamichigan");
    assert.equal(item.profile.observedTargetContract?.contractName, item.name);
    assert.equal(item.profile.observedTargetContract?.version, 1);
    assert.equal(item.profile.observedTargetContract?.rawByteDigest, item.digest);
    assert.equal(item.profile.observedTargetContract?.activationEligible, false);
    assert.equal(item.profile.observedTargetContract?.source.repository, "Antwohlf/apizzamichigan");
    assert.equal(item.profile.observedTargetContract?.source.revision, "ecfb0fd57e1a25384a7d81ad78f1e8d16b205728");
    assert.equal(item.profile.observedTargetContract?.source.path, item.path);
    assert.equal(item.profile.observedTargetContract?.source.digestKind, "sha256-raw-bytes-v1");
    assert.equal(item.profile.deploymentEnabled, false);
    assert.deepEqual(item.profile.effectPolicy, []);
  }

  assert.equal(buildHereCityProfile.targetContract.digest, null);
  assert.equal(buildHereCityProfile.targetContract.digestKind, "sha256-canonical-json-v1");
  assert.equal(buildHereCityProfile.observedTargetContract, null);
  assert.deepEqual(buildHereCityProfile.targetContract.supportedVersions, []);
});

test("inert profile declarations are immutable at every level", () => {
  assert(Object.isFrozen(apizzaMichiganProfile));
  assert(Object.isFrozen(apizzaMichiganProfile.sources));
  assert(Object.isFrozen(apizzaMichiganProfile.sources[0]));
  assert(Object.isFrozen(apizzaMichiganProfile.shadowSources));
  assert(Object.isFrozen(apizzaMichiganProfile.shadowSources[0]));
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

test("only APizza owns the implemented shadow source identities", () => {
  assert.deepEqual(
    apizzaMichiganProfile.shadowSources.map((source) => [
      source.stageId,
      source.policyId,
      source.adapter,
      source.activationEligible,
    ]),
    [
      ["fsq-source", "shadow:apizza-fsq-os-places-flatfile-v1", "json-file-snapshot", false],
      ["canonical-source", "shadow:apizza-canonical-read-v1", "postgres-readonly", false],
    ],
  );
  assert.deepEqual(tacoBoutMichiganProfile.shadowSources, []);
  assert.deepEqual(buildHereCityProfile.shadowSources, []);
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
            definitionDigest: `sha256:${"2".repeat(64)}`,
            profilePolicyDigest: `sha256:${"3".repeat(64)}`,
            pluginLockDigest: `sha256:${"0".repeat(64)}`,
            targetContractVersion: 1,
            targetContractDigestKind: "sha256-canonical-json-v1",
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
          definitionDigest: `sha256:${"2".repeat(64)}`,
          profilePolicyDigest: `sha256:${"3".repeat(64)}`,
          pluginLockDigest: `sha256:${"0".repeat(64)}`,
          targetContractVersion: 1,
          targetContractDigestKind: "sha256-canonical-json-v1",
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
