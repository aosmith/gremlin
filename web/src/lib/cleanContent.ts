/** Fix literal newlines inside JSON strings so JSON.parse works. */
function fixJsonNewlines(text: string): string {
  let out = ''
  let inStr = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (ch === '\\') { out += ch + (text[i + 1] ?? ''); i++; continue }
      if (ch === '"') { inStr = false; out += ch; continue }
      if (ch === '\n') { out += '\\n'; continue }
      if (ch === '\r') { out += '\\r'; continue }
      out += ch
    } else {
      if (ch === '"') inStr = true
      out += ch
    }
  }
  return out
}

/** snake_case / camelCase → Title Case */
function prettifyName(name: string): string {
  return name
    .replace(/[_-]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

/** Try to parse a string as JSON, handling malformed newlines. */
function tryParseJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(fixJsonNewlines(trimmed.slice(start, end + 1)))
  } catch {
    return null
  }
}

/** Strip visual noise: block chars (████), excessive stars, decorative lines. */
function cleanVisualNoise(text: string): string {
  return text
    .replace(/[█▓▒░]{2,}/g, '')                   // block character bars
    .replace(/[★☆]{3,}/g, (m) => m.slice(0, 2))   // collapse long star runs to 2
    .replace(/[─━═]{4,}/g, '---')                  // decorative lines → simple hr
    .replace(/[🔸🔹🔺🔻◆◇●○■□▪▫]{3,}/g, '')     // excessive decorative symbols
    .replace(/\n{3,}/g, '\n\n')                    // collapse blank lines
    .trim()
}


/** Apply all agent text formatters (sources, send_message calls, embedded tool JSON). */
function formatAgentText(text: string): string {
  return formatSendMessageCalls(formatSourceCitations(formatEmbeddedToolCalls(text)))
}

/**
 * Detect raw JSON tool-call objects embedded in prose text.
 * Models sometimes dump tool calls as text instead of using the tool-calling API.
 * Uses proper JSON parsing (not regex) to handle arbitrarily nested content.
 */
function formatEmbeddedToolCalls(text: string): string {
  // Strip common LLM preamble around tool calls
  let cleaned = text.replace(/Here\s+is\s+a\s+JSON\s+for\s+a\s+function\s+call\s+that\s+best\s+answers\s+the\s+given\s+prompt\s*:?\s*/gi, '')

  // Try to parse the entire text as a JSON array of tool calls: [{"name": "send_message", ...}, ...]
  const trimmed = cleaned.trim()
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(fixJsonNewlines(trimmed))
      if (Array.isArray(arr) && arr.length > 0 && arr[0]?.name) {
        return arr.map(formatToolCallObj).filter(Boolean).join('\n\n')
      }
    } catch { /* not a valid array, fall through */ }
  }

  // Scan for embedded JSON objects starting with {"name": and extract them
  const parts: string[] = []
  let pos = 0
  while (pos < cleaned.length) {
    // Find next potential tool-call JSON object
    const marker = cleaned.indexOf('{"name"', pos)
    if (marker === -1) {
      parts.push(cleaned.slice(pos))
      break
    }

    // Keep any prose before the JSON
    const before = cleaned.slice(pos, marker).trim()
    if (before) parts.push(before)

    // Try to extract a balanced JSON object starting at marker
    const extracted = extractJsonObject(cleaned, marker)
    if (extracted) {
      try {
        const obj = JSON.parse(fixJsonNewlines(extracted.json))
        const formatted = formatToolCallObj(obj)
        if (formatted) {
          parts.push(formatted)
          pos = extracted.end
          continue
        }
      } catch { /* parse failed, treat as text */ }
    }

    // Couldn't parse — skip past this marker
    parts.push(cleaned.slice(marker, marker + 7))
    pos = marker + 7
  }

  return parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** Extract a balanced JSON object from text starting at `start`. */
function extractJsonObject(text: string, start: number): { json: string; end: number } | null {
  if (text[start] !== '{') return null
  let depth = 0
  let inStr = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (ch === '\\') { i++; continue }
      if (ch === '"') inStr = false
    } else {
      if (ch === '"') inStr = true
      else if (ch === '{') depth++
      else if (ch === '}') { depth--; if (depth === 0) return { json: text.slice(start, i + 1), end: i + 1 } }
    }
  }
  return null
}

/** Format a single tool-call JSON object into readable text. */
function formatToolCallObj(obj: Record<string, unknown>): string | null {
  if (!obj || typeof obj.name !== 'string') return null
  const params = (obj.parameters ?? obj.params ?? {}) as Record<string, unknown>

  if (obj.name === 'send_message') {
    const to = String(params.to ?? '')
    const content = String(params.content ?? '')
    if (to && content) return `→ **${to}**: ${content}`
  }
  if (obj.name === 'mark_done') {
    const result = params.result ? String(params.result) : null
    return result ? `✔ Done: ${result}` : '✔ Done'
  }
  if (obj.name === 'web_search') {
    return `Searching: ${String(params.query ?? '')}`
  }
  if (obj.name === 'web_fetch') {
    return `Fetching: ${String(params.url ?? '')}`
  }
  if (obj.name === 'browse_navigate') {
    return `Browsing: ${String(params.url ?? '')}`
  }

  // Generic tool call
  const argStr = Object.entries(params).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ')
  return `🔧 ${prettifyName(obj.name)}(${argStr})`
}

/**
 * Handle batched send_message where `to` and/or `content` may be arrays.
 * e.g. {"to": ["Agent1", "Agent2"], "content": ["msg1", "msg2"]}
 * or {"to": "Agent1", "content": "msg1"}
 */
function formatBatchedSendMessage(params: Record<string, unknown>): string | null {
  const toVal = params.to
  const contentVal = params.content ?? params.message ?? params.text
  if (!toVal || !contentVal) return null

  const toArr = Array.isArray(toVal) ? toVal.map(String) : [String(toVal)]
  const contentArr = Array.isArray(contentVal) ? contentVal.map(String) : [String(contentVal)]

  const parts: string[] = []
  for (let i = 0; i < toArr.length; i++) {
    const to = toArr[i]
    const content = contentArr[i] ?? contentArr[0] ?? ''
    if (to && content) parts.push(`→ **${prettifyName(to)}**: ${content}`)
  }
  return parts.length > 0 ? parts.join('\n\n') : null
}

/** Format [source: web_search("query")] citations into clean inline references. */
function formatSourceCitations(text: string): string {
  return text.replace(
    /\[source:\s*web_search\(\s*["']([^"']+)["']\s*\)\s*\]/gi,
    '**🔍 $1** —'
  )
}

/** Convert bare send_message() calls into readable → Agent: content lines.
 *  Handles both positional args: send_message("Agent", "content")
 *  and keyword args: send_message(to="Agent", content="content")
 */
function formatSendMessageCalls(text: string): string {
  return text
    // Keyword args: send_message(to="Agent", content="...")
    .replace(
      /send_message\(\s*to\s*=\s*"([^"]+)"\s*,\s*content\s*=\s*"((?:[^"\\]|\\.)*)"\s*\)/g,
      (_match, agent: string, content: string) => {
        const cleaned = content.replace(/\\"/g, '"').replace(/\\n/g, '\n')
        return `→ **${agent}**: ${cleaned}`
      }
    )
    // Keyword args reversed order: send_message(content="...", to="Agent")
    .replace(
      /send_message\(\s*content\s*=\s*"((?:[^"\\]|\\.)*)"\s*,\s*to\s*=\s*"([^"]+)"\s*\)/g,
      (_match, content: string, agent: string) => {
        const cleaned = content.replace(/\\"/g, '"').replace(/\\n/g, '\n')
        return `→ **${agent}**: ${cleaned}`
      }
    )
    // Positional args: send_message("Agent", "content")
    .replace(
      /send_message\(\s*"([^"]+)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*\)/g,
      (_match, agent: string, content: string) => {
        const cleaned = content.replace(/\\"/g, '"').replace(/\\n/g, '\n')
        return `→ **${agent}**: ${cleaned}`
      }
    )
}

/**
 * Format agent JSON into readable text for the Activity Monitor / Agent Panel.
 * Compact single-line format.
 */
export function cleanContent(raw: string): string {
  // Strip [From/To AgentName]: prefixes — route info is already shown in the header
  const stripped = cleanVisualNoise(raw.replace(/\[(?:From|To)\s+[^\]]+\]\s*:?\s*/gi, '').trim())

  const trimmed = stripped.trim()

  // Handle top-level arrays (e.g. raw data from agents, or arrays of tool calls)
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(fixJsonNewlines(trimmed))
      if (Array.isArray(arr) && arr.length > 0) {
        // Check if it's an array of tool calls
        if (arr[0]?.name && (arr[0]?.parameters || arr[0]?.params)) {
          const formatted = arr.map(formatToolCallObj).filter(Boolean).join('\n\n')
          if (formatted) return formatted
        }
        return prettifySnakeCase(arr.map((item) =>
          typeof item === 'string' ? item
          : typeof item === 'object' && item !== null ? renderObject(item as Record<string, unknown>)
          : String(item)
        ).join('\n\n'))
      }
    } catch { /* not valid JSON array, fall through */ }
  }

  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return formatAgentText(stripped)

  const obj = tryParseJson(trimmed)
  if (!obj) return formatAgentText(stripped)

  // Intercept tool-call JSON objects: {"name": "send_message", "parameters": {...}}
  if (typeof obj.name === 'string' && (obj.parameters || obj.params)) {
    const formatted = formatToolCallObj(obj)
    if (formatted) return formatted
  }

  // Intercept tool-call-like objects with type/function patterns
  if (typeof obj.type === 'string' && obj.type === 'function' && typeof obj.function === 'object') {
    const fn = obj.function as Record<string, unknown>
    const formatted = formatToolCallObj({ name: String(fn.name ?? ''), parameters: fn.arguments ?? fn.parameters ?? {} })
    if (formatted) return formatted
  }

  // Intercept send_message as a top-level key: {"send_message": {"to": ..., "content": ...}}
  // or {"send_message": {"parameters": {"to": ..., "content": ...}}}
  if (obj.send_message != null && typeof obj.send_message === 'object') {
    const sm = obj.send_message as Record<string, unknown>
    const params = (sm.parameters ?? sm.params ?? sm) as Record<string, unknown>
    const formatted = formatBatchedSendMessage(params)
    if (formatted) return formatted
  }

  // Intercept function_call wrapper: {"function_call": {"name": "send_message", "arguments": {...}}}
  if (obj.function_call != null && typeof obj.function_call === 'object') {
    const fc = obj.function_call as Record<string, unknown>
    const args = typeof fc.arguments === 'string'
      ? (() => { try { return JSON.parse(fc.arguments as string) } catch { return fc.arguments } })()
      : (fc.arguments ?? fc.parameters ?? {})
    const formatted = formatToolCallObj({ name: String(fc.name ?? ''), parameters: args })
    if (formatted) return formatted
  }

  const parts: string[] = []

  // Handle analysis — may be string or object
  if (obj.analysis != null) {
    if (typeof obj.analysis === 'string' && obj.analysis.trim()) {
      const cleaned = formatAgentText(obj.analysis.trim())
      if (cleaned) parts.push(cleaned)
    } else if (typeof obj.analysis === 'object') {
      parts.push(renderObject(obj.analysis as Record<string, unknown>))
    }
  }

  // Handle digest — orchestrator coordination summaries
  if (obj.digest != null && typeof obj.digest === 'object') {
    const digest = obj.digest as Record<string, unknown>
    for (const [agent, summary] of Object.entries(digest)) {
      if (typeof summary === 'string' && summary.trim()) {
        parts.push(`**${prettifyName(agent)}**: ${summary.trim()}`)
      }
    }
  }

  if (Array.isArray(obj.messages) && obj.messages.length > 0) {
    for (const m of obj.messages) {
      // Handle various field name conventions models use
      const to = m.to ?? m.toAgentId ?? m.toAgent ?? m.to_agent ?? m.agent ?? m.recipient ?? ''
      const content = m.content ?? m.message ?? m.text ?? ''
      if (to && content) {
        // Content itself may contain embedded JSON — clean it recursively
        const contentStr = typeof content === 'string' ? content : JSON.stringify(content)
        parts.push(`  \u2192 ${prettifyName(String(to))}: ${cleanContent(contentStr)}`)
      }
    }
  }

  if (obj.done === true) parts.push('\u2714 Done')

  if (typeof obj.result === 'string' && obj.result.trim()) {
    parts.push(`\u2605 Result: ${obj.result.trim()}`)
  }

  // Handle tool_calls arrays (OpenAI function calling format)
  if (Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0) {
    for (const tc of obj.tool_calls) {
      if (tc?.function?.name) {
        let params = tc.function.arguments ?? tc.function.parameters ?? {}
        if (typeof params === 'string') try { params = JSON.parse(params) } catch { /* keep as string */ }
        const formatted = formatToolCallObj({ name: tc.function.name, parameters: params })
        if (formatted) parts.push(formatted)
      }
    }
  }

  // If we parsed JSON but got nothing from protocol fields, render all
  // values as readable key-value pairs instead of raw JSON
  // Skip internal/protocol fields that shouldn't be shown to the user
  const skipKeys = new Set(['done', 'parameters', 'params', 'popupQuery', 'popup_query', 'toAgentId', 'toAgent', 'to_agent', 'tool_calls', 'function', 'type'])
  if (parts.length === 0) {
    for (const [key, val] of Object.entries(obj)) {
      if (val === null || val === undefined) continue
      if (skipKeys.has(key)) continue
      if (typeof val === 'string' && val.trim()) {
        parts.push(`**${prettifyName(key)}**: ${val.trim()}`)
      } else if (typeof val === 'number' || typeof val === 'boolean') {
        parts.push(`**${prettifyName(key)}**: ${val}`)
      } else if (Array.isArray(val) && val.length > 0) {
        const items = val.map((v) =>
          typeof v === 'string' ? v
          : typeof v === 'object' && v !== null ? renderObject(v as Record<string, unknown>)
          : String(v)
        )
        parts.push(`**${prettifyName(key)}**:\n${items.map((i) => `  • ${i}`).join('\n')}`)
      } else if (typeof val === 'object') {
        parts.push(renderObject(val as Record<string, unknown>, prettifyName(key)))
      }
    }
  }

  return prettifySnakeCase(parts.length > 0 ? parts.join('\n') : stripped)
}

/**
 * Format output for the Results Modal.
 * Produces styled Markdown with all fields visible.
 * Handles both plain Markdown (new) and legacy JSON-wrapped output.
 */
export function formatOutputAsMarkdown(raw: string): string {
  if (!raw) return ''

  // Strip routing prefixes before processing
  const cleaned = cleanVisualNoise(raw.replace(/\[(?:From|To)\s+[^\]]+\]\s*:?\s*/gi, ''))

  // Try to parse as JSON (legacy format or raw model JSON)
  const obj = tryParseJson(cleaned)
  if (!obj) {
    // Not JSON — already human-readable, just clean up snake_case names
    return prettifySnakeCase(cleaned)
  }

  // Check for structured portfolio format (from finance synthesizer)
  const portfolio = tryRenderPortfolio(obj)
  if (portfolio) return portfolio

  // Check for Polymarket trade report format
  const polyReport = tryRenderPolymarketReport(obj)
  if (polyReport) return polyReport

  // If it parsed as JSON, extract human-readable content from protocol fields
  const sections: string[] = []

  const hasResult = typeof obj.result === 'string' && obj.result.trim().length > 0
  const hasAnalysis = typeof obj.analysis === 'string' && obj.analysis.trim().length > 0

  if (hasResult) {
    const resultText = (obj.result as string).trim()
    sections.push(formatOutputAsMarkdown(resultText))

    if (hasAnalysis) {
      const analysisText = (obj.analysis as string).trim()
      if (analysisText.length > 50 && analysisText !== resultText) {
        sections.push(`### Analysis\n\n${prettifySnakeCase(analysisText)}`)
      }
    }
  } else if (hasAnalysis) {
    sections.push(formatOutputAsMarkdown((obj.analysis as string).trim()))
  }

  if (Array.isArray(obj.messages) && obj.messages.length > 0) {
    const items = obj.messages
      .filter((m: any) => m.to && m.content)
      .map((m: any) => `- **${prettifyName(String(m.to))}** — ${m.content}`)
    if (items.length > 0) {
      sections.push(`### Directives\n\n${items.join('\n')}`)
    }
  }

  return sections.length > 0 ? sections.join('\n\n---\n\n') : prettifySnakeCase(raw)
}

// ── Portfolio JSON renderer ──────────────────────────────────────────────────

interface PortfolioPosition {
  ticker: string
  company: string
  weight: number
  conviction: string
  price?: string
  fairValue?: string
  upside?: string
  catalyst: string
  risk: string
  thesis?: string
}

interface PortfolioData {
  positions: PortfolioPosition[]
  summary?: string
  risks?: string[]
  sectors?: Record<string, number>
  watchlist?: string[]
}

/**
 * Detect and render structured portfolio JSON.
 * Returns markdown string if the object matches the portfolio schema, null otherwise.
 */
function tryRenderPortfolio(obj: Record<string, unknown>): string | null {
  // Check for portfolio schema — either at top level or nested in result
  let data: PortfolioData | null = null

  if (Array.isArray(obj.positions) && obj.positions.length > 0) {
    data = obj as unknown as PortfolioData
  } else if (typeof obj.result === 'string') {
    const inner = tryParseJson(obj.result)
    if (inner && Array.isArray(inner.positions) && inner.positions.length > 0) {
      data = inner as unknown as PortfolioData
    }
  }

  if (!data) return null
  return renderPortfolioMarkdown(data)
}

/** Ensure ticker always has $ prefix so highlightTickers can style it. */
function normTicker(t: string): string {
  const s = t.trim().replace(/^\$+/, '')
  return s ? `$${s}` : t
}

function renderPortfolioMarkdown(data: PortfolioData): string {
  const sections: string[] = []

  // Summary
  if (data.summary) {
    sections.push(data.summary)
  }

  // Portfolio table (will become cards via enhanceProse since it has 5+ columns)
  const positions = data.positions
  const hasPrice = positions.some((p) => p.price)
  const hasFV = positions.some((p) => p.fairValue)
  const hasUpside = positions.some((p) => p.upside)

  // Merge ticker+company into "Position" column → becomes a better card title
  let header = '| Position | Weight | Conviction'
  let sep = '|---|---|---'
  if (hasPrice) { header += ' | Price'; sep += '|---' }
  if (hasFV) { header += ' | Fair Value'; sep += '|---' }
  if (hasUpside) { header += ' | Upside'; sep += '|---' }
  header += ' | Catalyst | Risk |'
  sep += '|---|---|'

  const rows = positions.map((p) => {
    const ticker = normTicker(p.ticker)
    let row = `| ${ticker} — ${p.company} | ${p.weight}% | ${p.conviction}`
    if (hasPrice) row += ` | ${p.price ?? '-'}`
    if (hasFV) row += ` | ${p.fairValue ?? '-'}`
    if (hasUpside) row += ` | ${p.upside ?? '-'}`
    row += ` | ${p.catalyst} | ${p.risk} |`
    return row
  })

  sections.push(`## Portfolio\n\n${header}\n${sep}\n${rows.join('\n')}`)

  // Per-position theses
  const theses = positions.filter((p) => p.thesis && p.thesis.trim().length > 20)
  if (theses.length > 0) {
    const thesisSections = theses.map((p) =>
      `### ${normTicker(p.ticker)} — ${p.company}\n\n${p.thesis}`
    ).join('\n\n')
    sections.push(`## Investment Theses\n\n${thesisSections}`)
  }

  // Sector allocation
  if (data.sectors && Object.keys(data.sectors).length > 0) {
    const sectorLines = Object.entries(data.sectors)
      .sort(([, a], [, b]) => b - a)
      .map(([sector, weight]) => `- **${sector}**: ${weight}%`)
    sections.push(`## Sector Allocation\n\n${sectorLines.join('\n')}`)
  }

  // Portfolio risks
  if (data.risks && data.risks.length > 0) {
    const riskLines = data.risks.map((r) => `- ${r}`)
    sections.push(`## Portfolio Risks\n\n${riskLines.join('\n')}`)
  }

  // Watchlist
  if (data.watchlist && data.watchlist.length > 0) {
    const watchLines = data.watchlist.map((w) => `- ${w}`)
    sections.push(`## Watchlist & Exits\n\n${watchLines.join('\n')}`)
  }

  return sections.join('\n\n---\n\n')
}

// ── Polymarket trade report renderer ─────────────────────────────────────────

interface PolymarketTrade {
  market: string
  category?: string
  currentPrice: number
  estimatedProb?: number
  edge?: string
  position: string
  conviction: string
  entryTarget?: string
  size?: string
  thesis?: string
}

interface PolymarketReport {
  trades: PolymarketTrade[]
  summary?: string
  hedges?: string[]
  risks?: string[]
  watchlist?: string[]
}

/**
 * Detect and render structured Polymarket trade report JSON.
 * Returns markdown string if the object matches the schema, null otherwise.
 */
function tryRenderPolymarketReport(obj: Record<string, unknown>): string | null {
  let data: PolymarketReport | null = null

  if (Array.isArray(obj.trades) && obj.trades.length > 0) {
    data = obj as unknown as PolymarketReport
  } else if (typeof obj.result === 'string') {
    const inner = tryParseJson(obj.result)
    if (inner && Array.isArray(inner.trades) && inner.trades.length > 0) {
      data = inner as unknown as PolymarketReport
    }
  }

  if (!data) return null
  return renderPolymarketMarkdown(data)
}

function renderPolymarketMarkdown(data: PolymarketReport): string {
  const sections: string[] = []

  // Summary
  if (data.summary) {
    sections.push(data.summary)
  }

  // Trade table (will become cards via enhanceProse since it has 5+ columns)
  const trades = data.trades
  const hasCategory = trades.some((t) => t.category)
  const hasEstProb = trades.some((t) => t.estimatedProb != null)
  const hasEdge = trades.some((t) => t.edge)
  const hasEntry = trades.some((t) => t.entryTarget)
  const hasSize = trades.some((t) => t.size)

  let header = '| Market | Position | Price'
  let sep = '|---|---|---'
  if (hasEstProb) { header += ' | Est. Prob.'; sep += '|---' }
  if (hasEdge) { header += ' | Edge'; sep += '|---' }
  header += ' | Conviction'
  sep += '|---'
  if (hasCategory) { header += ' | Category'; sep += '|---' }
  if (hasEntry) { header += ' | Entry'; sep += '|---' }
  if (hasSize) { header += ' | Size'; sep += '|---' }
  header += ' |'
  sep += '|'

  const rows = trades.map((t) => {
    const price = typeof t.currentPrice === 'number' ? `$${t.currentPrice.toFixed(2)}` : String(t.currentPrice)
    let row = `| ${t.market} | ${t.position} | ${price}`
    if (hasEstProb) row += ` | ${t.estimatedProb != null ? `${(t.estimatedProb * 100).toFixed(0)}%` : '-'}`
    if (hasEdge) row += ` | ${t.edge ?? '-'}`
    row += ` | ${t.conviction}`
    if (hasCategory) row += ` | ${t.category ?? '-'}`
    if (hasEntry) row += ` | ${t.entryTarget ?? '-'}`
    if (hasSize) row += ` | ${t.size ?? '-'}`
    row += ' |'
    return row
  })

  sections.push(`## Trade Recommendations\n\n${header}\n${sep}\n${rows.join('\n')}`)

  // Per-trade theses
  const theses = trades.filter((t) => t.thesis && t.thesis.trim().length > 20)
  if (theses.length > 0) {
    const thesisSections = theses.map((t) =>
      `### ${t.market}\n\n${t.thesis}`
    ).join('\n\n')
    sections.push(`## Trade Theses\n\n${thesisSections}`)
  }

  // Hedges
  if (data.hedges && data.hedges.length > 0) {
    const hedgeLines = data.hedges.map((h) => `- ${h}`)
    sections.push(`## Hedges\n\n${hedgeLines.join('\n')}`)
  }

  // Portfolio risks
  if (data.risks && data.risks.length > 0) {
    const riskLines = data.risks.map((r) => `- ${r}`)
    sections.push(`## Portfolio Risks\n\n${riskLines.join('\n')}`)
  }

  // Watchlist
  if (data.watchlist && data.watchlist.length > 0) {
    const watchLines = data.watchlist.map((w) => `- ${w}`)
    sections.push(`## Watchlist\n\n${watchLines.join('\n')}`)
  }

  return sections.join('\n\n---\n\n')
}

/**
 * Extract a clean plain-text version of the output for clipboard copy.
 * Handles both plain Markdown and legacy JSON-wrapped output.
 */
export function cleanOutputForCopy(raw: string): string {
  if (!raw) return ''

  let text = raw

  const obj = tryParseJson(raw)
  if (obj) {
    const parts: string[] = []
    if (typeof obj.result === 'string' && obj.result.trim()) {
      parts.push(obj.result.trim())
    }
    if (typeof obj.analysis === 'string' && obj.analysis.trim()) {
      const result = typeof obj.result === 'string' ? obj.result.trim() : ''
      if (obj.analysis.trim() !== result) {
        parts.push(obj.analysis.trim())
      }
    }
    if (Array.isArray(obj.messages) && obj.messages.length > 0) {
      for (const m of obj.messages) {
        if (m.to && m.content) {
          parts.push(`${prettifyName(String(m.to))}: ${m.content}`)
        }
      }
    }
    text = parts.length > 0 ? parts.join('\n\n') : raw
  }

  return stripMarkdown(text)
}

/** Strip markdown formatting to produce clean plain text. */
function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, '')            // headers
    .replace(/\*\*(.+?)\*\*/g, '$1')        // bold
    .replace(/\*(.+?)\*/g, '$1')            // italic
    .replace(/__(.+?)__/g, '$1')            // bold (underscores)
    .replace(/_(.+?)_/g, '$1')              // italic (underscores)
    .replace(/~~(.+?)~~/g, '$1')            // strikethrough
    .replace(/`{3}[\s\S]*?`{3}/g, (m) =>   // code blocks — keep content
      m.replace(/^`{3}\w*\n?/, '').replace(/\n?`{3}$/, ''))
    .replace(/`(.+?)`/g, '$1')              // inline code
    .replace(/^\s*[-*+]\s+/gm, '• ')        // unordered lists
    .replace(/^\s*\d+\.\s+/gm, (m) => m)    // ordered lists (keep as-is)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links — keep text
    .replace(/^>\s?/gm, '')                  // blockquotes
    .replace(/^---+$/gm, '')                 // horizontal rules
    .replace(/\n{3,}/g, '\n\n')              // collapse excess newlines
    .trim()
}

/** Render a nested object as readable key-value markdown lines. */
function renderObject(obj: Record<string, unknown>, heading?: string): string {
  const lines: string[] = []
  if (heading) lines.push(`**${heading}**:`)
  for (const [key, val] of Object.entries(obj)) {
    if (val === null || val === undefined) continue
    if (typeof val === 'string' && val.trim()) {
      lines.push(`**${prettifyName(key)}**: ${val.trim()}`)
    } else if (typeof val === 'number' || typeof val === 'boolean') {
      lines.push(`**${prettifyName(key)}**: ${val}`)
    } else if (Array.isArray(val) && val.length > 0) {
      const items = val.map((v) => typeof v === 'string' ? v : JSON.stringify(v))
      lines.push(`**${prettifyName(key)}**:\n${items.map((i) => `  • ${i}`).join('\n')}`)
    } else if (typeof val === 'object') {
      lines.push(renderObject(val as Record<string, unknown>, prettifyName(key)))
    }
  }
  return lines.join('\n')
}

/** Replace standalone snake_case identifiers with Title Case. */
function prettifySnakeCase(text: string): string {
  return text.replace(/\b([a-z]+(?:_[a-z]+)+)\b/g, (match) => prettifyName(match))
}
