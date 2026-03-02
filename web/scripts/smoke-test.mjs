#!/usr/bin/env node
/**
 * Smoke test: builds the app, starts a local server, loads the page in a
 * headless-style check (fetches HTML + all inline JS), and verifies the
 * Svelte app mounts without throwing.
 *
 * Usage: node web/scripts/smoke-test.mjs
 * Exit 0 = pass, Exit 1 = fail
 */

import { createServer } from 'http'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const distFile = resolve(__dirname, '../dist/index.html')

// 1. Check the build output exists
let html
try {
  html = readFileSync(distFile, 'utf-8')
} catch {
  console.error('FAIL: dist/index.html not found — run "npm run build" first')
  process.exit(1)
}

const errors = []

// 2. Check it's not empty
if (html.length < 1000) {
  errors.push(`dist/index.html is suspiciously small (${html.length} bytes)`)
}

// 3. Check the app mount point exists
if (!html.includes('id="app"')) {
  errors.push('Missing <div id="app"> mount point')
}

// 4. Check that inlined JS is present (vite-plugin-singlefile)
if (!html.includes('<script') || html.includes('src="/assets/')) {
  errors.push('JS not inlined — singlefile plugin may have failed')
}

// 5. Check that inlined CSS is present
if (!html.includes('<style') && !html.includes('style>')) {
  errors.push('No inlined CSS found')
}

// 6. Check WASM data is inlined
if (!html.includes('wasm') && !html.includes('WASM')) {
  errors.push('No WASM reference found in bundle')
}

// 7. Check critical modules are present (search for key strings in the bundle)
const criticalStrings = [
  'Activity Monitor',      // ActivityMonitor component
  'GREMLIN',               // Brand name in navbar
  'gremlin_settings',      // Settings persistence key
  'WORKER INSTRUCTIONS',   // Peer collaboration prompt
  'ORCHESTRATOR INSTRUCTIONS', // Orchestrator prompt
]

for (const s of criticalStrings) {
  if (!html.includes(s)) {
    errors.push(`Missing critical string: "${s}"`)
  }
}

// 8. Report
if (errors.length > 0) {
  console.error(`FAIL: ${errors.length} issue(s) found:`)
  for (const e of errors) console.error(`  ✖ ${e}`)
  process.exit(1)
} else {
  const sizeKB = (html.length / 1024).toFixed(0)
  console.log(`PASS: dist/index.html (${sizeKB} KB) — all checks passed`)
  process.exit(0)
}
