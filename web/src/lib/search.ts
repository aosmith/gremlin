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

// ── DuckDuckGo (Instant Answer API) ──────────────────────────────────────────

async function searchDuckDuckGo(query: string, settings: Settings, signal?: AbortSignal): Promise<string> {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`
  const resp = await proxiedFetch(url, { method: 'GET', signal }, settings)
  if (!resp.ok) throw new Error(`DuckDuckGo search failed: ${resp.status}`)
  const data = await resp.json()
  const results: SearchResult[] = []
  // Abstract (main answer)
  if (data.Abstract) {
    results.push({ title: data.Heading ?? 'Answer', url: data.AbstractURL ?? '', snippet: data.Abstract })
  }
  // Related topics
  for (const topic of (data.RelatedTopics ?? []).slice(0, 7)) {
    if (topic.Text && topic.FirstURL) {
      results.push({ title: topic.Text.split(' - ')[0] ?? '', url: topic.FirstURL, snippet: topic.Text })
    }
  }
  if (results.length === 0 && data.AbstractText) {
    results.push({ title: data.Heading ?? query, url: data.AbstractURL ?? '', snippet: data.AbstractText })
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

export async function performWebSearch(
  query: string,
  settings: Settings,
  signal?: AbortSignal,
): Promise<string> {
  switch (settings.searchProvider) {
    case 'brave':      return searchBrave(query, settings, signal)
    case 'serper':     return searchSerper(query, settings, signal)
    case 'tavily':     return searchTavily(query, settings, signal)
    case 'duckduckgo': return searchDuckDuckGo(query, settings, signal)
    case 'searxng':    return searchSearXNG(query, settings, signal)
    default:           throw new Error('No search provider configured')
  }
}
