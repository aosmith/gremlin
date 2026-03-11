/**
 * Cloudflare Browser Rendering — crawl endpoint integration.
 * https://developers.cloudflare.com/browser-rendering/rest-api/crawl-endpoint/
 *
 * Used for:
 *  1. web_fetch — render a single page and return markdown
 *  2. cloudflare search provider — crawl DuckDuckGo/Google and extract results
 */

import type { Settings } from './types'
import { proxiedFetch } from './api'

const CRAWL_BASE = 'https://api.cloudflare.com/client/v4/accounts'

function crawlUrl(accountId: string, jobId?: string): string {
  const base = `${CRAWL_BASE}/${accountId}/browser-rendering/crawl`
  return jobId ? `${base}/${jobId}` : base
}

function cfHeaders(token: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
}

/** Poll interval and limits */
const POLL_MS = 2000
const MAX_POLLS = 30  // 60 seconds max

/**
 * Fetch a single URL via Cloudflare Browser Rendering, returning markdown.
 * Submits a crawl job with limit=1, polls until done, returns the markdown content.
 */
export async function cfFetchPage(
  url: string,
  settings: Settings,
  signal?: AbortSignal,
): Promise<string> {
  const { cloudflareAccountId: accountId, cloudflareApiToken: token } = settings
  if (!accountId || !token) throw new Error('Cloudflare account ID and API token required — configure in Settings')

  // Submit crawl job
  const submitResp = await proxiedFetch(crawlUrl(accountId), {
    method: 'POST',
    headers: cfHeaders(token),
    body: JSON.stringify({
      url,
      limit: 1,
      depth: 0,
      formats: ['markdown'],
      render: true,
      rejectResourceTypes: ['image', 'media', 'font', 'stylesheet'],
    }),
    signal,
  }, settings)

  if (!submitResp.ok) {
    const text = await submitResp.text()
    throw new Error(`Cloudflare crawl submit failed: ${submitResp.status} ${text}`)
  }

  const submitData = await submitResp.json()
  const jobId = submitData.result
  if (!jobId) throw new Error('Cloudflare crawl returned no job ID')

  // Poll for completion
  for (let i = 0; i < MAX_POLLS; i++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    await new Promise((r) => setTimeout(r, POLL_MS))

    const pollResp = await proxiedFetch(
      `${crawlUrl(accountId, jobId)}?limit=1&status=completed`,
      { method: 'GET', headers: cfHeaders(token), signal },
      settings,
    )

    if (!pollResp.ok) continue

    const pollData = await pollResp.json()
    const job = pollData.result
    if (!job) continue

    // Job finished (completed, errored, or cancelled)
    if (job.status !== 'running') {
      const record = job.records?.[0]
      if (record?.markdown) return record.markdown
      if (record?.html) return record.html
      throw new Error(`Cloudflare crawl finished with status "${job.status}" but no content`)
    }
  }

  throw new Error('Cloudflare crawl timed out')
}

/**
 * Search the web via Cloudflare Browser Rendering.
 * Crawls DuckDuckGo (which renders properly in a headless browser) and
 * extracts search results from the rendered page.
 */
export async function cfSearch(
  query: string,
  settings: Settings,
  signal?: AbortSignal,
): Promise<string> {
  const { cloudflareAccountId: accountId, cloudflareApiToken: token } = settings
  if (!accountId || !token) throw new Error('Cloudflare account ID and API token required — configure in Settings')

  const ddgUrl = `https://duckduckgo.com/?q=${encodeURIComponent(query)}`

  // Submit crawl job for the search results page
  const submitResp = await proxiedFetch(crawlUrl(accountId), {
    method: 'POST',
    headers: cfHeaders(token),
    body: JSON.stringify({
      url: ddgUrl,
      limit: 1,
      depth: 0,
      formats: ['markdown'],
      render: true,
      rejectResourceTypes: ['image', 'media', 'font', 'stylesheet'],
      gotoOptions: { waitUntil: 'networkidle0', timeout: 15000 },
      waitForSelector: { selector: '.result, .react-results--main, [data-testid="result"]', timeout: 10000 },
    }),
    signal,
  }, settings)

  if (!submitResp.ok) {
    const text = await submitResp.text()
    throw new Error(`Cloudflare search submit failed: ${submitResp.status} ${text}`)
  }

  const submitData = await submitResp.json()
  const jobId = submitData.result
  if (!jobId) throw new Error('Cloudflare search returned no job ID')

  // Poll for completion
  for (let i = 0; i < MAX_POLLS; i++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    await new Promise((r) => setTimeout(r, POLL_MS))

    const pollResp = await proxiedFetch(
      `${crawlUrl(accountId, jobId)}?limit=1&status=completed`,
      { method: 'GET', headers: cfHeaders(token), signal },
      settings,
    )

    if (!pollResp.ok) continue

    const pollData = await pollResp.json()
    const job = pollData.result
    if (!job) continue

    if (job.status !== 'running') {
      const record = job.records?.[0]
      const content = record?.markdown || record?.html || ''
      if (!content) throw new Error('Cloudflare search completed but returned no content')
      return `## Search results for "${query}"\n\n${content}`
    }
  }

  throw new Error('Cloudflare search timed out')
}
