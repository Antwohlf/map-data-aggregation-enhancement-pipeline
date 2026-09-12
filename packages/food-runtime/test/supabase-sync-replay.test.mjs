import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSupabaseInsertPayload, buildSupabasePayload } from '../scripts/lib/supabase-sync-policy.mjs';

const old = '2026-01-01T00:00:00.000Z';
const nowIso = '2026-02-01T00:00:00.000Z';
const place = { id: 1, name: 'Example Pizza', google_place_id: 'test:one', lat: 42, lng: -83, state: 'MI', updated_at: old, website_url: 'https://example.test/new' };
const qa = { qa_status: 'unreviewed', qa_schema_version: 1 };

for (const entity of ['pizza', 'taco']) {
  test(`${entity}: a publication timestamp difference alone does not require a write`, () => {
    assert.equal(buildSupabasePayload(place, { ...place, ...qa, updated_at: nowIso }, { entity }), null);
  });

  test(`${entity}: first substantive update followed by exact replay is a no-op`, () => {
    const current = { ...place, ...qa, website_url: 'https://example.test/old', status: 'visited', notes: 'private review' };
    const payload = buildSupabasePayload(place, current, { entity, nowIso });
    assert.deepEqual(payload, { id: 1, website_url: place.website_url, updated_at: nowIso });
    assert.equal(buildSupabasePayload(place, { ...current, ...payload }, { entity }), null);
  });

  test(`${entity}: real changes stamp publication time even when source timestamp differs`, () => {
    const payload = buildSupabasePayload(place, { ...place, ...qa, website_url: 'https://example.test/old', updated_at: '2026-01-15T00:00:00.000Z' }, { entity, nowIso });
    assert.equal(payload.updated_at, nowIso);
  });

  test(`${entity}: insert still preserves supplied source timestamps`, () => {
    assert.equal(buildSupabaseInsertPayload(place, { entity, nowIso }).updated_at, old);
  });
}

test('QA defaults count as real changes, then replay is a no-op', () => {
  const payload = buildSupabasePayload(place, place, { nowIso });
  assert.deepEqual(payload, { id: 1, ...qa, updated_at: nowIso });
  assert.equal(buildSupabasePayload(place, { ...place, ...payload }), null);
});

test('no-op detection never bypasses identity checks', () => {
  assert.throws(() => buildSupabasePayload(place, { ...place, ...qa, google_place_id: 'test:other', updated_at: nowIso }), /identity check failed/);
});
