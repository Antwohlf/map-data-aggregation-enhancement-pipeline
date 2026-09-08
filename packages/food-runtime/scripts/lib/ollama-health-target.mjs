export function ollamaHealthTarget(env = process.env) {
  const baseUrl = (env.CLASSIFIER_OLLAMA_URL || env.OLLAMA_URL || 'http://127.0.0.1:11435').replace(/\/$/, '');
  const parsed = new URL(baseUrl);
  return {
    baseUrl,
    requiresTunnel: ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) && parsed.port === '11435',
  };
}
