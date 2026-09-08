/**
 * Normalize a user- or source-supplied website URL without changing its
 * destination. Redirects remain the server's responsibility.
 */
export function normalizeWebsiteUrl(value) {
  let text = String(value ?? '').trim()
  if (!text) return null

  text = text.replace(/^['"`]+|['"`]+$/g, '').trim()
  if (!text) return null

  if (/^[a-z][a-z\d+.-]*:/i.test(text) && !/^https?:\/\//i.test(text)) return null

  const withProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(text)
    ? text
    : `https://${text}`

  try {
    const url = new URL(withProtocol)
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return null

    url.hash = ''
    url.username = ''
    url.password = ''
    if ((url.protocol === 'https:' && url.port === '443') ||
        (url.protocol === 'http:' && url.port === '80')) {
      url.port = ''
    }

    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_[^=]+|fbclid|gclid|mc_cid|mc_eid)$/i.test(key)) {
        url.searchParams.delete(key)
      }
    }

    return url.toString()
  } catch {
    return null
  }
}
