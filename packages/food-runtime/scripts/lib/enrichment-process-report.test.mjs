import assert from 'node:assert/strict';
import test from 'node:test';

import { enrichmentProcessReport } from './enrichment-process-report.mjs';

test('detects legacy relative and new absolute managed worker paths exactly', () => {
  const output = [
    '101 /usr/local/bin/node scripts/enrichment/agents/llm-classifier.mjs --worker-id legacy-classifier',
    '102 node scripts/enrichment/agents/web-scraper.mjs --worker-id legacy-scraper',
    '103 /usr/local/bin/node /tmp/synthetic/map-pipeline/packages/food-runtime/scripts/enrichment/agents/llm-classifier.mjs --worker-id launchd-classify',
    '104 /usr/local/bin/node /tmp/synthetic/map-pipeline/packages/food-runtime/scripts/enrichment/agents/web-scraper.mjs --worker-id launchd-scraper',
  ].join('\n');

  const report = enrichmentProcessReport(output, 999);
  assert.deepEqual(report.classifier, output.split('\n').filter(row => row.includes('llm-classifier.mjs')));
  assert.deepEqual(report.scraper, output.split('\n').filter(row => row.includes('web-scraper.mjs')));
});

test('does not count wrappers, ps/grep text, arguments, or a PID prefix as workers', () => {
  const output = [
    '20 /usr/local/bin/node /tmp/synthetic/map-pipeline/packages/food-runtime/production.mjs --profile food-shared --task classify',
    '21 grep llm-classifier.mjs',
    '22 sh -c node scripts/enrichment/agents/web-scraper.mjs',
    '23 ps ax -o pid=,command=',
    '24 /usr/local/bin/node /tmp/synthetic/tool.mjs scripts/enrichment/agents/llm-classifier.mjs',
    '201 node scripts/enrichment/agents/llm-classifier.mjs --worker-id real-worker',
  ].join('\n');

  const report = enrichmentProcessReport(output, 20);
  assert.deepEqual(report.classifier, ['201 node scripts/enrichment/agents/llm-classifier.mjs --worker-id real-worker']);
  assert.deepEqual(report.scraper, []);
  assert.deepEqual(report.unexpected, []);
});

test('unexpected-worker detection requires an exact directly executed archived script', () => {
  const expected = [
    '301 node scripts/enrichment/agents/coordinator.mjs',
    '302 /usr/local/bin/node /old/app/scripts/enrichment/archive/watchdog.mjs',
    '303 node /old/app/scripts/enrichment/archive/watchdog-keepalive.mjs',
    '304 node /old/app/scripts/enrichment/agents/osm-extractor.mjs',
    '305 node /old/app/scripts/enrichment/agents/sync-agent.mjs',
  ];
  const noise = [
    '306 grep watchdog.mjs',
    '307 node /tmp/synthetic/map-pipeline/production.mjs --task watchdog.mjs',
    '308 node scripts/enrichment/agents/llm-classifier.mjs --note coordinator.mjs',
  ];

  const report = enrichmentProcessReport([...expected, ...noise].join('\n'), 999);
  assert.deepEqual(report.unexpected, expected);
});
