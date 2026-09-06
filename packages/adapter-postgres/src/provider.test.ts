import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server, type Socket } from "node:net";
import test from "node:test";

import {
  computePostgresViewDefinitionDigest,
  PostgresSnapshotReadError,
  PostgresSnapshotResourceReader,
  type PostgresSnapshotResource,
} from "./index.js";

function protocolMessage(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header.write(type, 0, 1, "ascii");
  header.writeInt32BE(payload.length + 4, 1);
  return Buffer.concat([header, payload]);
}

function authReadyMessages(): Buffer {
  const authenticationOk = Buffer.alloc(4);
  authenticationOk.writeInt32BE(0);
  return Buffer.concat([
    protocolMessage("R", authenticationOk),
    protocolMessage("Z", Buffer.from("I", "ascii")),
  ]);
}

function connectionErrorMessage(): Buffer {
  return protocolMessage(
    "E",
    Buffer.from("SERROR\0C57P01\0Mterminating connection\0\0", "utf8"),
  );
}

async function fakePostgres(mode: "ready_then_drop" | "ready_and_error" | "stall"): Promise<{
  port: number;
  close(): Promise<void>;
}> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    if (mode === "stall") return;

    let buffer = Buffer.alloc(0);
    let startupComplete = false;
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!startupComplete) {
        if (buffer.length < 4) return;
        const startupLength = buffer.readInt32BE(0);
        if (startupLength < 8 || buffer.length < startupLength) return;
        buffer = buffer.subarray(startupLength);
        startupComplete = true;
        if (mode === "ready_and_error") {
          socket.end(Buffer.concat([authReadyMessages(), connectionErrorMessage()]));
          return;
        }
        socket.write(authReadyMessages());
      }
      while (buffer.length >= 5) {
        const messageLength = buffer.readInt32BE(1);
        const frameLength = messageLength + 1;
        if (messageLength < 4 || buffer.length < frameLength) return;
        const type = buffer.toString("ascii", 0, 1);
        buffer = buffer.subarray(frameLength);
        if (type === "Q") {
          socket.destroy();
          return;
        }
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fake server has no TCP port");
  return {
    port: address.port,
    async close() {
      for (const socket of sockets) socket.destroy();
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

function resource(): PostgresSnapshotResource {
  const viewDefinition = " SELECT id::text AS canonical_place_id FROM pizza_places;";
  return {
    resourceUri: "postgres-view://pipeline-input/provider-regression-v1",
    operation: "snapshot",
    partitions: ["US"],
    databaseName: "pizza_enrichment",
    databaseRole: "map_pipeline_apizza_shadow_reader",
    databaseContractOwner: "map_pipeline_contract_owner",
    databaseInstanceId: "018f4c5e-7a6b-7def-8abc-1234567890ab",
    databaseIdentityRelation: { schema: "pipeline_control", name: "database_identity" },
    schema: { name: "test.provider-regression", version: 1 },
    contract: {
      name: "provider-regression",
      version: 1,
      digest: `sha256:${"a".repeat(64)}`,
      viewDefinitionDigest: computePostgresViewDefinitionDigest(viewDefinition),
      cursorSchema: { name: "test.provider-regression-cursor", version: 1 },
    },
    relation: { schema: "pipeline_input", name: "provider_regression_v1" },
    columns: ["canonical_place_id"],
    columnTypes: { canonical_place_id: "text" },
    columnNullability: { canonical_place_id: false },
    orderBy: ["canonical_place_id"],
  };
}

function connectionString(port: number): string {
  const url = new URL(`postgresql://127.0.0.1:${port}/pizza_enrichment`);
  url.username = "map_pipeline_apizza_shadow_reader";
  url.password = ["fake", "test", "only"].join("-");
  url.searchParams.set("sslmode", "disable");
  return url.toString();
}

function readOptions(signal: AbortSignal) {
  return {
    resourceUri: "postgres-view://pipeline-input/provider-regression-v1",
    operation: "snapshot",
    partition: "US",
    maxRecords: 1,
    maxBytes: 4096,
    timeoutMs: 2_000,
    signal,
  };
}

test("a checked-out socket failure is handled without an uncaught process error", async () => {
  const server = await fakePostgres("ready_then_drop");
  const backgroundErrors: string[] = [];
  const reader = new PostgresSnapshotResourceReader({
    resources: [resource()],
    connectionString: connectionString(server.port),
    connectionTimeoutMs: 500,
    onBackgroundError: (error) => backgroundErrors.push(error.message),
  });
  let uncaught: unknown = null;
  const captureUncaught = (error: unknown) => {
    uncaught = error;
  };
  process.once("uncaughtException", captureUncaught);
  try {
    await assert.rejects(
      () => reader.read(readOptions(new AbortController().signal)),
      PostgresSnapshotReadError,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(uncaught, null);
    assert.deepEqual(backgroundErrors, ["Postgres snapshot read failed"]);
  } finally {
    process.removeListener("uncaughtException", captureUncaught);
    await reader.close();
    await server.close();
  }
});

test("a same-frame ready and error response has no checkout listener gap", async () => {
  const server = await fakePostgres("ready_and_error");
  const backgroundErrors: string[] = [];
  const reader = new PostgresSnapshotResourceReader({
    resources: [resource()],
    connectionString: connectionString(server.port),
    connectionTimeoutMs: 500,
    onBackgroundError: (error) => backgroundErrors.push(error.message),
  });
  let uncaught: unknown = null;
  const captureUncaught = (error: unknown) => {
    uncaught = error;
  };
  process.once("uncaughtException", captureUncaught);
  try {
    await assert.rejects(
      () => reader.read(readOptions(new AbortController().signal)),
      PostgresSnapshotReadError,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(uncaught, null);
    assert.deepEqual(backgroundErrors, ["Postgres snapshot read failed (SQLSTATE 57P01)"]);
  } finally {
    process.removeListener("uncaughtException", captureUncaught);
    await reader.close();
    await server.close();
  }
});

test("abort owns a pending connection and leaves no work for reader close", async () => {
  const server = await fakePostgres("stall");
  const reader = new PostgresSnapshotResourceReader({
    resources: [resource()],
    connectionString: connectionString(server.port),
    connectionTimeoutMs: 250,
  });
  const controller = new AbortController();
  const abortError = new Error("intentional provider test abort");
  const abortTimer = setTimeout(() => controller.abort(abortError), 20);
  try {
    const startedAt = Date.now();
    await assert.rejects(() => reader.read(readOptions(controller.signal)), abortError);
    const readElapsedMs = Date.now() - startedAt;
    assert.ok(readElapsedMs >= 150, `read settled too early after ${readElapsedMs}ms`);
    assert.ok(readElapsedMs < 1_000, `read did not respect the connection bound (${readElapsedMs}ms)`);

    const closeStartedAt = Date.now();
    await reader.close();
    const closeElapsedMs = Date.now() - closeStartedAt;
    assert.ok(closeElapsedMs < 100, `reader close inherited detached work (${closeElapsedMs}ms)`);
  } finally {
    clearTimeout(abortTimer);
    await reader.close();
    await server.close();
  }
});
