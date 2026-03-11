import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { spawn, execSync, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
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

/**
 * Auto-start Ollama with OLLAMA_NUM_CTX capped to prevent KV cache
 * from consuming all memory on machines with limited unified memory.
 * Kills any existing Ollama process first so the env var takes effect.
 */
function ollamaSidecar(): Plugin {
  let child: ChildProcess | null = null
  return {
    name: 'ollama-sidecar',
    configureServer() {
      // Check if ollama binary is available
      const which = spawn('which', ['ollama'], { stdio: 'pipe' })
      which.on('close', (code) => {
        if (code !== 0) {
          console.log('[ollama-sidecar] ollama not found — skipping')
          return
        }
        // Kill existing Ollama instances so we can restart with our env
        spawn('pkill', ['-f', 'ollama'], { stdio: 'ignore' }).on('close', () => {
          setTimeout(() => {
            child = spawn('ollama', ['serve'], {
              stdio: ['ignore', 'pipe', 'pipe'],
              env: { ...process.env, OLLAMA_NUM_CTX: '8192' },
            })
            child.stdout?.on('data', (d: Buffer) => {
              const line = d.toString().trim()
              if (line) console.log(`[ollama-sidecar] ${line}`)
            })
            child.stderr?.on('data', (d: Buffer) => {
              const line = d.toString().trim()
              if (line && !line.includes('already in use')) console.log(`[ollama-sidecar] ${line}`)
            })
            child.on('exit', () => { child = null })
            console.log('[ollama-sidecar] started with OLLAMA_NUM_CTX=8192')
          }, 1000) // brief delay for old process to die
        })
      })
    },
    buildEnd() {
      if (child) { child.kill(); child = null }
    },
  }
}

/**
 * Expose system hardware info (RAM, GPU, CPU) via GET /api/system-info.
 */
function systemInfo(): Plugin {
  return {
    name: 'system-info',
    configureServer(server) {
      server.middlewares.use('/api/system-info', (_req, res) => {
        try {
          const info = {
            platform: process.platform,
            arch: process.arch,
            totalMemoryGB: 0,
            gpuName: 'Unknown',
            gpuMemoryGB: 0,
            cpuCores: 0,
          }

          if (process.platform === 'darwin') {
            const memBytes = parseInt(execSync('sysctl -n hw.memsize', { encoding: 'utf8' }).trim(), 10)
            info.totalMemoryGB = Math.round(memBytes / (1024 ** 3) * 10) / 10
            info.cpuCores = parseInt(execSync('sysctl -n hw.ncpu', { encoding: 'utf8' }).trim(), 10)
            try {
              const gpuJson = JSON.parse(execSync('system_profiler SPDisplaysDataType -json', { encoding: 'utf8' }))
              const card = gpuJson.SPDisplaysDataType?.[0]
              info.gpuName = card?.sppci_model ?? card?.chipset_model ?? 'Unknown'
            } catch { /* no GPU info */ }
            // Apple Silicon: unified memory, VRAM = total RAM
            info.gpuMemoryGB = info.totalMemoryGB
          } else if (process.platform === 'linux') {
            const meminfo = readFileSync('/proc/meminfo', 'utf8')
            const match = meminfo.match(/MemTotal:\s+(\d+)\s+kB/)
            if (match) info.totalMemoryGB = Math.round(parseInt(match[1], 10) / (1024 ** 2) * 10) / 10
            info.cpuCores = parseInt(execSync('nproc', { encoding: 'utf8' }).trim(), 10)
            try {
              const nv = execSync('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits', { encoding: 'utf8' }).trim()
              const [name, mem] = nv.split(', ')
              info.gpuName = name
              info.gpuMemoryGB = Math.round(parseInt(mem, 10) / 1024 * 10) / 10
            } catch { /* no nvidia GPU */ }
          }

          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(info))
        } catch (err: unknown) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
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
    browserSidecar(),
    ollamaSidecar(),
    systemInfo(),
  ],
  build: {
    target: 'esnext',
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
  },
})
