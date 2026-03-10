#!/usr/bin/env node
/**
 * Gremlin Browser Sidecar — lightweight HTTP server wrapping Playwright.
 *
 * Agents call this via fetch('http://localhost:3131/...') to drive a
 * headless browser for verification, testing, and content extraction.
 *
 * Usage:  node server/browser-server.mjs [--port 3131] [--headed]
 */

import http from 'node:http'
import { chromium } from 'playwright'

// ── Config ──────────────────────────────────────────────────────────────────

const PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--port') ?? '3131', 10)
const HEADED = process.argv.includes('--headed')
const MAX_CONTENT = 30_000 // chars returned to agent

// ── State ───────────────────────────────────────────────────────────────────

let browser = null
let context = null
let page = null

async function ensurePage() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({ headless: !HEADED })
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: 'GremlinTDD/1.0',
    })
    page = await context.newPage()
  }
  if (!page || page.isClosed()) {
    page = await context.newPage()
  }
  return page
}

// ── Route handlers ──────────────────────────────────────────────────────────

const routes = {
  /** GET /status — health check */
  'GET /status': async () => ({
    ok: true,
    url: page && !page.isClosed() ? page.url() : null,
    title: page && !page.isClosed() ? await page.title() : null,
  }),

  /** POST /navigate { url } — go to a URL */
  'POST /navigate': async ({ url }) => {
    const p = await ensurePage()
    const resp = await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 })
    return {
      url: p.url(),
      status: resp?.status() ?? null,
      title: await p.title(),
    }
  },

  /** POST /content { selector? } — extract text content */
  'POST /content': async ({ selector }) => {
    const p = await ensurePage()
    let text
    if (selector) {
      const el = await p.$(selector)
      if (!el) return { error: `No element matches: ${selector}` }
      text = await el.innerText()
    } else {
      text = await p.innerText('body')
    }
    if (text.length > MAX_CONTENT) text = text.slice(0, MAX_CONTENT) + '\n...(truncated)'
    return { text }
  },

  /** POST /html { selector? } — extract HTML content */
  'POST /html': async ({ selector }) => {
    const p = await ensurePage()
    let html
    if (selector) {
      const el = await p.$(selector)
      if (!el) return { error: `No element matches: ${selector}` }
      html = await el.innerHTML()
    } else {
      html = await p.innerHTML('body')
    }
    if (html.length > MAX_CONTENT) html = html.slice(0, MAX_CONTENT) + '\n...(truncated)'
    return { html }
  },

  /** POST /click { selector } — click an element */
  'POST /click': async ({ selector }) => {
    const p = await ensurePage()
    await p.click(selector, { timeout: 5000 })
    await p.waitForLoadState('domcontentloaded').catch(() => {})
    return { clicked: selector, url: p.url(), title: await p.title() }
  },

  /** POST /type { selector, text, submit? } — fill an input */
  'POST /type': async ({ selector, text, submit = false }) => {
    const p = await ensurePage()
    await p.fill(selector, text, { timeout: 5000 })
    if (submit) await p.press(selector, 'Enter')
    return { filled: selector, url: p.url() }
  },

  /** POST /evaluate { js } — run JS in page context, return result */
  'POST /evaluate': async ({ js }) => {
    const p = await ensurePage()
    const result = await p.evaluate(js)
    const serialized = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
    const text = (serialized ?? '').slice(0, MAX_CONTENT)
    return { result: text }
  },

  /** POST /links — list all links on the page */
  'POST /links': async () => {
    const p = await ensurePage()
    const links = await p.evaluate(() =>
      Array.from(document.querySelectorAll('a[href]')).map(a => ({
        text: a.textContent?.trim().slice(0, 100) || '',
        href: a.href,
      })).filter(l => l.href && !l.href.startsWith('javascript:'))
    )
    return { links: links.slice(0, 200) }
  },

  /** POST /assert { selector, text?, visible?, count? } — assert conditions */
  'POST /assert': async ({ selector, text, visible, count }) => {
    const p = await ensurePage()
    const els = await p.$$(selector)
    const results = []

    if (count !== undefined) {
      const pass = els.length === count
      results.push({ check: `count === ${count}`, actual: els.length, pass })
    } else {
      if (els.length === 0) {
        return { pass: false, results: [{ check: 'exists', pass: false, detail: `No elements match: ${selector}` }] }
      }
    }

    if (visible !== undefined) {
      const isVisible = els.length > 0 && await els[0].isVisible()
      results.push({ check: `visible === ${visible}`, actual: isVisible, pass: isVisible === visible })
    }

    if (text !== undefined) {
      const actual = els.length > 0 ? (await els[0].innerText()).trim() : ''
      const pass = actual.includes(text)
      results.push({ check: `contains "${text}"`, actual: actual.slice(0, 200), pass })
    }

    if (results.length === 0 && els.length > 0) {
      results.push({ check: 'exists', pass: true })
    }

    return { pass: results.every(r => r.pass), results }
  },

  /** POST /wait { selector, state? } — wait for an element */
  'POST /wait': async ({ selector, state = 'visible' }) => {
    const p = await ensurePage()
    await p.waitForSelector(selector, { state, timeout: 10_000 })
    return { waited: selector, state }
  },

  /** POST /close — close page (not browser) */
  'POST /close': async () => {
    if (page && !page.isClosed()) await page.close()
    page = null
    return { closed: true }
  },
}

// ── HTTP server ─────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString()
      try { resolve(JSON.parse(raw)) } catch { resolve({}) }
    })
  })
}

const server = http.createServer(async (req, res) => {
  // CORS headers for browser access
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  const key = `${req.method} ${req.url?.split('?')[0]}`
  const handler = routes[key]

  if (!handler) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: `Unknown route: ${key}` }))
    return
  }

  try {
    const body = req.method === 'POST' ? await readBody(req) : {}
    const result = await handler(body)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: err.message }))
  }
})

// ── Cleanup ─────────────────────────────────────────────────────────────────

async function shutdown() {
  console.log('\nShutting down browser...')
  if (browser) await browser.close().catch(() => {})
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// ── Start ───────────────────────────────────────────────────────────────────

server.listen(PORT, '127.0.0.1', () => {
  console.log(`🧪 Gremlin Browser Sidecar running on http://127.0.0.1:${PORT}`)
  console.log(`   Mode: ${HEADED ? 'headed (visible)' : 'headless'}`)
  console.log(`   Routes: ${Object.keys(routes).join(', ')}`)
  console.log(`   Press Ctrl+C to stop\n`)
})
