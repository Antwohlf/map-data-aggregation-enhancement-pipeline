const forbiddenPath = /(^|\/)(\.pipeline-state|artifacts|checkpoints|runtime|state|raw|input|output|backups|reports)(\/|$)/;
const forbiddenExtension = /\.(db|db-shm|db-wal|sqlite|sqlite3|sqlite-shm|sqlite-wal|sqlite3-shm|sqlite3-wal|ndjson|parquet|log|plist)$/i;
const reservedHostConfigPath = /(^|\/)(?:[^/]*(?:private|host|deployment)[-_]?config[^/]*)\.(?:json|ya?ml|toml)$/i;
const absoluteHostPath = new RegExp(
  "/(?:" + ["Users", "home", "Volumes", "opt", "private", "srv", "mnt"].join("|") + ")/",
);
const hostName = /\b[a-z0-9.-]+\.local\b/i;
const privateNetwork = /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/;
const supabaseEndpoint = new RegExp(
  ["https?", "://", "[a-z0-9]{16,}", "\\.supabase\\.co"].join(""),
  "i",
);
const signedUrl = new RegExp(
  ["(?:x-amz-signature|x-goog-signature|signature|sig)", "=", "[a-z0-9%_-]{12,}"].join(""),
  "i",
);
const credentialNames = [
  ["service", "role", "key"].join("_"),
  ["database", "url"].join("_"),
  ["direct", "url"].join("_"),
  ["api", "key"].join("_"),
  ["pg", "password"].join(""),
  ["db", "password"].join("_"),
  ["postgres", "password"].join("_"),
  ["supabase", "db", "password"].join("_"),
].join("|");
const credentialAssignment = new RegExp(
  `(?:${credentialNames})\\s*[=:]\\s*[^\\s<{]`,
  "i",
);
const postgresCredentialUri = new RegExp(
  ["postgres(?:ql)?", "://", "[^\\s:/@]+", ":", "[^\\s/@]+", "@"].join(""),
  "i",
);

export function pathViolations(path) {
  const errors = [];
  if (forbiddenPath.test(path) || forbiddenExtension.test(path)) {
    errors.push("forbidden runtime/raw path or extension");
  }
  if (reservedHostConfigPath.test(path)) {
    errors.push("reserved private host-configuration filename");
  }
  if (/\.jsonl$/i.test(path) && !path.startsWith("fixtures/synthetic/")) {
    errors.push("JSONL is allowed only in the synthetic fixture tree");
  }
  return errors;
}

export function textViolations(value) {
  const errors = [];
  if (absoluteHostPath.test(value)) errors.push("contains an absolute host path");
  if (hostName.test(value)) errors.push("contains a local hostname");
  if (privateNetwork.test(value)) errors.push("contains a private-network address");
  if (supabaseEndpoint.test(value)) errors.push("contains a Supabase project endpoint");
  if (signedUrl.test(value)) errors.push("contains a signed URL parameter");
  if (credentialAssignment.test(value)) errors.push("resembles a credential assignment");
  if (postgresCredentialUri.test(value)) {
    errors.push("contains a password-bearing PostgreSQL URI");
  }
  return errors;
}
