import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exporter = resolve(packageRoot, 'scripts/ops/export-overture-tiles.py');

function inspectExporter() {
  const script = String.raw`
import importlib.util
import json
import pathlib
import sys
import tempfile

spec = importlib.util.spec_from_file_location('overture_exporter', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class FakeConnection:
    description = [(name,) for name in (
        'id', 'name', 'confidence', 'basic_category', 'primary_category', 'taxonomy',
        'operating_status', 'lng', 'lat', 'address', 'locality', 'region', 'postcode',
        'country', 'websites', 'phones', 'overture_sources',
    )]
    def __init__(self):
        self.queries = []
    def execute(self, query):
        self.queries.append(query)
        return self
    def fetchall(self):
        return [(
            'gers-test', 'El Camino', 0.97, 'restaurant', 'mexican_restaurant',
            '{"primary":"mexican_restaurant","hierarchy":["food_and_drink","restaurant","latin_american_restaurant","mexican_restaurant"],"alternates":["taco_restaurant"]}',
            'open', -83.1, 42.3, '1 Test Ave', 'Detroit', 'MI', '48201', 'CA',
            '["https://example.test"]', '["+13135550100"]',
            '[{"dataset":"synthetic-provider","license":"CDLA-Permissive-2.0"}]',
        )]

fake = FakeConnection()
rows = module.export_tile(fake, [41.6, -90.5, 48.4, -82.1], '2026-08-19.0', 25, 'taco', 'overture-taco-taxonomy-v1')
identity = module.manifest_identity([41.6, -90.5, 48.4, -82.1], 1.0, '2026-08-19.0', 'taco', 'overture-taco-taxonomy-v1')
small_tiles = module.tiles([42.3, -83.2, 42.4, -83.1], 0.1)
cursor_query = module.build_query([42.3, -83.2, 42.4, -83.1], '2026-08-19.0', 26, module.category_policy('taco', 'overture-taco-taxonomy-v1'), "gers'last")
first_page = module.tile_page({}, small_tiles[0], [{'id': 'a'}, {'id': 'b'}, {'id': 'c'}], 2)
last_page = module.tile_page(first_page, small_tiles[0], [{'id': 'c'}], 2)
with tempfile.TemporaryDirectory() as directory:
    path = pathlib.Path(directory) / 'manifest.json'
    fresh = module.load_manifest(path, identity)
    path.write_text(json.dumps(fresh))
    reused = module.load_manifest(path, identity)
    next_identity = {**identity, 'release': '2026-09-16.0'}
    pinned = module.select_manifest(path, next_identity, small_tiles)
    finished = {**fresh, 'tiles': {module.tile_key(tile): {'status': 'success', 'rows': []} for tile in small_tiles}}
    module.atomic_json(path, finished)
    advanced = module.select_manifest(path, next_identity, small_tiles)
    archive = json.loads(path.with_name(path.name + '.2026-08-19.0.archive.json').read_text())
    preserved = json.loads(path.read_text())
    path.write_text(json.dumps({'version': 1, 'bbox': identity['bbox'], 'step': 1.0, 'tiles': {}}))
    try:
        module.load_manifest(path, identity)
        legacy_error = None
    except ValueError as error:
        legacy_error = str(error)
try:
    module.category_policy('taco', 'overture-pizza-taxonomy-v1')
    relabel_error = None
except ValueError as error:
    relabel_error = str(error)
print(json.dumps({
    'query': fake.queries[0],
    'query_count': len(fake.queries),
    'row': rows[0],
    'identity': identity,
    'fresh': fresh,
    'reused': reused,
    'legacy_error': legacy_error,
    'relabel_error': relabel_error,
    'pinned': pinned, 'advanced': advanced, 'archive': archive, 'preserved': preserved,
    'small_tiles': small_tiles, 'cursor_query': cursor_query,
    'first_page': first_page, 'last_page': last_page,
}))
`;
  const result = spawnSync(process.env.PYTHON || 'python3', ['-c', script, exporter], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('Taco Overture query uses an exact current taxonomy policy deterministically', () => {
  const inspected = inspectExporter();
  assert.equal(inspected.query_count, 1);
  assert.match(inspected.query, /list_has_any\(taxonomy\.hierarchy/);
  assert.match(inspected.query, /taxonomy\.alternates/);
  for (const category of ['mexican_restaurant', 'taco_restaurant', 'texmex_restaurant']) {
    assert.match(inspected.query, new RegExp(`'${category}'`));
  }
  assert.doesNotMatch(inspected.query, /categories\.primary/);
  assert.doesNotMatch(inspected.query, /latin_american_restaurant'/);
  assert.doesNotMatch(inspected.query, /mexican_grocery_store/);
  assert.match(inspected.query, /addresses\[1\]\.country = 'US'/);
  assert.match(inspected.query, /COALESCE\(operating_status, 'open'\) <> 'permanently_closed'/);
  assert(inspected.query.indexOf('ORDER BY id') < inspected.query.indexOf('LIMIT 25'));
});

test('Taco Overture rows retain actual geography, taxonomy, release, and source licenses', () => {
  const { row } = inspectExporter();
  assert.equal(row.country, 'CA', 'export mapping must preserve the selected row value rather than manufacture US');
  assert.equal(row.primary_category, 'mexican_restaurant');
  assert.equal(row.taxonomy.alternates[0], 'taco_restaurant');
  assert.equal(row.overture_release, '2026-08-19.0');
  assert.equal(row.overture_adapter, 'food-source-overture-taco-v1');
  assert.equal(row.overture_category_policy, 'overture-taco-taxonomy-v1');
  assert.deepEqual(row.overture_sources, [{ dataset: 'synthetic-provider', license: 'CDLA-Permissive-2.0' }]);
  assert.equal(row.attribution_url, 'https://docs.overturemaps.org/attribution/');
});

test('Overture manifests and adapters reject legacy or cross-product identity', () => {
  const inspected = inspectExporter();
  assert.equal(inspected.identity.version, 2);
  assert.equal(inspected.identity.entity, 'taco');
  assert.equal(inspected.identity.adapter_id, 'food-source-overture-taco-v1');
  assert.deepEqual(inspected.reused, inspected.fresh);
  assert.match(inspected.legacy_error, /manifest version mismatch/);
  assert.match(inspected.relabel_error, /Unsupported Overture category policy for taco/);
});

test('Overture pins incomplete scans and archives completed releases before renewal', () => {
  const result = inspectExporter();
  assert.equal(result.pinned.release, '2026-08-19.0');
  assert.equal(result.advanced.release, '2026-09-16.0');
  assert.deepEqual(result.advanced.tiles, {});
  assert.deepEqual(result.archive, result.preserved, 'current manifest stays intact until new acquisition succeeds');
  assert.equal(result.small_tiles.length, 1, 'floating-point progression must not create sliver tiles');
  assert.match(result.cursor_query, /AND id > 'gers''last'/);
  assert.match(result.cursor_query, /LIMIT 26/);
  assert.equal(result.identity.pagination, 'id-keyset-v1');
  assert.equal(result.first_page.status, 'partial');
  assert.equal(result.first_page.after_id, 'b');
  assert.equal(result.last_page.status, 'success');
  assert.deepEqual(result.last_page.rows.map(row => row.id), ['a', 'b', 'c']);
});
