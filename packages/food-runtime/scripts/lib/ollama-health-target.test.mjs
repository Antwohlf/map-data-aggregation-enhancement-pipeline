import assert from 'node:assert/strict';
import test from 'node:test';
import { ollamaHealthTarget } from './ollama-health-target.mjs';

test('local Ollama settings are honored without requiring the obsolete tunnel', () => {
  for (const baseUrl of ['http://localhost:11434', 'http://127.0.0.1:11434']) {
    assert.deepEqual(ollamaHealthTarget({ OLLAMA_URL: baseUrl }), { baseUrl, requiresTunnel: false });
  }
});
test('explicit health override and legacy tunnel configuration remain supported', () => {
  assert.equal(ollamaHealthTarget({}).requiresTunnel, true);
  assert.equal(ollamaHealthTarget({ OLLAMA_URL: 'http://127.0.0.1:11435' }).requiresTunnel, true);
  assert.deepEqual(ollamaHealthTarget({ CLASSIFIER_OLLAMA_URL: 'https://inference.example.test/', OLLAMA_URL: 'http://localhost:11434' }), { baseUrl: 'https://inference.example.test', requiresTunnel: false });
});
