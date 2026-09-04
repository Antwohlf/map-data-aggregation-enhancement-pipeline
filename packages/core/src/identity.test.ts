import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalize,
  createCheckpointKey,
  createJobKey,
  createObservationId,
  createSourceRecordKey,
  digest,
} from "./identity.js";

test("canonicalization ignores object key insertion order", () => {
  assert.equal(
    canonicalize({ b: 2, a: { d: 4, c: 3 } }),
    canonicalize({ a: { c: 3, d: 4 }, b: 2 }),
  );
});

test("source keys isolate profile and source namespace", () => {
  const pizza = createSourceRecordKey({
    profile: "apizzamichigan",
    sourceNamespace: "osm",
    externalId: "node/42",
  });
  const taco = createSourceRecordKey({
    profile: "tacoboutmichigan",
    sourceNamespace: "osm",
    externalId: "node/42",
  });
  const otherSource = createSourceRecordKey({
    profile: "apizzamichigan",
    sourceNamespace: "wikidata",
    externalId: "node/42",
  });

  assert.notEqual(pizza, taco);
  assert.notEqual(pizza, otherSource);
});

test("observation IDs change with content, not object key order", () => {
  const sourceRecordKey = "srk_example";
  const first = createObservationId({
    sourceRecordKey,
    payload: { name: "Example", address: { city: "Detroit", number: 10 } },
  });
  const reordered = createObservationId({
    sourceRecordKey,
    payload: { address: { number: 10, city: "Detroit" }, name: "Example" },
  });
  const changed = createObservationId({
    sourceRecordKey,
    payload: { name: "Changed" },
  });

  assert.equal(first, reordered);
  assert.notEqual(first, changed);
});

test("canonical ordering has a cross-runtime golden vector", () => {
  const value = { é: 1, z: 2, a: 3 };
  assert.equal(canonicalize(value), '{"a":3,"z":2,"é":1}');
  assert.equal(
    digest(value),
    "sha256:fa7ddcf43923b2711f2f592f210e5ab9e4a54a3b2df09830d93f402391a33e4e",
  );
});

test("identity parts must be explicit normalized values", () => {
  for (const externalId of ["", " id", "id ", "e\u0301"]) {
    assert.throws(() =>
      createSourceRecordKey({
        profile: "builthere-city",
        sourceNamespace: "detroit-bseed",
        externalId,
      }),
    );
  }
});

test("same external ID remains distinct across BuildHere sources", () => {
  const detroit = createSourceRecordKey({
    profile: "builthere-city",
    sourceNamespace: "detroit-bseed",
    externalId: "42",
  });
  const annArbor = createSourceRecordKey({
    profile: "builthere-city",
    sourceNamespace: "ann-arbor-plancases",
    externalId: "42",
  });
  assert.notEqual(detroit, annArbor);
});

test("job keys isolate profile and plugin-version work", () => {
  const base = {
    pipeline: "food-discovery",
    pipelineVersion: 1,
    task: "classify",
    pluginId: "food-classifier",
    pluginVersion: "1.0.0",
    entityKey: "openstreetmap:node/42",
    mode: "apply" as const,
  };
  const pizza = createJobKey({ ...base, profile: "apizzamichigan" });
  const taco = createJobKey({ ...base, profile: "tacoboutmichigan" });
  const reprocess = createJobKey({
    ...base,
    profile: "apizzamichigan",
    pluginVersion: "2.0.0",
  });

  assert.notEqual(pizza, taco);
  assert.notEqual(pizza, reprocess);
});

test("preview and apply checkpoints cannot alias", () => {
  const base = {
    profile: "apizzamichigan",
    pipeline: "food-discovery",
    pipelineVersion: 1,
    stageId: "osm-source",
    pluginId: "osm",
    pluginVersion: "1.0.0",
    sourceNamespace: "openstreetmap",
    target: "apizza-production",
    partition: "MI",
  };
  assert.notEqual(
    createCheckpointKey({ ...base, mode: "preview" }),
    createCheckpointKey({ ...base, mode: "apply" }),
  );
});

test("identity wrappers have stable golden values and cross-profile checkpoints", () => {
  const sourceRecordKey = createSourceRecordKey({
    profile: "apizzamichigan",
    sourceNamespace: "openstreetmap",
    externalId: "node/42",
  });
  assert.equal(
    sourceRecordKey,
    "srk_4d24323945d86b27efedf166ae48da827c5829749878caef3167bd5509a6922b",
  );
  assert.equal(
    createObservationId({
      sourceRecordKey,
      payload: { name: "Example", address: { city: "Detroit", number: 10 } },
      sourceRevision: "2026-09-04",
    }),
    "obs_0642df819734884c63fd178a7fd26a51a7e31cbb7c7a806dba4b462507124ba7",
  );
  assert.equal(
    createJobKey({
      profile: "apizzamichigan",
      pipeline: "food-discovery",
      pipelineVersion: 1,
      task: "classify",
      pluginId: "food-classifier",
      pluginVersion: "1.0.0",
      entityKey: "openstreetmap:node/42",
      mode: "apply",
    }),
    "job_de247447ad55d38b1a78468d281413a76b8e00a97560502f291edd52270f1a32",
  );

  const checkpointBase = {
    pipeline: "food-discovery",
    pipelineVersion: 1,
    stageId: "osm-source",
    pluginId: "osm",
    pluginVersion: "1.0.0",
    sourceNamespace: "openstreetmap",
    partition: "MI",
    mode: "apply" as const,
  };
  const pizzaCheckpoint = createCheckpointKey({
    ...checkpointBase,
    profile: "apizzamichigan",
    target: "apizza-production",
  });
  const tacoCheckpoint = createCheckpointKey({
    ...checkpointBase,
    profile: "tacoboutmichigan",
    target: "taco-production",
  });
  assert.equal(
    pizzaCheckpoint,
    "chk_324ec8a5a9858a2ab8c5030eb8d3f98031c0aca537233d5ba79be1ccfd3d4309",
  );
  assert.equal(
    tacoCheckpoint,
    "chk_80de1295ccfd4963a8a8ddc99a0f3b43104a873c21f70c2c891da7fb6a3eed4e",
  );
  assert.notEqual(pizzaCheckpoint, tacoCheckpoint);
});
