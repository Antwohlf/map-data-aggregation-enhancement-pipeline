const KINDS = new Set(['source', 'transform', 'review', 'output', 'maintenance']);
const DEFINITION_KEYS = ['id', 'schemaVersion', 'stages'];
const STAGE_KEYS = ['adapter', 'config', 'dependsOn', 'id', 'kind', 'version'];

function fail(message) {
  throw new TypeError(message);
}

function jsonClone(value, path = 'definition') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${path} must contain finite JSON numbers`);
    return value;
  }
  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).some(key => key !== 'length' && !/^\d+$/.test(String(key)))) fail(`${path} must be a JSON array`);
    return Object.freeze(Array.from({ length: value.length }, (_, index) => {
      const descriptor = descriptors[index];
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail(`${path} must not contain holes or accessors`);
      return jsonClone(descriptor.value, `${path}[${index}]`);
    }));
  }
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) fail(`${path} must be plain JSON`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string')) fail(`${path} must not contain symbol keys`);
  const clone = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(`${path}.${key} must be an enumerable JSON value`);
    Object.defineProperty(clone, key, { enumerable: true, configurable: true, writable: true, value: jsonClone(descriptor.value, `${path}.${key}`) });
  }
  return Object.freeze(clone);
}

function exactKeys(value, keys, path) {
  const actual = Object.keys(value).sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) fail(`${path} has unknown or missing fields`);
}

function text(value, path) {
  if (typeof value !== 'string' || !value.length || value.trim() !== value) fail(`${path} must be a non-empty string`);
  return value;
}

function stableTopologicalOrder(stages) {
  const remaining = new Set(stages.map(stage => stage.id));
  const complete = new Set();
  const order = [];
  while (remaining.size) {
    const ready = stages.find(stage => remaining.has(stage.id) && stage.dependsOn.every(id => complete.has(id)));
    if (!ready) fail('definition.stages contains a dependency cycle');
    remaining.delete(ready.id);
    complete.add(ready.id);
    order.push(ready);
  }
  return Object.freeze(order);
}

function prepare(definition, registry, context, onEvent) {
  const value = jsonClone(definition);
  exactKeys(value, DEFINITION_KEYS, 'definition');
  if (value.schemaVersion !== 1) fail('definition.schemaVersion must be 1');
  text(value.id, 'definition.id');
  if (!Array.isArray(value.stages)) fail('definition.stages must be an array');
  if (!Array.isArray(registry)) fail('registry must be an array');
  if (context === null || typeof context !== 'object' || Array.isArray(context)) fail('context must be an object');
  if (onEvent !== undefined && typeof onEvent !== 'function') fail('onEvent must be a function');

  const ids = new Set();
  for (const [index, stage] of value.stages.entries()) {
    if (!stage || Array.isArray(stage) || typeof stage !== 'object') fail(`definition.stages[${index}] must be an object`);
    exactKeys(stage, STAGE_KEYS, `definition.stages[${index}]`);
    text(stage.id, `definition.stages[${index}].id`);
    text(stage.adapter, `definition.stages[${index}].adapter`);
    if (!Number.isSafeInteger(stage.version) || stage.version < 1) fail(`definition.stages[${index}].version must be a positive integer`);
    if (!KINDS.has(stage.kind)) fail(`definition.stages[${index}].kind is unsupported`);
    if (!Array.isArray(stage.dependsOn) || !stage.dependsOn.every(item => typeof item === 'string')) fail(`definition.stages[${index}].dependsOn must contain strings`);
    if (!stage.config || Array.isArray(stage.config) || typeof stage.config !== 'object') fail(`definition.stages[${index}].config must be an object`);
    if (ids.has(stage.id)) fail(`duplicate stage id: ${stage.id}`);
    if (new Set(stage.dependsOn).size !== stage.dependsOn.length) fail(`duplicate dependency in stage: ${stage.id}`);
    ids.add(stage.id);
  }
  for (const stage of value.stages) {
    for (const dependency of stage.dependsOn) if (!ids.has(dependency)) fail(`missing dependency ${dependency} for stage ${stage.id}`);
  }

  const registryKeys = new Set();
  const entries = [];
  for (const entry of registry) {
    if (!entry || typeof entry !== 'object' || typeof entry.run !== 'function') fail('registry entries require run functions');
    const id = text(entry.id, 'registry.id');
    if (!Number.isSafeInteger(entry.version) || entry.version < 1) fail('registry.version must be a positive integer');
    const key = `${id}\0${entry.version}\0${entry.kind}`;
    if (!KINDS.has(entry.kind)) fail('registry.kind is unsupported');
    if (registryKeys.has(key)) fail('registry contains a duplicate adapter identity');
    registryKeys.add(key);
    entries.push(Object.freeze({ id, version: entry.version, kind: entry.kind, run: entry.run }));
  }
  const adapters = new Map();
  for (const stage of value.stages) {
    const matches = entries.filter(entry => entry.id === stage.adapter && entry.version === stage.version && entry.kind === stage.kind);
    if (matches.length !== 1) fail(`stage ${stage.id} must resolve exactly one adapter`);
    adapters.set(stage.id, matches[0]);
  }
  return { definitionId: value.id, order: stableTopologicalOrder(value.stages), adapters, context: Object.freeze({ ...context }), onEvent };
}

function inputFor(stage, outputs) {
  return Object.freeze(Object.assign(Object.create(null), Object.fromEntries(stage.dependsOn.map(id => [id, outputs.get(id)]))));
}

function event(prepared, stage, type) {
  prepared.onEvent?.(Object.freeze({ type, definitionId: prepared.definitionId, stageId: stage.id, adapter: stage.adapter, version: stage.version, kind: stage.kind }));
}

function result(prepared, outputs) {
  return Object.freeze({ order: Object.freeze(prepared.order.map(stage => stage.id)), outputs: Object.freeze(Object.assign(Object.create(null), Object.fromEntries(outputs))) });
}

export function executeTrustedHostStages({ definition, registry, context = {}, onEvent } = {}) {
  const prepared = prepare(definition, registry, context, onEvent);
  const outputs = new Map();
  for (const stage of prepared.order) {
    event(prepared, stage, 'stage_started');
    try {
      const output = prepared.adapters.get(stage.id).run(Object.freeze({ context: prepared.context, inputs: inputFor(stage, outputs), config: stage.config }));
      if (output !== null && (typeof output === 'object' || typeof output === 'function') && typeof output.then === 'function') fail(`stage ${stage.id} returned a thenable to the synchronous executor`);
      outputs.set(stage.id, output);
    } catch (error) {
      event(prepared, stage, 'stage_failed');
      throw error;
    }
    event(prepared, stage, 'stage_completed');
  }
  return result(prepared, outputs);
}

export async function executeTrustedHostStagesAsync({ definition, registry, context = {}, onEvent } = {}) {
  const prepared = prepare(definition, registry, context, onEvent);
  const outputs = new Map();
  for (const stage of prepared.order) {
    event(prepared, stage, 'stage_started');
    try {
      outputs.set(stage.id, await prepared.adapters.get(stage.id).run(Object.freeze({ context: prepared.context, inputs: inputFor(stage, outputs), config: stage.config })));
    } catch (error) {
      event(prepared, stage, 'stage_failed');
      throw error;
    }
    event(prepared, stage, 'stage_completed');
  }
  return result(prepared, outputs);
}
