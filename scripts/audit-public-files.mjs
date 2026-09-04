import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

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
const forbiddenPath = /(^|\/)(\.pipeline-state|artifacts|checkpoints|runtime|state|raw|input|output|backups|reports)(\/|$)/;
const forbiddenExtension = /\.(db|db-shm|db-wal|sqlite|sqlite3|sqlite-shm|sqlite-wal|sqlite3-shm|sqlite3-wal|ndjson|parquet|log)$/i;
const localHome = new RegExp("/" + "Users/|/" + "home/");
const hostName = /\b[a-z0-9.-]+\.local\b/i;
const credentialNames = [
  ["service", "role", "key"].join("_"),
  ["database", "url"].join("_"),
  ["api", "key"].join("_"),
].join("|");
const credentialAssignment = new RegExp(
  `(?:${credentialNames})\\s*[=:]\\s*[^\\s<{]`,
  "i",
);

function scanPath(label, path) {
  if (forbiddenPath.test(path) || forbiddenExtension.test(path)) {
    errors.push(`${label}: forbidden runtime/raw path or extension`);
  }
  if (/\.jsonl$/i.test(path) && !path.startsWith("fixtures/synthetic/")) {
    errors.push(`${label}: JSONL is allowed only in the synthetic fixture tree`);
  }
}

function scanBytes(label, bytes) {
  if (bytes.includes(0)) return;
  const value = bytes.toString("utf8");
  if (localHome.test(value)) errors.push(`${label}: contains an absolute home path`);
  if (hostName.test(value)) errors.push(`${label}: contains a local hostname`);
  if (credentialAssignment.test(value)) {
    errors.push(`${label}: resembles a credential assignment`);
  }
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
  if (localHome.test(metadata) || hostName.test(metadata)) {
    errors.push(`${commit}: commit metadata contains a local path or hostname`);
  }
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
