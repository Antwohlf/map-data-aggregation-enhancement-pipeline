const MANAGED_SCRIPTS = Object.freeze({
  classifier: 'scripts/enrichment/agents/llm-classifier.mjs',
  scraper: 'scripts/enrichment/agents/web-scraper.mjs',
});

const UNEXPECTED_SCRIPTS = Object.freeze([
  'scripts/enrichment/agents/coordinator.mjs',
  'scripts/enrichment/archive/watchdog.mjs',
  'scripts/enrichment/archive/watchdog-keepalive.mjs',
  'scripts/enrichment/agents/osm-extractor.mjs',
  'scripts/enrichment/agents/sync-agent.mjs',
]);

function directNodeScript(row, expectedScript) {
  const fields = row.match(/^\s*(\d+)\s+(\S+)\s+(\S+)(?:\s|$)/);
  if (!fields) return false;
  const executable = fields[2];
  const script = fields[3];
  if (!/(?:^|\/)node$/.test(executable)) return false;
  return script === expectedScript || script.endsWith(`/${expectedScript}`);
}

export function enrichmentProcessReport(output, currentPid = process.pid) {
  const rows = String(output || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .filter(row => Number(row.match(/^(\d+)\s/)?.[1]) !== Number(currentPid));

  return {
    classifier: rows.filter(row => directNodeScript(row, MANAGED_SCRIPTS.classifier)),
    scraper: rows.filter(row => directNodeScript(row, MANAGED_SCRIPTS.scraper)),
    unexpected: rows.filter(row => UNEXPECTED_SCRIPTS.some(script => directNodeScript(row, script))),
    ollama: rows.filter(row => row.includes('ollama')),
  };
}
