import { readFile } from "node:fs/promises";

import { digest, type CanonicalJson } from "@map-pipeline/core";

const path = process.argv[2];
if (!path) {
  console.error("usage: npm run digest:json -- <path>");
  process.exitCode = 2;
} else {
  const value = JSON.parse(await readFile(path, "utf8")) as CanonicalJson;
  console.log(digest(value));
}
