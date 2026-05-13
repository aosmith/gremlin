/**
 * Web search provider implementations.
 * Each provider returns formatted text ready for LLM consumption.
 */

import type { Settings } from './types'
import { proxiedFetch } from './api'
import { cfSearch } from './cloudflare'

interface SearchResult {
  title: string
  url: string
  snippet: string
}

function formatResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) return `No results found for "${query}".`
  const items = results
    .slice(0, 8)
    .map((r, i) => `${i + 1}. **${r.title}** — ${r.url}\n   ${r.snippet}`)
    .join('\n\n')
  return `## Search results for "${query}"\n\n${items}`
}

// ── Brave Search ──────────────────────────────────────────────────────────────

async function searchBrave(query: string, settings: Settings, signal?: AbortSignal): Promise<string> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=8&extra_snippets=true`
  const resp = await proxiedFetch(url, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': settings.searchApiKey,
    },
    signal,
  }, settings)
  if (!resp.ok) throw new Error(`Brave search failed: ${resp.status} ${await resp.text()}`)
  const data = await resp.json()
  const results: SearchResult[] = (data.web?.results ?? []).map((r: any) => {
    // Brave returns extra_snippets array with additional context when available
    const extras: string[] = r.extra_snippets ?? []
    const allSnippets = [r.description ?? '', ...extras].filter(Boolean).join(' … ')
    return { title: r.title ?? '', url: r.url ?? '', snippet: allSnippets }
  })
  return formatResults(query, results)
}

// ── Serper (Google results) ───────────────────────────────────────────────────

async function searchSerper(query: string, settings: Settings, signal?: AbortSignal): Promise<string> {
  const resp = await proxiedFetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': settings.searchApiKey,
    },
    body: JSON.stringify({ q: query, num: 10 }),
    signal,
  }, settings)
  if (!resp.ok) throw new Error(`Serper search failed: ${resp.status} ${await resp.text()}`)
  const data = await resp.json()
  const results: SearchResult[] = (data.organic ?? []).map((r: any) => ({
    title: r.title ?? '',
    url: r.link ?? '',
    snippet: r.snippet ?? '',
  }))
  return formatResults(query, results)
}

// ── Tavily ────────────────────────────────────────────────────────────────────

async function searchTavily(query: string, settings: Settings, signal?: AbortSignal): Promise<string> {
  const resp = await proxiedFetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: settings.searchApiKey,
      query,
      max_results: 8,
      search_depth: 'advanced',
      include_answer: false,
      include_raw_content: true,
      days: 7,              // Prioritize content from the last 7 days
      topic: 'general',     // Could be 'news' for finance — general is safer default
    }),
    signal,
  }, settings)
  if (!resp.ok) throw new Error(`Tavily search failed: ${resp.status} ${await resp.text()}`)
  const data = await resp.json()
  const results: SearchResult[] = (data.results ?? []).map((r: any) => {
    // Prefer raw_content (full page text, truncated to useful length) over short snippet
    const raw = typeof r.raw_content === 'string' ? r.raw_content.slice(0, 1500) : ''
    const snippet = raw.length > (r.content?.length ?? 0) ? raw : (r.content ?? '')
    return { title: r.title ?? '', url: r.url ?? '', snippet }
  })
  return formatResults(query, results)
}

// ── DuckDuckGo (HTML scrape via POST — mimics real form submission) ───────────

async function searchDuckDuckGo(query: string, settings: Settings, signal?: AbortSignal): Promise<string> {
  // Use POST with form data (matches how the real HTML form works)
  const resp = await proxiedFetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'text/html' },
    body: `q=${encodeURIComponent(query)}`,
    signal,
  }, settings)
  if (!resp.ok) throw new Error(`DuckDuckGo search failed: ${resp.status}`)
  const html = await resp.text()

  // Detect captcha / bot challenge
  if (html.includes('Please complete the') || html.includes('select all squares')) {
    throw new Error('DuckDuckGo returned a captcha — try a different search provider (Brave, SearXNG)')
  }

  // Parse results from DuckDuckGo's HTML response
  const results: SearchResult[] = []
  const resultPattern = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>(.+?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi
  let match
  while ((match = resultPattern.exec(html)) !== null && results.length < 8) {
    const rawUrl = match[1]
    const title = match[2].replace(/<[^>]+>/g, '').trim()
    const snippet = match[3].replace(/<[^>]+>/g, '').trim()
    // DuckDuckGo wraps URLs in a redirect; extract the actual URL
    const actualUrl = rawUrl.includes('uddg=')
      ? decodeURIComponent(rawUrl.split('uddg=')[1]?.split('&')[0] ?? rawUrl)
      : rawUrl
    if (title && snippet) {
      results.push({ title, url: actualUrl, snippet })
    }
  }

  // Fallback: if regex didn't match, try a simpler pattern for result links
  if (results.length === 0) {
    const simpleLinkPattern = /<a[^>]+class="result__a"[^>]*>(.+?)<\/a>/gi
    while ((match = simpleLinkPattern.exec(html)) !== null && results.length < 8) {
      const title = match[1].replace(/<[^>]+>/g, '').trim()
      if (title) results.push({ title, url: '', snippet: title })
    }
  }

  return formatResults(query, results)
}

// ── SearXNG (self-hosted) ────────────────────────────────────────────────────

async function searchSearXNG(query: string, settings: Settings, signal?: AbortSignal): Promise<string> {
  const base = settings.searchEndpoint.replace(/\/$/, '')
  if (!base) throw new Error('SearXNG endpoint not configured')
  const url = `${base}/search?q=${encodeURIComponent(query)}&format=json&categories=general`
  const resp = await proxiedFetch(url, { method: 'GET', signal }, settings)
  if (!resp.ok) throw new Error(`SearXNG search failed: ${resp.status} ${await resp.text()}`)
  const data = await resp.json()
  const results: SearchResult[] = (data.results ?? []).slice(0, 8).map((r: any) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: r.content ?? '',
  }))
  return formatResults(query, results)
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

const PROVIDER_FNS: Record<string, (q: string, s: Settings, sig?: AbortSignal) => Promise<string>> = {
  brave:      searchBrave,
  serper:     searchSerper,
  tavily:     searchTavily,
  duckduckgo: searchDuckDuckGo,
  searxng:    searchSearXNG,
  cloudflare: cfSearch,
}

/**
 * Race configured search providers in parallel — first successful result wins.
 * Falls back to sequential if only one provider is configured.
 */
export async function performWebSearch(
  query: string,
  settings: Settings,
  signal?: AbortSignal,
): Promise<string> {
  const providers = settings.searchProviders?.length
    ? settings.searchProviders
    : ['duckduckgo']

  const validProviders = providers.map(id => ({ id, fn: PROVIDER_FNS[id] })).filter(p => p.fn)

  if (validProviders.length === 0) {
    throw new Error(`No valid search providers configured: ${providers.join(', ')}`)
  }

  // Single provider — just call it directly
  if (validProviders.length === 1) {
    return validProviders[0].fn!(query, settings, signal)
  }

  // Multiple providers — race them. First success wins, collect errors from failures.
  const errors: string[] = []
  const result = await new Promise<string>((resolve, reject) => {
    let settled = false
    let pending = validProviders.length

    for (const { id, fn } of validProviders) {
      fn!(query, settings, signal)
        .then((r) => {
          if (!settled) { settled = true; resolve(r) }
        })
        .catch((err) => {
          errors.push(`${id}: ${err instanceof Error ? err.message : String(err)}`)
          pending--
          if (pending === 0 && !settled) {
            settled = true
            reject(new Error(`All search providers failed:\n${errors.join('\n')}`))
          }
        })
    }
  })

  return result
}
