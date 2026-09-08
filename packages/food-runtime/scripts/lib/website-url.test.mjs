import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeWebsiteUrl } from './website-url.mjs'

test('normalizes protocol, hash, default port, and tracking parameters', () => {
  assert.equal(
    normalizeWebsiteUrl('example.com/store/?utm_source=test&ref=menu#hours'),
    'https://example.com/store/?ref=menu'
  )
})

test('preserves meaningful path and query values', () => {
  assert.equal(
    normalizeWebsiteUrl('HTTP://www.example.com:80/location?id=42'),
    'http://www.example.com/location?id=42'
  )
})

test('rejects empty and unsupported values', () => {
  assert.equal(normalizeWebsiteUrl(''), null)
  assert.equal(normalizeWebsiteUrl('mailto:hello@example.com'), null)
  assert.equal(normalizeWebsiteUrl('not a url'), null)
})
