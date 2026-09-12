import assert from 'node:assert/strict'
import test from 'node:test'

import {
  sourceIdentifierMatch,
  sourceMatchMethod,
} from '../scripts/ops/source-input-sample-report.mjs'

test('identifier with a zero name score is review-only', () => {
  const identifier = sourceIdentifierMatch(
    { phone: '(313) 555-0118', website: null },
    { phone: '3135550118', website_url: null },
  )
  assert.deepEqual(identifier, { website: false, phone: true, exact: true })
  assert.equal(sourceMatchMethod(11.1, 0, identifier.exact), 'spatial_only_review')
})

test('positive-name phone and store URL variants remain exact identifier matches', () => {
  const phone = sourceIdentifierMatch(
    { phone: '(313) 555-0118', website: null },
    { phone: '3135550118', website_url: null },
  )
  assert.equal(sourceMatchMethod(11.1, 0.5, phone.exact), 'exact_identifier_nearby')

  const website = sourceIdentifierMatch(
    { phone: null, website: 'https://example.test/store/a' },
    { phone: null, website_url: 'https://example.test/store/a' },
  )
  assert.equal(sourceMatchMethod(11.1, 0.85, website.exact), 'exact_identifier_nearby')
})
