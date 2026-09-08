import test from 'node:test'
import assert from 'node:assert/strict'
import { selectSourcePipelineRegions } from './source-pipeline-scope.mjs'

const config = {
  operational_regions: ['MI', 'NY'],
  regions: [
    { key: 'MI', bbox: [41, -85, 46, -82] },
    { key: 'NY', bbox: [40, -80, 45, -71] },
    { key: 'CA', bbox: [32, -125, 42, -114] },
  ],
}

test('defaults scheduled work to operational regions', () => {
  assert.deepEqual(
    selectSourcePipelineRegions(config).map(region => region.key),
    ['MI', 'NY'],
  )
})

test('allows an explicit configured region override', () => {
  assert.deepEqual(
    selectSourcePipelineRegions(config, ['CA']).map(region => region.key),
    ['CA'],
  )
})

test('drops unknown and duplicate region keys', () => {
  assert.deepEqual(
    selectSourcePipelineRegions(config, ['ca', 'UNKNOWN', 'CA']).map(region => region.key),
    ['CA'],
  )
})
