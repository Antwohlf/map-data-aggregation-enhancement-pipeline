import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import { pathViolations, textViolations } from "./public-audit-policy.mjs";

const MAX_BUFFER = 64 * 1024 * 1024;

function gitText(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
  });
}

function gitBytes(args) {
  return execFileSync("git", args, { maxBuffer: MAX_BUFFER });
}

function nulList(value) {
  return value.split("\0").filter(Boolean);
}

const indexFiles = nulList(gitText(["ls-files", "--cached", "-z"]));
const untrackedFiles = nulList(
  gitText(["ls-files", "--others", "--exclude-standard", "-z"]),
);
const workingFiles = [...new Set([...indexFiles, ...untrackedFiles])].sort();
const errors = [];
function scanPath(label, path) {
  errors.push(...pathViolations(path).map((violation) => `${label}: ${violation}`));
}

function scanBytes(label, bytes) {
  if (bytes.includes(0)) return;
  const value = bytes.toString("utf8");
  errors.push(...textViolations(value).map((violation) => `${label}: ${violation}`));
}

for (const path of workingFiles) {
  scanPath(`working:${path}`, path);
  try {
    scanBytes(`working:${path}`, await readFile(path));
  } catch (error) {
    if (error?.code !== "ENOENT") errors.push(`working:${path}: unreadable`);
  }
}

for (const path of indexFiles) {
  scanPath(`index:${path}`, path);
  try {
    scanBytes(`index:${path}`, gitBytes(["show", `:${path}`]));
  } catch {
    errors.push(`index:${path}: unreadable staged blob`);
  }
}

const commits = gitText(["rev-list", "--all"])
  .trim()
  .split("\n")
  .filter(Boolean);
for (const commit of commits) {
  const metadata = gitText([
    "show",
    "-s",
    "--format=%an%x00%ae%x00%cn%x00%ce",
    commit,
  ]);
  errors.push(...textViolations(metadata).map(
    (violation) => `${commit}: commit metadata ${violation}`,
  ));
  const paths = nulList(
    gitText(["ls-tree", "-r", "--name-only", "-z", commit]),
  );
  for (const path of paths) {
    scanPath(`${commit}:${path}`, path);
    try {
      scanBytes(`${commit}:${path}`, gitBytes(["show", `${commit}:${path}`]));
    } catch {
      errors.push(`${commit}:${path}: unreadable historical blob`);
    }
  }
}

const manifest = JSON.parse(await readFile("fixtures/manifest.json", "utf8"));
const fixturePaths = workingFiles
  .filter(
    (path) => path.startsWith("fixtures/") && path !== "fixtures/manifest.json",
  )
  .map((path) => path.slice("fixtures/".length));
const declaredPaths = manifest.fixtures.map((fixture) => fixture.path).sort();
if (JSON.stringify(fixturePaths.sort()) !== JSON.stringify(declaredPaths)) {
  errors.push("fixtures/manifest.json: fixture paths are missing, extra, or duplicated");
}

for (const fixture of manifest.fixtures) {
  const path = `fixtures/${fixture.path}`;
  try {
    await stat(path);
    const bytes = await readFile(path);
    const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (actual !== fixture.contentDigest) {
      errors.push(`${path}: content digest does not match fixture manifest`);
    }
    if (fixture.containsThirdPartyData && !fixture.redistributionReviewed) {
      errors.push(`${path}: third-party redistribution has not been reviewed`);
    }
  } catch {
    errors.push(`${path}: fixture is missing or unreadable`);
  }
}

if (errors.length) {
  for (const error of [...new Set(errors)]) console.error(error);
  process.exitCode = 1;
} else {
  console.log(
    `public audit passed (${workingFiles.length} working files; ${commits.length} commits)`,
  );
}
