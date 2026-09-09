import assert from 'node:assert/strict';
import test from 'node:test';
import { mapAnnArborPlanCase, mapDetroitPermit } from './transforms.mjs';

test('Detroit mapping preserves identity, address hash, dates, categories, and scale', () => {
  const value = mapDetroitPermit({ record_id: 'D-1', address: '123 Main Street, Detroit', permit_type: 'New Construction', proposed_use_type: 'Restaurant', use_group: 'B', amt_estimated_contractor_cost: '600000', num_units: '5', num_stories: '2', submitted_date: 0, issued_date: 1000, work_description: null, neighborhood: null, zip_code: null, latitude: 42.1, longitude: -83.1, zoning_designation: null });
  assert.equal(value.category, 'FOOD'); assert.equal(value.scale, 'MAJOR'); assert.equal(value.phase, 'APPROVED');
  assert.equal(value.addressHash, '8iesdn'); assert.equal(value.submittedDate.getTime(), 0); assert.equal(value.approvedDate.getTime(), 1000);
});

test('Ann Arbor mapping handles completed/cancelled phases, null geometry, and fallback category', () => {
  const completed = mapAnnArborPlanCase({ PLANNUMBER: 'P-1', ADDRESS: '5 Oak Road, Ann Arbor', TYPE: 'Land Division', CLASS: null, STATUS: 'Complete', COMPLETEYEAR: 2025, APPLICATIONYEAR: 2024, STREAMURL: null });
  assert.equal(completed.category, 'HOUSING'); assert.equal(completed.scale, 'MINOR'); assert.equal(completed.phase, 'APPROVED');
  assert.equal(completed.latitude, null); assert.equal(completed.completedDate.getUTCFullYear(), 2025);
  assert.equal(mapAnnArborPlanCase({ PLANNUMBER: 'P-2', ADDRESS: '6 Oak', TYPE: 'ZBA', STATUS: 'Withdrawn' }).phase, 'CANCELLED');
});

test('missing source identity or address is skipped without synthesizing output', () => {
  assert.equal(mapDetroitPermit({ record_id: 'D-1', address: '' }), null);
  assert.equal(mapAnnArborPlanCase({ PLANNUMBER: '', ADDRESS: 'x' }), null);
});

test('Detroit parser preserves legacy numeric and field-shape semantics', () => {
  const value = mapDetroitPermit({ record_id: 'D-2', address: '😀 1 Road', permit_type: 'Addition', proposed_use_type: null, use_group: null, amt_estimated_contractor_cost: '50000 trailing', num_units: 2.5, num_stories: '3 trailing', submitted_date: null, issued_date: null, work_description: '', neighborhood: '', zip_code: '', latitude: null, longitude: null, zoning_designation: null });
  assert.equal(value.estimatedCost, 50000); assert.equal(value.numUnits, 2.5); assert.equal(value.numStories, 3);
  assert.equal(Object.hasOwn(value, 'completedDate'), false);
  assert.equal(value.addressHash, createLegacyHash('😀 1 Road'));
});

function createLegacyHash(address) {
  const normalized = address.toLowerCase().replace(/[.,#]/g, '').replace(/\broad\b/g, 'rd').replace(/\s+/g, ' ').trim();
  let hash = 0;
  for (let index = 0; index < normalized.length; index += 1) hash = ((hash << 5) - hash + normalized.charCodeAt(index)) | 0;
  return Math.abs(hash).toString(36);
}
