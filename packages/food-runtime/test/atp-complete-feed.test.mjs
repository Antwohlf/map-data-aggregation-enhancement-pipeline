import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareSourceCandidates } from '../scripts/ops/source-input-sample-report.mjs';

const scope = { region_scope: 'US', regions: [{ key: 'MI', bbox: [41.6, -90.5, 48.4, -82.1], region_codes: ['MI'] }] };
const row = (id, state = 'MI') => ({ id, name: 'Pizza Example', cuisine: 'pizza', latitude: 42.3, longitude: state === 'MI' ? -83.1 : -119, 'addr:state': state });
const options = { source: 'all_the_places', entity: 'pizza', limit: 2 };

test('ATP scopes the entire feed before its candidate cap, including rows beyond the raw prefix', () => {
  const result = prepareSourceCandidates([row('outside-1', 'CA'), row('outside-2', 'CA'), row('local')], options, scope);
  assert.equal(result.rows.length, 3);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].region, 'MI');
});

test('ATP fails before database access instead of silently truncating an oversized eligible feed', () => {
  assert.throws(() => prepareSourceCandidates([row('a'), row('b'), row('c')], options, scope), /refusing an incomplete feed/);
});

test('other adapters retain their existing bounded input semantics', () => {
  const result = prepareSourceCandidates([row('a'), row('b'), row('c')], { ...options, source: 'osm' }, scope);
  assert.equal(result.rows.length, 2);
});
