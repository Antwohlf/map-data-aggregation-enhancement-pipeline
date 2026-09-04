import assert from "node:assert/strict";
import test from "node:test";

import {
  assertEffectAuthorizedInternal,
  EffectDeniedError,
} from "./authorization.js";
import {
  PIPELINE_API_VERSION,
  type EffectAuthorization,
  type StagePluginManifest,
} from "./types.js";

const manifest: StagePluginManifest = {
  id: "example-sink",
  lock: {
    packageName: "@map-pipeline/example-sink",
    packageVersion: "0.0.0-test",
    pluginApiVersion: PIPELINE_API_VERSION,
    integrity: `sha256:${"0".repeat(64)}`,
    configSchema: { name: "example.config", version: 1 },
    configSchemaDigest: `sha256:${"1".repeat(64)}`,
  },
  inputs: {},
  outputs: {},
  policyBinding: "none",
  effects: ["artifact.write", "public.write"],
  delivery: "verified_receipt",
};

const grants: EffectAuthorization[] = [
  {
    profile: "synthetic-test",
    stageId: "sink",
    deploymentIdentity: "fixture-only",
    effectClass: "artifact.write",
    resourceUri: "preview://artifacts/example",
    operations: ["create"],
    maxRecords: 10,
  },
  {
    profile: "synthetic-test",
    stageId: "sink",
    deploymentIdentity: "fixture-only",
    effectClass: "public.write",
    resourceUri: "postgres://example/public_items",
    operations: ["upsert"],
    maxRecords: 2,
    verification: "post_read",
  },
];

test("preview permits only declared and granted preview artifacts", () => {
  assert.doesNotThrow(() =>
    assertEffectAuthorizedInternal({
      mode: "preview",
      profile: "synthetic-test",
      stageId: "sink",
      deploymentIdentity: "fixture-only",
      manifest,
      grants,
      request: {
        effectClass: "artifact.write",
        resourceUri: "preview://artifacts/example",
        operation: "create",
        recordCount: 10,
      },
    }),
  );

  assert.throws(
    () =>
      assertEffectAuthorizedInternal({
        mode: "preview",
        profile: "synthetic-test",
        stageId: "sink",
        deploymentIdentity: "fixture-only",
        manifest,
        grants,
        request: {
          effectClass: "public.write",
          resourceUri: "postgres://example/public_items",
          operation: "upsert",
          recordCount: 1,
        },
      }),
    EffectDeniedError,
  );
});

test("apply enforces exact resources and record limits", () => {
  assert.doesNotThrow(() =>
    assertEffectAuthorizedInternal({
      mode: "apply",
      profile: "synthetic-test",
      stageId: "sink",
      deploymentIdentity: "fixture-only",
      manifest,
      grants,
      request: {
        effectClass: "public.write",
        resourceUri: "postgres://example/public_items",
        operation: "upsert",
        recordCount: 2,
      },
    }),
  );

  assert.throws(
    () =>
      assertEffectAuthorizedInternal({
        mode: "apply",
        profile: "synthetic-test",
        stageId: "sink",
        deploymentIdentity: "fixture-only",
        manifest,
        grants,
        request: {
          effectClass: "public.write",
          resourceUri: "postgres://example/public_items",
          operation: "upsert",
          recordCount: 3,
        },
      }),
    EffectDeniedError,
  );
});

test("broker rejects non-integer and non-finite record counts", () => {
  for (const recordCount of [Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
    assert.throws(
      () =>
        assertEffectAuthorizedInternal({
          mode: "apply",
          profile: "synthetic-test",
          stageId: "sink",
          deploymentIdentity: "fixture-only",
          manifest,
          grants,
          request: {
            effectClass: "public.write",
            resourceUri: "postgres://example/public_items",
            operation: "upsert",
            recordCount,
          },
        }),
      EffectDeniedError,
    );
  }
});
