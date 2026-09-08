// Keep automatic source linking limited to evidence that can establish the
// relationship without changing canonical identity or lifecycle fields.
export function sourceAutoLinkArguments(source) {
  if (source === 'osm') return ['--exact-source-id']
  if (source === 'wikidata') return ['--source-identity']
  if (source === 'all_the_places') return ['--exact-identifiers', '--min-exact-identifiers', '3']
  return []
}

export function sourceAutoLinkMode(source) {
  const args = sourceAutoLinkArguments(source)
  return args[0] || null
}
