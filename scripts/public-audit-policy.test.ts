import assert from "node:assert/strict";
import test from "node:test";

import { pathViolations, textViolations } from "./public-audit-policy.mjs";

test("public audit rejects concrete host configuration artifacts", () => {
  assert.ok(pathViolations("config/apizza-host-config.json").length);
  assert.ok(pathViolations("ops/LaunchAgents/com.example.pipeline.plist").length);
  assert.ok(pathViolations("shadow-run/artifact-store/objects/example.json").length);
  assert.ok(pathViolations("shadow-run/.apizza-fsq-shadow.lock").length);
  assert.deepEqual(pathViolations("examples/host-config.template.json"), [
    "reserved private host-configuration filename",
  ]);
});

test("public audit rejects host paths, endpoints, and signed URLs", () => {
  const absolutePath = ["", "Volumes", "PipelineData", "release.json"].join("/");
  const privateAddress = ["192", "168", "1", "25"].join(".");
  const supabaseUrl = ["https://", "abcdefghijklmnopqrst", ".supabase.co"].join("");
  const signed = ["https://example.test/file?X-Amz-", "Signature=", "a".repeat(64)].join("");
  assert.ok(textViolations(absolutePath).includes("contains an absolute host path"));
  assert.ok(textViolations(privateAddress).includes("contains a private-network address"));
  assert.ok(textViolations(supabaseUrl).includes("contains a Supabase project endpoint"));
  assert.ok(textViolations(signed).includes("contains a signed URL parameter"));
});

test("public audit permits repository-relative placeholders", () => {
  assert.deepEqual(pathViolations("examples/synthetic-pipeline.json"), []);
  assert.deepEqual(textViolations("postgres-view://pipeline-input/example-v1"), []);
});

test("dotenv local filename exception does not permit machine hostnames", () => {
  assert.deepEqual(textViolations("join(root, '.env.local')"), []);
  assert.ok(textViolations(['machine', 'local'].join('.')).length);
  assert.ok(textViolations(['machine.env', 'local'].join('.')).length);
});
