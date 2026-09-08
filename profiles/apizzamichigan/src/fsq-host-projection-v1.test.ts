import assert from "node:assert/strict";
import test from "node:test";
import { projectApizzaFsqHostRowsV1 } from "./fsq-host-projection-v1.js";
import { validateApizzaFsqReleaseRowsV1 } from "./fsq-release-v1.js";

const base = {
  fsq_place_id: "synthetic-place", name: "Synthetic Pizza", latitude: 42, longitude: -83,
  address: " 1 Example Street ", locality: null, region: "MI", postcode: " ", country: "US",
  tel: null, website: null, fsq_category_ids: null, fsq_category_labels: null,
  date_closed: null, unresolved_flags: null,
};

test("projects only approved fields without mutating the source", () => {
  const source = { ...base, email: "synthetic@example.test", instagram: "synthetic", geom: "unused" };
  const result = projectApizzaFsqHostRowsV1([source]);
  assert.deepEqual(result.counts, { input: 1, projected: 1, excludedRemovalOrPrivacy: 0, rejectedInvalid: 0 });
  assert.equal(result.rows[0]?.address, "1 Example Street");
  assert.equal(result.rows[0]?.postcode, null);
  assert.deepEqual(result.rows[0]?.fsq_category_ids, []);
  assert.equal(JSON.stringify(result.rows).includes("synthetic@example.test"), false);
  assert.equal(source.address, base.address);
  validateApizzaFsqReleaseRowsV1(JSON.parse(JSON.stringify(result.rows)));
});

test("excludes removal/privacy records while retaining closure evidence", () => {
  const result = projectApizzaFsqHostRowsV1([
    ...["DELETE", "doesn't-exist", "private venue", "inappropriate"].map(flag => ({ ...base, unresolved_flags: [flag] })),
    { ...base, date_closed: "2026-01-01", unresolved_flags: ["closed", "duplicate"] },
  ]);
  assert.equal(result.counts.excludedRemovalOrPrivacy, 4);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]?.date_closed, "2026-01-01");
  assert.deepEqual(result.rows[0]?.unresolved_flags, ["closed", "duplicate"]);
});

test("counts malformed rows without coercing invalid coordinates or flags", () => {
  const result = projectApizzaFsqHostRowsV1([
    null, { ...base, latitude: "42" }, { ...base, unresolved_flags: "delete" },
    { ...base, fsq_category_ids: [123] }, { ...base, name: " " },
  ]);
  assert.equal(result.counts.rejectedInvalid, 5);
  assert.deepEqual(result.rows, []);
  assert.throws(() => projectApizzaFsqHostRowsV1(Array(5001).fill(null)), /at most 5000/);
});
