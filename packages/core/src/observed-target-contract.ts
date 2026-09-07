import { createHash } from "node:crypto";

import type { ObservedTargetContractReference } from "./types.js";

const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
const GIT_COMMIT = /^[a-f0-9]{40}$/;
const MAX_CONTRACT_BYTES = 1_048_576;

export interface VerifiedObservedTargetContract {
  contractSchemaVersion: number;
  name: string;
  version: number;
  ownerRepository: string;
  profile: string;
  entity: string;
  partition: string;
  logicalResourceUri: string;
  deployment: {
    externalApplyEnabled: false;
    verifiedOnProduction: false;
  };
  externalAuthorization: {
    enabled: false;
    requiredPrincipal: string;
    allowedEffects: [];
    allowedOperations: [];
  };
  [key: string]: unknown;
}

export class ObservedTargetContractError extends Error {
  override readonly name = "ObservedTargetContractError";
}

export interface ObservedJsonArtifactBinding {
  rawByteDigest: string;
  byteLength: number;
}

function fail(message: string): never {
  throw new ObservedTargetContractError(message);
}

function boundedIdentity(value: unknown, maxBytes = 200): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    value === value.normalize("NFC") &&
    Buffer.byteLength(value, "utf8") <= maxBytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSafeRepositoryPath(value: string): boolean {
  if (!boundedIdentity(value, 512) || value.startsWith("/") || value.includes("\\")) {
    return false;
  }
  const parts = value.split("/");
  return parts.every((part) => part && part !== "." && part !== "..") && value.endsWith(".json");
}

function freezeRecursively<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeRecursively(child);
    Object.freeze(value);
  }
  return value;
}

function asBytes(value: Uint8Array | string): Uint8Array {
  return typeof value === "string" ? Buffer.from(value, "utf8") : value;
}

function decodeUtf8(value: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    return fail("Observed target contract must be valid UTF-8");
  }
}

/** Validate JSON syntax while rejecting duplicate object keys, including escaped aliases. */
function assertJsonHasNoDuplicateKeys(text: string): void {
  let offset = 0;
  const whitespace = () => {
    while (/[\t\n\r ]/.test(text[offset] ?? "")) offset += 1;
  };
  const consume = (token: string) => {
    if (text.slice(offset, offset + token.length) !== token) fail("Observed target contract is malformed JSON");
    offset += token.length;
  };
  const parseString = (): string => {
    const start = offset;
    consume('"');
    while (offset < text.length) {
      const character = text[offset];
      if (character === '"') {
        offset += 1;
        try {
          return JSON.parse(text.slice(start, offset)) as string;
        } catch {
          return fail("Observed target contract contains an invalid JSON string");
        }
      }
      if (character === "\\") {
        offset += 1;
        const escape = text[offset];
        if (escape === "u") {
          if (!/^[a-fA-F0-9]{4}$/.test(text.slice(offset + 1, offset + 5))) {
            fail("Observed target contract contains an invalid Unicode escape");
          }
          offset += 5;
          continue;
        }
        if (!escape || !'"\\/bfnrt'.includes(escape)) {
          fail("Observed target contract contains an invalid escape");
        }
        offset += 1;
        continue;
      }
      if (!character || character.charCodeAt(0) < 0x20) {
        fail("Observed target contract contains an invalid control character");
      }
      offset += 1;
    }
    return fail("Observed target contract contains an unterminated string");
  };
  const parseValue = (): void => {
    whitespace();
    const character = text[offset];
    if (character === "{") {
      offset += 1;
      whitespace();
      const keys = new Set<string>();
      if (text[offset] === "}") {
        offset += 1;
        return;
      }
      for (;;) {
        whitespace();
        if (text[offset] !== '"') fail("Observed target contract object key must be a string");
        const key = parseString();
        if (keys.has(key)) fail(`Observed target contract contains duplicate key ${key}`);
        keys.add(key);
        whitespace();
        consume(":");
        parseValue();
        whitespace();
        if (text[offset] === "}") {
          offset += 1;
          return;
        }
        consume(",");
      }
    }
    if (character === "[") {
      offset += 1;
      whitespace();
      if (text[offset] === "]") {
        offset += 1;
        return;
      }
      for (;;) {
        parseValue();
        whitespace();
        if (text[offset] === "]") {
          offset += 1;
          return;
        }
        consume(",");
      }
    }
    if (character === '"') {
      parseString();
      return;
    }
    for (const literal of ["true", "false", "null"]) {
      if (text.startsWith(literal, offset)) {
        offset += literal.length;
        return;
      }
    }
    const number = text.slice(offset).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u)?.[0];
    if (!number) fail("Observed target contract contains an invalid JSON value");
    offset += number.length;
  };

  whitespace();
  parseValue();
  whitespace();
  if (offset !== text.length) fail("Observed target contract has trailing JSON content");
}

export function computeObservedTargetContractRawDigest(value: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(asBytes(value)).digest("hex")}`;
}

export function verifyObservedJsonArtifact(input: {
  bytes: Uint8Array | string;
  binding: ObservedJsonArtifactBinding;
}): Readonly<Record<string, unknown>> {
  if (!SHA256_DIGEST.test(input.binding.rawByteDigest) ||
      !Number.isSafeInteger(input.binding.byteLength) ||
      input.binding.byteLength <= 0 || input.binding.byteLength > MAX_CONTRACT_BYTES) {
    fail("Observed JSON byte binding is invalid");
  }
  const bytes = asBytes(input.bytes);
  if (bytes.byteLength !== input.binding.byteLength ||
      computeObservedTargetContractRawDigest(bytes) !== input.binding.rawByteDigest) {
    fail("Observed JSON bytes do not match the pinned length and digest");
  }
  const text = decodeUtf8(bytes);
  assertJsonHasNoDuplicateKeys(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail("Observed JSON artifact must contain valid JSON");
  }
  if (!isRecord(parsed)) fail("Observed JSON artifact must be an object");
  return freezeRecursively(parsed);
}

export function assertObservedTargetContractReference(
  reference: ObservedTargetContractReference,
): void {
  if (!boundedIdentity(reference.ownerRepository) ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(reference.ownerRepository)) {
    fail("Observed target ownerRepository must be a canonical repository slug");
  }
  if (!boundedIdentity(reference.contractName) ||
      !/^[a-z0-9][a-z0-9._-]*$/.test(reference.contractName) ||
      !Number.isSafeInteger(reference.version) || reference.version <= 0 ||
      !boundedIdentity(reference.profile) || !boundedIdentity(reference.entity)) {
    fail("Observed target identity is invalid");
  }
  if (!SHA256_DIGEST.test(reference.rawByteDigest) ||
      !Number.isSafeInteger(reference.byteLength) ||
      reference.byteLength <= 0 || reference.byteLength > MAX_CONTRACT_BYTES ||
      reference.activationEligible !== false) {
    fail("Observed target byte binding or activation state is invalid");
  }
  if (reference.source.repository !== reference.ownerRepository ||
      !GIT_COMMIT.test(reference.source.revision) ||
      !isSafeRepositoryPath(reference.source.path) ||
      reference.source.digestKind !== "sha256-raw-bytes-v1") {
    fail("Observed target source binding is invalid");
  }
}

export function verifyObservedTargetContractArtifact(input: {
  bytes: Uint8Array | string;
  reference: ObservedTargetContractReference;
  validateDocument?: (document: Readonly<Record<string, unknown>>) => void;
}): Readonly<VerifiedObservedTargetContract> {
  assertObservedTargetContractReference(input.reference);
  const parsed = verifyObservedJsonArtifact({
    bytes: input.bytes,
    binding: {
      rawByteDigest: input.reference.rawByteDigest,
      byteLength: input.reference.byteLength,
    },
  });
  if (
      parsed.contractSchemaVersion !== 1 ||
      parsed.name !== input.reference.contractName ||
      parsed.version !== input.reference.version ||
      parsed.ownerRepository !== input.reference.ownerRepository ||
      parsed.profile !== input.reference.profile ||
      parsed.entity !== input.reference.entity ||
      !boundedIdentity(parsed.partition, 100) ||
      !boundedIdentity(parsed.logicalResourceUri, 512) ||
      !/^[a-z][a-z0-9+.-]*:\/\//.test(String(parsed.logicalResourceUri))) {
    fail("Observed target contract envelope does not match the pinned identity");
  }

  const deployment = parsed.deployment;
  const authorization = parsed.externalAuthorization;
  if (!isRecord(deployment) || !isRecord(authorization) ||
      deployment.externalApplyEnabled !== false ||
      deployment.verifiedOnProduction !== false ||
      authorization.enabled !== false ||
      !boundedIdentity(authorization.requiredPrincipal) ||
      authorization.requiredPrincipal === "service_role" ||
      !Array.isArray(authorization.allowedEffects) || authorization.allowedEffects.length !== 0 ||
      !Array.isArray(authorization.allowedOperations) || authorization.allowedOperations.length !== 0) {
    fail("Observed target contract must remain inert and narrowly identified");
  }

  try {
    input.validateDocument?.(parsed);
  } catch (error) {
    fail(`Product target validator rejected the contract: ${error instanceof Error ? error.message : String(error)}`);
  }
  return freezeRecursively(parsed as unknown as VerifiedObservedTargetContract);
}
