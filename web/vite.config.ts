import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { viteSingleFile } from 'vite-plugin-singlefile'
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

export default defineConfig({
  plugins: [
    svelte(),
    viteSingleFile(),
    corsProxy(),
  ],
  build: {
    target: 'esnext',
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
  },
})
