/**
 * Web search provider implementations.
 * Each provider returns formatted text ready for LLM consumption.
 */

import type { Settings } from './types'
import { proxiedFetch } from './api'

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
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=8`
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
  const results: SearchResult[] = (data.web?.results ?? []).map((r: any) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: r.description ?? '',
  }))
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
    body: JSON.stringify({ q: query, num: 8 }),
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
      include_answer: false,
    }),
    signal,
  }, settings)
  if (!resp.ok) throw new Error(`Tavily search failed: ${resp.status} ${await resp.text()}`)
  const data = await resp.json()
  const results: SearchResult[] = (data.results ?? []).map((r: any) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: r.content ?? '',
  }))
  return formatResults(query, results)
}

// ── DuckDuckGo (HTML scrape — the JSON API is CORS-blocked in browsers) ──────

async function searchDuckDuckGo(query: string, settings: Settings, signal?: AbortSignal): Promise<string> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const resp = await proxiedFetch(url, {
    method: 'GET',
    headers: { 'Accept': 'text/html', 'User-Agent': 'Mozilla/5.0 (compatible; GREMLIN/1.0)' },
    signal,
  }, settings)
  if (!resp.ok) throw new Error(`DuckDuckGo search failed: ${resp.status}`)
  const html = await resp.text()

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
}

/**
 * Try each configured search provider in order.
 * If one fails, fall back to the next. Returns the first successful result.
 */
export async function performWebSearch(
  query: string,
  settings: Settings,
  signal?: AbortSignal,
): Promise<string> {
  const providers = settings.searchProviders?.length
    ? settings.searchProviders
    : ['duckduckgo']

  const errors: string[] = []
  for (const id of providers) {
    const fn = PROVIDER_FNS[id]
    if (!fn) { errors.push(`Unknown provider: ${id}`); continue }
    try {
      return await fn(query, settings, signal)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(`${id}: ${msg}`)
    }
  }
  throw new Error(`All search providers failed:\n${errors.join('\n')}`)
}
