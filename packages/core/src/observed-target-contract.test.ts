import assert from "node:assert/strict";
import test from "node:test";

import {
  ObservedTargetContractError,
  assertObservedTargetContractReference,
  computeObservedTargetContractRawDigest,
  verifyObservedJsonArtifact,
  verifyObservedTargetContractArtifact,
} from "./observed-target-contract.js";
import type { ObservedTargetContractReference } from "./types.js";

function contract(overrides: Record<string, unknown> = {}) {
  return {
    contractSchemaVersion: 1,
    name: "pizza-target",
    version: 1,
    ownerRepository: "example/app",
    profile: "pizza-profile",
    entity: "pizza",
    partition: "configured-regions",
    logicalResourceUri: "app-contract://pizza-profile/pizza/public-mirror",
    effectClass: "public-mirror",
    authority: "application-owned-output-boundary",
    deployment: { externalApplyEnabled: false, verifiedOnProduction: false },
    externalAuthorization: {
      enabled: false,
      requiredPrincipal: "map_pipeline_pizza_writer",
      allowedEffects: [],
      allowedOperations: [],
    },
    productSpecific: { table: "pizza_places" },
    ...overrides,
  };
}

function reference(bytes: Uint8Array | string): ObservedTargetContractReference {
  return {
    ownerRepository: "example/app",
    contractName: "pizza-target",
    version: 1,
    profile: "pizza-profile",
    entity: "pizza",
    rawByteDigest: computeObservedTargetContractRawDigest(bytes),
    byteLength: Buffer.byteLength(bytes),
    activationEligible: false,
    source: {
      repository: "example/app",
      revision: "a".repeat(40),
      path: "contracts/pizza-target.v1.json",
      digestKind: "sha256-raw-bytes-v1",
    },
  };
}

test("verifies exact inert bytes and delegates product-specific shape", () => {
  const bytes = `${JSON.stringify(contract(), null, 2)}\n`;
  let validated = false;
  const verified = verifyObservedTargetContractArtifact({
    bytes,
    reference: reference(bytes),
    validateDocument(document) {
      assert.deepEqual(Object.keys(document).sort(), [
        "authority", "contractSchemaVersion", "deployment", "effectClass", "entity",
        "externalAuthorization", "logicalResourceUri", "name", "ownerRepository",
        "partition", "productSpecific", "profile", "version",
      ].sort());
      validated = true;
    },
  });
  assert.equal(validated, true);
  assert.equal(verified.entity, "pizza");
  assert(Object.isFrozen(verified.productSpecific));
});

test("freezes verified generic JSON before a product validator can observe it", () => {
  const bytes = JSON.stringify(contract());
  const verified = verifyObservedJsonArtifact({
    bytes,
    binding: reference(bytes),
  });
  assert(Object.isFrozen(verified));
  assert(Object.isFrozen(verified.externalAuthorization));
  assert.throws(
    () => {
      (verified.externalAuthorization as { enabled: boolean }).enabled = true;
    },
    TypeError,
  );
});

test("rejects every exact-byte mutation before parsing", () => {
  const bytes = `${JSON.stringify(contract(), null, 2)}\n`;
  const pinned = reference(bytes);
  const mutations = [
    bytes.slice(0, -1),
    bytes.replaceAll("\n", "\r\n"),
    `\ufeff${bytes}`,
    ` ${bytes}`,
    `${JSON.stringify({ ...contract(), name: "pizza-target" })}\n`,
    bytes.slice(0, -8),
  ];
  for (const changed of mutations) {
    assert.throws(
      () => verifyObservedTargetContractArtifact({ bytes: changed, reference: pinned }),
      /pinned length and digest/,
    );
  }
});

test("rejects malformed JSON and duplicate keys even when their bytes are pinned", () => {
  for (const bytes of [
    "{",
    '{"contractSchemaVersion":1,"name":"pizza-target","name":"duplicate"}',
    '{"contractSchemaVersion":1,"name":"pizza-target","\\u006eame":"duplicate"}',
  ]) {
    assert.throws(
      () => verifyObservedTargetContractArtifact({ bytes, reference: reference(bytes) }),
      ObservedTargetContractError,
    );
  }
});

test("rejects swapped product identities and authorization activation", () => {
  const cases = [
    contract({ profile: "taco-profile" }),
    contract({ entity: "taco" }),
    contract({ ownerRepository: "attacker/app" }),
    contract({ name: "taco-target" }),
    contract({ version: 2 }),
    contract({ deployment: { externalApplyEnabled: false, verifiedOnProduction: true } }),
    contract({
      deployment: { externalApplyEnabled: true, verifiedOnProduction: false },
      externalAuthorization: {
        enabled: true,
        requiredPrincipal: "map_pipeline_pizza_writer",
        allowedEffects: ["public.write"],
        allowedOperations: ["upsert"],
      },
    }),
    contract({
      externalAuthorization: {
        enabled: false,
        requiredPrincipal: "service_role",
        allowedEffects: [],
        allowedOperations: [],
      },
    }),
  ];
  for (const value of cases) {
    const bytes = JSON.stringify(value);
    assert.throws(
      () => verifyObservedTargetContractArtifact({ bytes, reference: reference(bytes) }),
      ObservedTargetContractError,
    );
  }
});

test("rejects unsafe source provenance and any activation-eligible observation", () => {
  const bytes = JSON.stringify(contract());
  const base = reference(bytes);
  for (const changed of [
    { ...base, activationEligible: true },
    { ...base, byteLength: 0 },
    { ...base, rawByteDigest: "sha256:bad" },
    { ...base, source: { ...base.source, repository: "example/other" } },
    { ...base, source: { ...base.source, revision: "main" } },
    { ...base, source: { ...base.source, path: "../contract.json" } },
    { ...base, source: { ...base.source, digestKind: "canonical-json" } },
  ]) {
    assert.throws(
      () => assertObservedTargetContractReference(changed as ObservedTargetContractReference),
      ObservedTargetContractError,
    );
  }
});

test("rejects invalid UTF-8 after exact byte verification", () => {
  const bytes = Uint8Array.from([0xff, 0xfe]);
  assert.throws(
    () => verifyObservedTargetContractArtifact({ bytes, reference: reference(bytes) }),
    /valid UTF-8/,
  );
});
