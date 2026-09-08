import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { digest, type CanonicalJson } from "@map-pipeline/core";

import {
  acquireApizzaFsqShadowRunLock,
  apizzaFsqShadowHostPaths,
  formatApizzaFsqShadowFailure,
  loadApizzaFsqShadowHostComposition,
  preparePrivateRuntimeRoot,
  runWithApizzaFsqShadowCleanup,
} from "./fsq-shadow-host-v1.js";

interface TestFiles {
  root: string;
  inputRoot: string;
  projectionPath: string;
  runtimeRoot: string;
  policyPath: string;
  hostManifestPath: string;
  hostManifest: Record<string, CanonicalJson>;
}

async function makeTestFiles(options: { approved?: boolean } = {}): Promise<TestFiles> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "apizza-fsq-shadow-host-")));
  const inputRoot = join(root, "input");
  const runtimeRoot = join(root, "runtime");
  const projectionPath = join(inputRoot, "fsq-release.json");
  const policyPath = join(root, "source-policy.json");
  const hostManifestPath = join(root, "host-manifest.json");
  await mkdir(inputRoot, { mode: 0o700 });
  const projectionBytes = "[]";
  await writeFile(projectionPath, projectionBytes, { mode: 0o600 });

  const sourcePolicy = JSON.parse(await readFile(
    apizzaFsqShadowHostPaths.sourcePolicy,
    "utf8",
  )) as Record<string, CanonicalJson>;
  if (options.approved !== false) {
    sourcePolicy.approvalStatus = "approved_read_only_shadow";
    sourcePolicy.ownerApprovedAt = "2026-09-07T12:00:00.000Z";
    sourcePolicy.privacyReviewStatus = "approved_restricted_projection";
  } else {
    sourcePolicy.approvalStatus = "pending_owner_approval";
    sourcePolicy.ownerApprovedAt = null;
    sourcePolicy.privacyReviewStatus = "pending_conservative_classification";
  }
  await writeFile(policyPath, JSON.stringify(sourcePolicy), { mode: 0o600 });
  const hostManifest: Record<string, CanonicalJson> = {
    schemaVersion: 1,
    deploymentIdentity: "test-apizza-fsq-shadow-host",
    partition: "US",
    runtimeRoot,
    evaluationTime: "2026-09-07T12:00:00.000Z",
    fallbackRetrievedAt: "2026-09-07T12:00:00.000Z",
    expectedSourcePolicyDigest: digest(sourcePolicy as CanonicalJson),
    fsq: {
      rootPath: inputRoot,
      relativePath: "fsq-release.json",
      expectedContentDigest: `sha256:${createHash("sha256").update(projectionBytes).digest("hex")}`,
      childIds: ["release:synthetic-host-test"],
      maxRecords: 10,
    },
    postgres: {
      databaseInstanceId: "018f4c5e-7a6b-7def-8abc-1234567890ab",
      viewDefinitionDigest: `sha256:${"a".repeat(64)}`,
      pageSize: 500,
      maxRowBytes: 65_536,
    },
  };
  await writeFile(hostManifestPath, JSON.stringify(hostManifest), { mode: 0o600 });
  return {
    root,
    inputRoot,
    projectionPath,
    runtimeRoot,
    policyPath,
    hostManifestPath,
    hostManifest,
  };
}

test("composes a read-only APizza shadow from pinned owner and repository contracts", async () => {
  const files = await makeTestFiles();
  try {
    const composition = await loadApizzaFsqShadowHostComposition({
      hostManifestPath: files.hostManifestPath,
      sourcePolicyPath: files.policyPath,
      now: new Date("2026-09-07T12:00:01.000Z"),
    });
    assert.equal(composition.definition.profile, "apizzamichigan");
    assert.equal(composition.definition.metadata.name, "apizza-fsq-read-only-shadow");
    assert.equal(composition.fsqResource.rootPath, files.inputRoot);
    assert.equal(composition.canonicalResource.databaseName, "pizza_enrichment");
    assert.equal(
      composition.canonicalResource.databaseRole,
      "map_pipeline_apizza_shadow_reader",
    );
    assert.equal(composition.sourceReadGrants.length, 2);
    assert.equal(
      composition.definition.stages.flatMap((stage) => stage.requestedEffects ?? [])
        .some((effect) => ["canonical.write", "public.write", "review.write"].includes(
          effect.effectClass,
        )),
      false,
    );
  } finally {
    await rm(files.root, { recursive: true, force: true });
  }
});

test("fails closed on pending policy and policy digest drift", async () => {
  const pending = await makeTestFiles({ approved: false });
  try {
    await assert.rejects(
      () => loadApizzaFsqShadowHostComposition({
        hostManifestPath: pending.hostManifestPath,
        sourcePolicyPath: pending.policyPath,
        now: new Date("2026-09-07T12:00:01.000Z"),
      }),
      /pending explicit owner approval/,
    );
  } finally {
    await rm(pending.root, { recursive: true, force: true });
  }

  const drifted = await makeTestFiles();
  try {
    const host = structuredClone(drifted.hostManifest);
    host.expectedSourcePolicyDigest = `sha256:${"b".repeat(64)}`;
    await writeFile(drifted.hostManifestPath, JSON.stringify(host), { mode: 0o600 });
    await assert.rejects(
      () => loadApizzaFsqShadowHostComposition({
        hostManifestPath: drifted.hostManifestPath,
        sourcePolicyPath: drifted.policyPath,
        now: new Date("2026-09-07T12:00:01.000Z"),
      }),
      /does not pin the exact FSQ source policy assertion/,
    );
  } finally {
    await rm(drifted.root, { recursive: true, force: true });
  }
});

test("rejects permissive host files and source projections before composition", async () => {
  const insecureManifest = await makeTestFiles();
  try {
    await chmod(insecureManifest.hostManifestPath, 0o644);
    await assert.rejects(
      () => loadApizzaFsqShadowHostComposition({
        hostManifestPath: insecureManifest.hostManifestPath,
        sourcePolicyPath: insecureManifest.policyPath,
      }),
      /must not be accessible by group or other users/,
    );
  } finally {
    await rm(insecureManifest.root, { recursive: true, force: true });
  }

  const insecureProjection = await makeTestFiles();
  try {
    await chmod(insecureProjection.projectionPath, 0o644);
    await assert.rejects(
      () => loadApizzaFsqShadowHostComposition({
        hostManifestPath: insecureProjection.hostManifestPath,
        sourcePolicyPath: insecureProjection.policyPath,
        now: new Date("2026-09-07T12:00:01.000Z"),
      }),
      /must not be accessible by group or other users/,
    );
  } finally {
    await rm(insecureProjection.root, { recursive: true, force: true });
  }
});

test("rejects projection byte drift before creating runtime state", async () => {
  const files = await makeTestFiles();
  try {
    const host = structuredClone(files.hostManifest);
    assert.ok(host.fsq && typeof host.fsq === "object" && !Array.isArray(host.fsq));
    host.fsq.expectedContentDigest = `sha256:${"c".repeat(64)}`;
    await writeFile(files.hostManifestPath, JSON.stringify(host), { mode: 0o600 });
    await assert.rejects(
      () => loadApizzaFsqShadowHostComposition({
        hostManifestPath: files.hostManifestPath,
        sourcePolicyPath: files.policyPath,
        now: new Date("2026-09-07T12:00:01.000Z"),
      }),
      /content digest does not match/,
    );
    await assert.rejects(() => readFile(join(files.runtimeRoot, "state.sqlite")), /ENOENT/);
  } finally {
    await rm(files.root, { recursive: true, force: true });
  }
});

test("pins the host record cap to the APizza matcher cap", async () => {
  const files = await makeTestFiles();
  try {
    const atCap = structuredClone(files.hostManifest);
    assert.ok(atCap.fsq && typeof atCap.fsq === "object" && !Array.isArray(atCap.fsq));
    atCap.fsq.maxRecords = 5_000;
    await writeFile(files.hostManifestPath, JSON.stringify(atCap), { mode: 0o600 });
    await assert.doesNotReject(
      () => loadApizzaFsqShadowHostComposition({
        hostManifestPath: files.hostManifestPath,
        sourcePolicyPath: files.policyPath,
        now: new Date("2026-09-07T12:00:01.000Z"),
      }),
    );

    atCap.fsq.maxRecords = 5_001;
    await writeFile(files.hostManifestPath, JSON.stringify(atCap), { mode: 0o600 });
    await assert.rejects(
      () => loadApizzaFsqShadowHostComposition({
        hostManifestPath: files.hostManifestPath,
        sourcePolicyPath: files.policyPath,
        now: new Date("2026-09-07T12:00:01.000Z"),
      }),
      /host manifest is invalid/,
    );
  } finally {
    await rm(files.root, { recursive: true, force: true });
  }
});

test("keeps host inputs and runtime state outside the public repository", async () => {
  const files = await makeTestFiles();
  try {
    const insideRepository = structuredClone(files.hostManifest);
    insideRepository.runtimeRoot = join(
      dirname(apizzaFsqShadowHostPaths.sourcePolicy),
      "runtime-private-test",
    );
    await writeFile(
      files.hostManifestPath,
      JSON.stringify(insideRepository),
      { mode: 0o600 },
    );
    await assert.rejects(
      () => loadApizzaFsqShadowHostComposition({
        hostManifestPath: files.hostManifestPath,
        sourcePolicyPath: files.policyPath,
        now: new Date("2026-09-07T12:00:01.000Z"),
      }),
      /runtimeRoot must remain outside the public git worktree/,
    );

    const alias = join(files.root, "input-alias");
    await symlink(files.inputRoot, alias);
    const aliasedInput = structuredClone(files.hostManifest);
    assert.ok(
      aliasedInput.fsq &&
      typeof aliasedInput.fsq === "object" &&
      !Array.isArray(aliasedInput.fsq),
    );
    aliasedInput.fsq.rootPath = alias;
    await writeFile(files.hostManifestPath, JSON.stringify(aliasedInput), { mode: 0o600 });
    await assert.rejects(
      () => loadApizzaFsqShadowHostComposition({
        hostManifestPath: files.hostManifestPath,
        sourcePolicyPath: files.policyPath,
        now: new Date("2026-09-07T12:00:01.000Z"),
      }),
      /symbolic link/,
    );
  } finally {
    await rm(files.root, { recursive: true, force: true });
  }
});

test("creates a private runtime root and rejects permissive or symlinked roots", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "apizza-fsq-runtime-root-")));
  try {
    const created = join(root, "created");
    await preparePrivateRuntimeRoot(created);
    assert.equal((await stat(created)).mode & 0o077, 0);

    const permissive = join(root, "permissive");
    await mkdir(permissive, { mode: 0o755 });
    await assert.rejects(
      () => preparePrivateRuntimeRoot(permissive),
      /must not be accessible by group or other users/,
    );

    const actual = join(root, "actual");
    const alias = join(root, "alias");
    await mkdir(actual, { mode: 0o700 });
    await symlink(actual, alias);
    await assert.rejects(
      () => preparePrivateRuntimeRoot(join(alias, "must-not-be-created")),
      /may not traverse symbolic links/,
    );
    await assert.rejects(() => stat(join(actual, "must-not-be-created")), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("holds one host-wide run lock regardless of manifest runtime roots", async () => {
  const firstFiles = await makeTestFiles();
  const secondFiles = await makeTestFiles();
  try {
    assert.notEqual(firstFiles.runtimeRoot, secondFiles.runtimeRoot);
    const first = await acquireApizzaFsqShadowRunLock();
    const previousTmpdir = process.env.TMPDIR;
    try {
      process.env.TMPDIR = secondFiles.root;
      await assert.rejects(
        () => acquireApizzaFsqShadowRunLock(),
        /already active/,
      );
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpdir;
      await first.release();
    }
    const second = await acquireApizzaFsqShadowRunLock();
    await second.release();
  } finally {
    await rm(firstFiles.root, { recursive: true, force: true });
    await rm(secondFiles.root, { recursive: true, force: true });
  }
});

test("public failure output omits private host paths", () => {
  const privatePath = ["", "private", "customer-data", "fsq.json"].join("/");
  const message = formatApizzaFsqShadowFailure(new Error(`EACCES: ${privatePath}`));
  assert.equal(message, "APizza FSQ shadow runner failed; inspect private host configuration and run state");
  assert.equal(message.includes(privatePath), false);
});

test("does not expose success until every cleanup succeeds", async () => {
  const cleanupOrder: string[] = [];
  let emitted = false;
  await assert.rejects(
    async () => {
      const result = await runWithApizzaFsqShadowCleanup({
        work: async () => ({ status: "succeeded" }),
        cleanups: [
          async () => {
            cleanupOrder.push("postgres");
            throw new Error("close failed");
          },
          () => {
            cleanupOrder.push("state");
          },
          async () => {
            cleanupOrder.push("lock");
          },
        ],
        isTerminated: () => false,
      });
      emitted = true;
      return result;
    },
    /close failed/,
  );
  assert.equal(emitted, false);
  assert.deepEqual(cleanupOrder, ["postgres", "state", "lock"]);
});

test("a termination during delayed cleanup completes cleanup and suppresses success", async () => {
  let terminated = false;
  let startCleanup!: () => void;
  let finishCleanup!: () => void;
  const cleanupStarted = new Promise<void>((resolve) => {
    startCleanup = resolve;
  });
  const cleanupMayFinish = new Promise<void>((resolve) => {
    finishCleanup = resolve;
  });
  let lockReleased = false;
  let emitted = false;
  const running = (async () => {
    const result = await runWithApizzaFsqShadowCleanup({
      work: async () => ({ status: "succeeded" }),
      cleanups: [
        async () => {
          startCleanup();
          await cleanupMayFinish;
        },
        () => {
          lockReleased = true;
        },
      ],
      isTerminated: () => terminated,
    });
    emitted = true;
    return result;
  })();
  await cleanupStarted;
  terminated = true;
  finishCleanup();
  await assert.rejects(running, /runner was terminated/);
  assert.equal(lockReleased, true);
  assert.equal(emitted, false);
});
