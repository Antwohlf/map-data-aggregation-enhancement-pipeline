import { readFileSync } from 'node:fs'

const taxonomy = JSON.parse(readFileSync(new URL('../../config/pizza-style-taxonomy.json', import.meta.url), 'utf8'))

export const PIZZA_STYLES = Object.freeze([...taxonomy.styles])
export const LEGACY_PIZZA_STYLE_ALIASES = Object.freeze({ ...taxonomy.legacy_aliases })

const specificityOrder = taxonomy.specificity_order
const normalizeToken = value => String(value || '')
  .normalize('NFKC')
  .trim()
  .replace(/\s+/g, ' ')
  .toLocaleLowerCase('en-US')
const canonicalStyles = new Map(
  PIZZA_STYLES.map(style => [normalizeToken(style), style]),
)
const styleLookup = new Map([
  ...canonicalStyles,
  ...Object.entries(LEGACY_PIZZA_STYLE_ALIASES).map(([alias, style]) => [normalizeToken(alias), style]),
])

export function normalizePizzaStyle(value) {
  const rawValue = String(value || '').trim()
  if (!rawValue) return null
  const styles = rawValue
    .split(/[,;|]/)
    .map(part => styleLookup.get(normalizeToken(part)))
    .filter(Boolean)

  if (!styles.length) return 'Unknown'
  return [...new Set(styles)].sort((left, right) => specificityOrder.indexOf(left) - specificityOrder.indexOf(right))[0]
}
