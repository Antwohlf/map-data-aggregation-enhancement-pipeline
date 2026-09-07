import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { apizzaMichiganProfile } from "./apizzamichigan/src/index.js";
import { tacoBoutMichiganProfile } from "./tacoboutmichigan/src/index.js";

async function readLock(relative: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(new URL(relative, import.meta.url), "utf8")) as Record<string, any>;
}

test("app boundary locks remain inert, exact, and profile-scoped", async () => {
  const entries = [
    {
      path: "./apizzamichigan/contracts/app-boundary-lock.v1.json",
      profile: apizzaMichiganProfile,
    },
    {
      path: "./tacoboutmichigan/contracts/app-boundary-lock.v1.json",
      profile: tacoBoutMichiganProfile,
    },
  ] as const;

  const locks = [];
  for (const entry of entries) {
    const lock = await readLock(entry.path);
    locks.push(lock);
    const observed = entry.profile.observedTargetContract;
    assert(observed);
    assert.deepEqual(Object.keys(lock).sort(), [
      "activationEligible", "artifacts", "entity", "lockSchemaVersion", "profile",
      "redistribution", "sourceRepository", "sourceRevision", "sourceVisibilityAtObservation",
    ].sort());
    assert.equal(lock.lockSchemaVersion, 1);
    assert.equal(lock.activationEligible, false);
    assert.equal(lock.redistribution, "metadata-only-source-artifacts-not-vendored");
    assert.equal(lock.sourceRepository, observed.ownerRepository);
    assert.equal(lock.sourceRevision, observed.source.revision);
    assert.equal(lock.profile, observed.profile);
    assert.equal(lock.entity, observed.entity);
    assert.equal(lock.artifacts.targetContract.path, observed.source.path);
    assert.equal(lock.artifacts.targetContract.byteLength, observed.byteLength);
    assert.equal(lock.artifacts.targetContract.rawByteDigest, observed.rawByteDigest);
    assert.equal(lock.artifacts.targetContract.digestKind, observed.source.digestKind);
    assert.equal(lock.artifacts.targetContract.name, observed.contractName);
    assert.equal(lock.artifacts.targetContract.version, observed.version);
    assert.equal(entry.profile.targetContract.digest, null);
    assert.equal(entry.profile.targetContract.digestKind, "sha256-canonical-json-v1");
    assert.deepEqual(entry.profile.targetContract.supportedVersions, []);
  }

  assert.equal(
    locks[0]!.artifacts.boundaryConfig.rawByteDigest,
    locks[1]!.artifacts.boundaryConfig.rawByteDigest,
  );
  assert.equal(
    locks[0]!.artifacts.statusSchema.rawByteDigest,
    locks[1]!.artifacts.statusSchema.rawByteDigest,
  );
  assert.notEqual(
    locks[0]!.artifacts.targetContract.rawByteDigest,
    locks[1]!.artifacts.targetContract.rawByteDigest,
  );
});
