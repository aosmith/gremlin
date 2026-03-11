import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'

/**
 * Built-in CORS proxy for local development.
 * Same protocol as the Cloudflare Worker (X-Target-URL header).
 * Runs automatically — no separate proxy deployment needed in dev.
 */
function corsProxy(): Plugin {
  return {
    name: 'cors-proxy',
    configureServer(server) {
      server.middlewares.use('/cors-proxy', async (req, res) => {
        console.log(`[cors-proxy] ${req.method} → ${req.headers['x-target-url'] ?? '(no target)'}`)
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': '*',
            'Access-Control-Max-Age': '86400',
          })
          res.end()
          return
        }

        const targetUrl = req.headers['x-target-url']
        if (!targetUrl || typeof targetUrl !== 'string') {
          res.writeHead(400, { 'Content-Type': 'text/plain' })
          res.end('Missing X-Target-URL header')
          return
        }

        try {
          // Collect request body
          const chunks: Buffer[] = []
          for await (const chunk of req) chunks.push(chunk as Buffer)
          const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined

          // Forward headers, stripping hop-by-hop
          const fwdHeaders: Record<string, string> = {}
          for (const [k, v] of Object.entries(req.headers)) {
            if (v && !['x-target-url', 'host', 'connection'].includes(k)) {
              fwdHeaders[k] = Array.isArray(v) ? v[0] : v
            }
          }

          const resp = await fetch(targetUrl, {
            method: req.method ?? 'GET',
            headers: fwdHeaders,
            body,
          })

          // Forward response with CORS headers
          const respHeaders: Record<string, string> = {
            'access-control-allow-origin': '*',
            'access-control-expose-headers': '*',
          }
          resp.headers.forEach((v, k) => { respHeaders[k] = v })
          // Re-set CORS in case the target overwrote them
          respHeaders['access-control-allow-origin'] = '*'

          res.writeHead(resp.status, respHeaders)

          if (resp.body) {
            const reader = (resp.body as ReadableStream<Uint8Array>).getReader()
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              res.write(value)
            }
          }
          res.end()
        } catch (err: unknown) {
          res.writeHead(502, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' })
          res.end(`Proxy error: ${err instanceof Error ? err.message : String(err)}`)
        }
      })
    },
  }
}

/**
 * Auto-launch the Playwright browser sidecar in dev mode.
 * Starts server/browser-server.mjs as a child process and
 * tears it down when the dev server stops.
 */
function browserSidecar(): Plugin {
  let child: ChildProcess | null = null
  return {
    name: 'browser-sidecar',
    configureServer() {
      const script = resolve(__dirname, 'server/browser-server.mjs')
      if (!existsSync(script)) return
      child = spawn(process.execPath, [script], {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: resolve(__dirname),
        env: { ...process.env },
      })
      child.stdout?.on('data', (d: Buffer) => {
        const line = d.toString().trim()
        if (line) console.log(`[browser-sidecar] ${line}`)
      })
      child.stderr?.on('data', (d: Buffer) => {
        const line = d.toString().trim()
        if (line) console.error(`[browser-sidecar] ${line}`)
      })
      child.on('exit', (code) => {
        if (code && code !== 0) {
          console.warn(`[browser-sidecar] failed to start — run "npx playwright install chromium" to enable browser tools`)
        }
        child = null
      })
    },
    buildEnd() {
      if (child) { child.kill(); child = null }
    },
  }
}

export default defineConfig({
  plugins: [
    svelte(),
    viteSingleFile(),
    corsProxy(),
    browserSidecar(),
  ],
  build: {
    target: 'esnext',
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
  },
})
