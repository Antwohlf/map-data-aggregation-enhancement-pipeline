import type {
  EffectAuthorization,
  EffectRequest,
  PipelineMode,
  StagePluginManifest,
} from "./types.js";

const PREVIEW_EFFECTS = new Set([
  "network.read",
  "artifact.read",
  "artifact.write",
]);

export class EffectDeniedError extends Error {
  override readonly name = "EffectDeniedError";
}

export function assertEffectAuthorizedInternal(input: {
  mode: PipelineMode;
  profile: string;
  stageId: string;
  deploymentIdentity: string;
  manifest: StagePluginManifest;
  grants: EffectAuthorization[];
  request: EffectRequest;
}): void {
  const {
    mode,
    profile,
    stageId,
    deploymentIdentity,
    manifest,
    grants,
    request,
  } = input;

  if (!Number.isSafeInteger(request.recordCount) || request.recordCount < 0) {
    throw new EffectDeniedError("Record count must be a non-negative safe integer");
  }

  let canonicalResource: string;
  try {
    const resource = new URL(request.resourceUri);
    if (
      resource.username ||
      resource.password ||
      resource.search ||
      resource.hash
    ) {
      throw new TypeError("resource URI contains forbidden components");
    }
    canonicalResource = resource.toString();
  } catch {
    throw new EffectDeniedError("Resource URI is invalid or non-canonical");
  }
  if (canonicalResource !== request.resourceUri) {
    throw new EffectDeniedError("Resource URI is invalid or non-canonical");
  }

  if (!manifest.effects.includes(request.effectClass)) {
    throw new EffectDeniedError(
      `Plugin ${manifest.id} did not declare ${request.effectClass}`,
    );
  }

  if (mode === "validate" || mode === "plan") {
    throw new EffectDeniedError(`${mode} mode cannot perform effects`);
  }

  if (mode === "preview") {
    if (!PREVIEW_EFFECTS.has(request.effectClass)) {
      throw new EffectDeniedError(
        `preview mode cannot perform ${request.effectClass}`,
      );
    }
    if (
      request.effectClass === "artifact.write" &&
      !request.resourceUri.startsWith("preview://")
    ) {
      throw new EffectDeniedError(
        "preview artifacts must use the preview namespace",
      );
    }
  }

  const grant = grants.find(
    (candidate) =>
      candidate.effectClass === request.effectClass &&
      candidate.profile === profile &&
      candidate.stageId === stageId &&
      candidate.deploymentIdentity === deploymentIdentity &&
      candidate.resourceUri === request.resourceUri &&
      candidate.operations.includes(request.operation),
  );

  if (!grant) {
    throw new EffectDeniedError(
      `No grant for ${request.effectClass} ${request.operation} on ${request.resourceUri}`,
    );
  }

  if (request.recordCount > grant.maxRecords) {
    throw new EffectDeniedError(
      `Record count ${request.recordCount} exceeds grant limit ${grant.maxRecords}`,
    );
  }

  if (request.effectClass === "public.write" && grant.verification !== "post_read") {
    throw new EffectDeniedError("public.write requires post_read verification");
  }
}
