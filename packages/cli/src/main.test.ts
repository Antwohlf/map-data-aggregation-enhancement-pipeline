import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("malformed definitions fail as schema issues without a stack trace", async () => {
  const directory = await mkdtemp(join(tmpdir(), "map-pipeline-cli-"));
  const definition = join(directory, "definition.json");
  await writeFile(definition, "{}\n", "utf8");
  const main = fileURLToPath(new URL("./main.ts", import.meta.url));
  const catalog = fileURLToPath(
    new URL("../../../examples/plugin-catalog.json", import.meta.url),
  );
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      main,
      "validate",
      "--definition",
      definition,
      "--catalog",
      catalog,
    ],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /definition/);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});
