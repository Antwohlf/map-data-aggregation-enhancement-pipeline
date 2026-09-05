import {
  PIPELINE_API_VERSION,
  type EffectRequestDeclaration,
  type PipelineDefinition,
  type PortDeclaration,
  type StagePluginManifest,
} from "./types.js";

const STAGE_ID = /^[a-z][a-z0-9-]*$/;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
const ARTIFACT_CLASSES = new Set([
  "raw",
  "derived",
  "review_evidence",
]);

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

function isCanonicalResourceUri(resourceUri: string): boolean {
  try {
    const resource = new URL(resourceUri);
    return (
      resource.toString() === resourceUri &&
      !resource.username &&
      !resource.password &&
      !resource.search &&
      !resource.hash
    );
  } catch {
    return false;
  }
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return (
    left.length === right.length &&
    sortedLeft.every((value, index) => value === sortedRight[index])
  );
}

function validateRequestedEffect(
  request: EffectRequestDeclaration,
  path: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isCanonicalResourceUri(request.resourceUri)) {
    issues.push({
      path: `${path}.resourceUri`,
      message: "must be a canonical URI without credentials, query, or fragment",
    });
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
    if (manifest.sourceAdapter !== null && !manifest.sourceAdapter) {
      issues.push({
        path: `catalog.${catalogId}.sourceAdapter`,
        message: "must be a non-empty adapter name or null",
      });
    }
    const declaresRead = manifest.effects.some(
      (effect) => effect === "network.read" || effect === "artifact.read",
    );
    if (manifest.sourceAdapter === null && declaresRead) {
      issues.push({
        path: `catalog.${catalogId}.sourceAdapter`,
        message: "read-capable plugins must declare their exact source adapter",
      });
    }
    if (manifest.sourceAdapter !== null && !declaresRead) {
      issues.push({
        path: `catalog.${catalogId}.effects`,
        message: "source plugins must declare a read effect",
      });
    }
    if (
      manifest.sourceAdapter !== null &&
      Object.keys(manifest.inputs).length > 0
    ) {
      issues.push({
        path: `catalog.${catalogId}.inputs`,
        message: "source plugins cannot consume pipeline datasets; use a transform stage",
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
    if (
      requests.some(
        (request) =>
          request.effectClass === "canonical.write" ||
          request.effectClass === "public.write",
      ) &&
      Object.keys(stage.inputs ?? {}).length === 0
    ) {
      issues.push({
        path: `${stagePath}.inputs`,
        message: "consumer write effects require at least one declared dataset input",
      });
    }
    if (
      requests.some(
        (request) =>
          request.effectClass === "artifact.write" ||
          request.effectClass === "evidence.write" ||
          request.effectClass === "review.write",
      ) &&
      Object.keys(plugin.outputs).length === 0
    ) {
      issues.push({
        path: `${stagePath}.requestedEffects`,
        message: "output write effects require at least one declared output port",
      });
    }
    const sourceBindings = stage.sourceBindings ?? [];
    if (plugin.sourceAdapter !== null && sourceBindings.length === 0) {
      issues.push({
        path: `${stagePath}.sourceBindings`,
        message: "must bind every source output to an exact source policy",
      });
    }
    if (plugin.sourceAdapter === null && sourceBindings.length > 0) {
      issues.push({
        path: `${stagePath}.sourceBindings`,
        message: "is not allowed for a non-source plugin",
      });
    }

    const boundOutputPorts = new Set<string>();
    sourceBindings.forEach((binding, bindingIndex) => {
      const bindingPath = `${stagePath}.sourceBindings[${bindingIndex}]`;
      if (!binding.policyId) {
        issues.push({ path: `${bindingPath}.policyId`, message: "is required" });
      }
      if (
        binding.effectClass !== "network.read" &&
        binding.effectClass !== "artifact.read"
      ) {
        issues.push({
          path: `${bindingPath}.effectClass`,
          message: "must be network.read or artifact.read",
        });
      }
      if (!isCanonicalResourceUri(binding.resourceUri)) {
        issues.push({
          path: `${bindingPath}.resourceUri`,
          message: "must be a canonical URI without credentials, query, or fragment",
        });
      }
      if (!ARTIFACT_CLASSES.has(binding.artifactClass)) {
        issues.push({
          path: `${bindingPath}.artifactClass`,
          message: "is not a recognized artifact class",
        });
      }
      if (binding.outputPorts.length === 0) {
        issues.push({
          path: `${bindingPath}.outputPorts`,
          message: "must not be empty",
        });
      }
      if (
        binding.operations.length === 0 ||
        new Set(binding.operations).size !== binding.operations.length ||
        binding.operations.some((operation) => !operation)
      ) {
        issues.push({
          path: `${bindingPath}.operations`,
          message: "must contain unique, non-empty operations",
        });
      }
      if (new Set(binding.outputPorts).size !== binding.outputPorts.length) {
        issues.push({
          path: `${bindingPath}.outputPorts`,
          message: "must not contain duplicates",
        });
      }
      if (
        new Set(binding.childIds).size !== binding.childIds.length ||
        binding.childIds.some((childId) => !childId)
      ) {
        issues.push({
          path: `${bindingPath}.childIds`,
          message: "must contain unique, non-empty child IDs",
        });
      }
      if (
        requests.filter(
          (request) =>
            request.effectClass === binding.effectClass &&
            request.resourceUri === binding.resourceUri &&
            sameValues(request.operations, binding.operations),
        ).length !== 1
      ) {
        issues.push({
          path: bindingPath,
          message: "must match exactly one read effect requested by this stage",
        });
      }
      for (const outputPort of binding.outputPorts) {
        const declaration = plugin.outputs[outputPort];
        if (!declaration) {
          issues.push({
            path: `${bindingPath}.outputPorts`,
            message: `references unknown output port ${outputPort}`,
          });
        } else if (boundOutputPorts.has(outputPort)) {
          issues.push({
            path: `${bindingPath}.outputPorts`,
            message: `output port ${outputPort} is bound more than once`,
          });
        } else {
          boundOutputPorts.add(outputPort);
          if (
            binding.artifactClass === "raw" &&
            declaration.artifactPolicy === "derived_only"
          ) {
            issues.push({
              path: `${bindingPath}.artifactClass`,
              message: `raw output ${outputPort} cannot declare derived-only storage`,
            });
          }
        }
      }
    });
    if (plugin.sourceAdapter !== null) {
      for (const [requestIndex, request] of requests.entries()) {
        if (
          (request.effectClass === "network.read" ||
            request.effectClass === "artifact.read") &&
          sourceBindings.filter(
            (binding) =>
              binding.effectClass === request.effectClass &&
              binding.resourceUri === request.resourceUri &&
              sameValues(binding.operations, request.operations),
          ).length !== 1
        ) {
          issues.push({
            path: `${stagePath}.requestedEffects[${requestIndex}]`,
            message: "source read must be covered by exactly one source binding",
          });
        }
      }
      for (const outputPort of Object.keys(plugin.outputs)) {
        if (!boundOutputPorts.has(outputPort)) {
          issues.push({
            path: `${stagePath}.sourceBindings`,
            message: `source output port ${outputPort} is not policy-bound`,
          });
        }
      }
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
