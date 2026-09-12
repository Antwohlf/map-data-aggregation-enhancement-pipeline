import assert from 'node:assert/strict';
import test from 'node:test';

import { assertSupabasePlaceIdentity } from '../scripts/lib/supabase-sync-identity.mjs';

const localPizza = {
  entity: 'pizza',
  id: 192001,
  name: "Domino's Pizza",
  google_place_id: 'all_the_places:wXWdtwyGGi41WVkurN7vojwBouQ=',
  lat: 30.0374324,
  lng: -95.7990738,
  state: 'TX',
};

test('rejects the observed cross-continent public id collision with missing stable identity', () => {
  assert.throws(
    () => assertSupabasePlaceIdentity(localPizza, {
      id: 192001,
      name: 'Paisano Bistró',
      google_place_id: null,
      lat: 41.40495,
      lng: 2.17598833333333,
      state: 'CAT',
      website_url: localPizza.website_url,
      phone: 'contaminated-contact-field',
    }),
    /entity=pizza id=192001.*public stable identity missing without a strong legacy match/,
  );
});

test('allows an editorial public name change when stable identity and geography match', () => {
  assert.deepEqual(assertSupabasePlaceIdentity(localPizza, {
    ...localPizza,
    name: 'Domino’s Hockley',
  }), { ok: true, legacy: false });
});

test('rejects differing stable identities even when names and coordinates match', () => {
  assert.throws(
    () => assertSupabasePlaceIdentity(localPizza, { ...localPizza, google_place_id: 'other:place' }),
    /stable google_place_id mismatch/,
  );
});

test('rejects missing local identity and cross-entity-like records', () => {
  assert.throws(
    () => assertSupabasePlaceIdentity({ ...localPizza, google_place_id: null }, { ...localPizza, name: 'Taco House' }),
    /local stable google_place_id is missing/,
  );
  assert.throws(
    () => assertSupabasePlaceIdentity(localPizza, { ...localPizza, id: 58721, entity: 'taco' }),
    /numeric id mismatch/,
  );
});

test('accepts numeric-string ids for an exact stable identity', () => {
  assert.deepEqual(assertSupabasePlaceIdentity(localPizza, {
    ...localPizza,
    id: '192001',
  }), { ok: true, legacy: false });
});

test('accepts a legitimate strong legacy match with no public stable identity', () => {
  assert.deepEqual(assertSupabasePlaceIdentity(localPizza, {
    ...localPizza,
    google_place_id: null,
    name: 'Dominos Pizza',
    lat: '30.0374325',
    lng: '-95.7990737',
  }), { ok: true, legacy: true });
});

test('rejects an exact stable identity with a cross-continent coordinate conflict', () => {
  assert.throws(
    () => assertSupabasePlaceIdentity(localPizza, {
      ...localPizza,
      lat: 41.40495,
      lng: 2.17598833333333,
    }),
    /egregious coordinate conflict/,
  );
});

test('antipodal rounding cannot turn a geographic conflict into NaN and bypass the guard', () => {
  assert.throws(() => assertSupabasePlaceIdentity(
    { ...localPizza, lat: 45, lng: -90 },
    { ...localPizza, lat: -45, lng: 90 },
  ), /coordinate conflict/);
});

test('treats null, empty, and nonfinite coordinates as invalid rather than zero', () => {
  for (const coords of [
    { lat: null, lng: null },
    { lat: '', lng: '' },
    { lat: 'not-a-number', lng: -95.7 },
  ]) {
    assert.throws(
      () => assertSupabasePlaceIdentity(localPizza, {
        ...localPizza,
        google_place_id: null,
        ...coords,
      }),
      /public stable identity missing without a strong legacy match|invalid coordinates/,
    );
  }
});

test('does not use website or phone to rescue an identity mismatch', () => {
  assert.throws(
    () => assertSupabasePlaceIdentity(localPizza, {
      id: 192001,
      name: 'Paisano Bistró',
      google_place_id: null,
      lat: 41.40495,
      lng: 2.17598833333333,
      state: 'CAT',
      website_url: localPizza.website_url,
      phone: localPizza.phone,
    }),
    /public stable identity missing without a strong legacy match/,
  );
});
