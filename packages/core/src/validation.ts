import {
  PIPELINE_API_VERSION,
  type EffectRequestDeclaration,
  type PipelineDefinition,
  type PortDeclaration,
  type StagePluginManifest,
} from "./types.js";

const STAGE_ID = /^[a-z][a-z0-9-]*$/;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;

export interface ValidationIssue {
  path: string;
  message: string;
}

function samePort(left: PortDeclaration, right: PortDeclaration): boolean {
  return (
    left.schema.name === right.schema.name &&
    left.schema.version === right.schema.version &&
    left.cardinality === right.cardinality &&
    left.partitioning === right.partitioning &&
    left.ordering === right.ordering &&
    left.artifactPolicy === right.artifactPolicy
  );
}

function validateRequestedEffect(
  request: EffectRequestDeclaration,
  path: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!request.resourceUri) {
    issues.push({ path: `${path}.resourceUri`, message: "is required" });
  } else {
    try {
      const resource = new URL(request.resourceUri);
      if (
        resource.toString() !== request.resourceUri ||
        resource.username ||
        resource.password ||
        resource.search ||
        resource.hash
      ) {
        throw new TypeError("non-canonical resource URI");
      }
    } catch {
      issues.push({
        path: `${path}.resourceUri`,
        message: "must be a canonical URI without credentials, query, or fragment",
      });
    }
  }
  if (request.operations.length === 0) {
    issues.push({ path: `${path}.operations`, message: "must not be empty" });
  }
  if (!Number.isSafeInteger(request.maxRecords) || request.maxRecords <= 0) {
    issues.push({
      path: `${path}.maxRecords`,
      message: "must be a positive safe integer",
    });
  }
  if (
    request.effectClass === "public.write" &&
    request.verification !== "post_read"
  ) {
    issues.push({
      path: `${path}.verification`,
      message: "public.write requires post_read verification",
    });
  }
  return issues;
}

export function validateDefinition(
  definition: PipelineDefinition,
  catalog: Readonly<Record<string, StagePluginManifest>>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (definition.apiVersion !== PIPELINE_API_VERSION) {
    issues.push({ path: "apiVersion", message: "is unsupported" });
  }
  if (definition.kind !== "Pipeline") {
    issues.push({ path: "kind", message: "must be Pipeline" });
  }
  if (!definition.profile) {
    issues.push({ path: "profile", message: "is required" });
  }
  if (!Number.isSafeInteger(definition.metadata.version) || definition.metadata.version <= 0) {
    issues.push({
      path: "metadata.version",
      message: "must be a positive safe integer",
    });
  }
  if (definition.stages.length === 0) {
    issues.push({ path: "stages", message: "must not be empty" });
  }

  for (const [catalogId, manifest] of Object.entries(catalog)) {
    if (catalogId !== manifest.id) {
      issues.push({
        path: `catalog.${catalogId}.id`,
        message: "must equal its catalog key",
      });
    }
  }

  const seen = new Map<string, StagePluginManifest>();
  const consumedStages = new Set<string>();
  for (const [index, stage] of definition.stages.entries()) {
    const stagePath = `stages[${index}]`;
    if (!STAGE_ID.test(stage.id)) {
      issues.push({ path: `${stagePath}.id`, message: "has an invalid stage ID" });
    }
    if (seen.has(stage.id)) {
      issues.push({ path: `${stagePath}.id`, message: "must be unique" });
    }

    const plugin = catalog[stage.uses];
    if (!plugin) {
      issues.push({ path: `${stagePath}.uses`, message: "is not in the plugin lock" });
      continue;
    }
    if (plugin.lock.pluginApiVersion !== PIPELINE_API_VERSION) {
      issues.push({
        path: `${stagePath}.uses`,
        message: "uses an incompatible plugin API version",
      });
    }
    if (!SHA256_DIGEST.test(plugin.lock.integrity)) {
      issues.push({
        path: `${stagePath}.uses`,
        message: "plugin lock requires a sha256:<64 lowercase hex> digest",
      });
    }
    if (!SHA256_DIGEST.test(plugin.lock.configSchemaDigest)) {
      issues.push({
        path: `${stagePath}.uses`,
        message: "plugin lock requires a config-schema digest",
      });
    }
    if (
      plugin.lock.executableDigest !== undefined &&
      !SHA256_DIGEST.test(plugin.lock.executableDigest)
    ) {
      issues.push({
        path: `${stagePath}.uses`,
        message: "plugin executable digest is invalid",
      });
    }

    const inputs = stage.inputs ?? {};
    for (const [inputName, inputPort] of Object.entries(plugin.inputs)) {
      const reference = inputs[inputName];
      if (!reference) {
        if (inputPort.required !== false) {
          issues.push({
            path: `${stagePath}.inputs.${inputName}`,
            message: "is required",
          });
        }
        continue;
      }

      const [producerId, outputName, ...extra] = reference.split(".");
      const producer = producerId ? seen.get(producerId) : undefined;
      if (!producerId || !outputName || extra.length > 0 || !producer) {
        issues.push({
          path: `${stagePath}.inputs.${inputName}`,
          message: "must reference an earlier stage output",
        });
        continue;
      }

      consumedStages.add(producerId);

      const outputPort = producer.outputs[outputName];
      if (!outputPort) {
        issues.push({
          path: `${stagePath}.inputs.${inputName}`,
          message: "references an unknown output port",
        });
      } else if (!samePort(inputPort, outputPort)) {
        issues.push({
          path: `${stagePath}.inputs.${inputName}`,
          message: "is not schema/cardinality/partition/order/artifact compatible",
        });
      }
    }

    for (const inputName of Object.keys(inputs)) {
      if (!plugin.inputs[inputName]) {
        issues.push({
          path: `${stagePath}.inputs.${inputName}`,
          message: "is not declared by the plugin",
        });
      }
    }

    const requests = stage.requestedEffects ?? [];
    const sourcePolicyIds = stage.sourcePolicyIds ?? [];
    if (new Set(sourcePolicyIds).size !== sourcePolicyIds.length) {
      issues.push({
        path: `${stagePath}.sourcePolicyIds`,
        message: "must not contain duplicates",
      });
    }
    if (sourcePolicyIds.some((sourcePolicyId) => !sourcePolicyId)) {
      issues.push({
        path: `${stagePath}.sourcePolicyIds`,
        message: "must not contain empty IDs",
      });
    }
    if (plugin.policyBinding === "source" && sourcePolicyIds.length === 0) {
      issues.push({
        path: `${stagePath}.sourcePolicyIds`,
        message: "must bind at least one source policy",
      });
    }
    if (plugin.policyBinding === "none" && sourcePolicyIds.length > 0) {
      issues.push({
        path: `${stagePath}.sourcePolicyIds`,
        message: "is not allowed for a plugin without source policy binding",
      });
    }
    requests.forEach((request, requestIndex) => {
      issues.push(
        ...validateRequestedEffect(
          request,
          `${stagePath}.requestedEffects[${requestIndex}]`,
        ),
      );
      if (!plugin.effects.includes(request.effectClass)) {
        issues.push({
          path: `${stagePath}.requestedEffects[${requestIndex}].effectClass`,
          message: "is not declared by the plugin",
        });
      }
    });

    const resources = stage.resources;
    if (!resources?.admissionGroup) {
      issues.push({
        path: `${stagePath}.resources.admissionGroup`,
        message: "is required",
      });
    } else {
      for (const [key, value] of Object.entries(resources)) {
        if (key === "admissionGroup") continue;
        const mayBeZero = key === "maxChildProcesses" || key === "maxArtifactBytes";
        if (!Number.isSafeInteger(value) || value < (mayBeZero ? 0 : 1)) {
          issues.push({
            path: `${stagePath}.resources.${key}`,
            message: mayBeZero
              ? "must be a non-negative safe integer"
              : "must be a positive safe integer",
          });
        }
      }
    }

    for (const effect of plugin.effects) {
      if (!requests.some((request) => request.effectClass === effect)) {
        issues.push({
          path: `${stagePath}.requestedEffects`,
          message: `is missing a request for ${effect}`,
        });
      }
    }

    seen.set(stage.id, plugin);
  }

  const required = new Set(definition.requiredSinks);
  const optional = new Set(definition.optionalSinks);
  if (required.size !== definition.requiredSinks.length) {
    issues.push({ path: "requiredSinks", message: "must not contain duplicates" });
  }
  if (optional.size !== definition.optionalSinks.length) {
    issues.push({ path: "optionalSinks", message: "must not contain duplicates" });
  }
  if (required.size === 0) {
    issues.push({ path: "requiredSinks", message: "must not be empty" });
  }
  for (const [listName, sinks] of [
    ["requiredSinks", definition.requiredSinks],
    ["optionalSinks", definition.optionalSinks],
  ] as const) {
    for (const [index, sink] of sinks.entries()) {
      const plugin = seen.get(sink);
      if (!plugin) {
        issues.push({
          path: `${listName}[${index}]`,
          message: "must name a stage",
        });
        continue;
      }
      if (consumedStages.has(sink)) {
        issues.push({
          path: `${listName}[${index}]`,
          message: "must name a terminal stage",
        });
      }
      if (listName === "requiredSinks" && plugin.delivery !== "verified_receipt") {
        issues.push({
          path: `${listName}[${index}]`,
          message: "required sinks must declare verified receipts",
        });
      }
    }
  }
  for (const sink of required) {
    if (optional.has(sink)) {
      issues.push({
        path: "optionalSinks",
        message: `${sink} cannot be both required and optional`,
      });
    }
  }

  const writeEffects = new Set([
    "evidence.write",
    "review.write",
    "canonical.write",
    "public.write",
  ]);
  for (const [stageId, plugin] of seen) {
    const isTerminalWriter =
      !consumedStages.has(stageId) &&
      plugin.effects.some((effect) => writeEffects.has(effect));
    if (isTerminalWriter && !required.has(stageId) && !optional.has(stageId)) {
      issues.push({
        path: "requiredSinks",
        message: `terminal write stage ${stageId} must be required or optional`,
      });
    }
  }

  return issues;
}
