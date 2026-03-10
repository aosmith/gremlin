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

/**
 * Strip orchestrator delegation instructions meant for other agents, not humans.
 * Removes lines like "1. Send Value Analyst to...", "Please message 'Strategist'...", etc.
 */
function stripDelegationNoise(text: string): string {
  const lines = text.split('\n')
  const filtered = lines.filter(line => {
    const t = line.trim()
    // Numbered delegation: "1. Send Value Analyst to..."
    if (/^\d+\.\s*Send\s+[A-Z]/i.test(t)) return false
    // Unnumbered: "Send Risk Manager to/for..."
    if (/^Send\s+[A-Z][a-zA-Z\s]{2,30}(?:to|for)\s/i.test(t)) return false
    // "Please message 'Agent'" / "Please message "Agent""
    if (/^Please\s+message\s+["']/i.test(t)) return false
    // "Message 'Agent' to..."
    if (/^Message\s+["'][A-Z]/i.test(t)) return false
    // "Instruct [Agent] to..." / "Direct [Agent] to..."
    if (/^(?:Instruct|Direct|Task|Assign)\s+(?:the\s+)?[A-Z][a-zA-Z\s]{2,30}(?:to|with)\s/i.test(t)) return false
    // "I will now send/message/direct..."
    if (/^I\s+will\s+(?:now\s+)?(?:send|message|direct|instruct|task|assign)\b/i.test(t)) return false
    return true
  })
  return filtered.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** Convert bare send_message("Agent", "content") calls into readable → Agent: content lines. */
function formatSendMessageCalls(text: string): string {
  return text.replace(
    /send_message\(\s*"([^"]+)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*\)/g,
    (_match, agent: string, content: string) => {
      // Unescape any escaped quotes in the content
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
  if (!trimmed.startsWith('{')) return stripDelegationNoise(formatSendMessageCalls(stripped))

  const obj = tryParseJson(trimmed)
  if (!obj) return stripped

  const parts: string[] = []

  if (typeof obj.analysis === 'string' && obj.analysis.trim()) {
    const cleaned = stripDelegationNoise(formatSendMessageCalls(obj.analysis.trim()))
    if (cleaned) parts.push(cleaned)
  }

  if (Array.isArray(obj.messages) && obj.messages.length > 0) {
    for (const m of obj.messages) {
      if (m.to && m.content) {
        parts.push(`  \u2192 ${prettifyName(m.to)}: ${m.content}`)
      }
    }
  }

  if (obj.done === true) parts.push('\u2714 Done')

  if (typeof obj.result === 'string' && obj.result.trim()) {
    parts.push(`\u2605 Result: ${obj.result.trim()}`)
  }

  // If we parsed JSON but got nothing from protocol fields, render all
  // string/number/boolean values as readable key-value pairs instead of raw JSON
  if (parts.length === 0) {
    for (const [key, val] of Object.entries(obj)) {
      if (val === null || val === undefined) continue
      if (typeof val === 'string' && val.trim()) {
        parts.push(`**${prettifyName(key)}**: ${val.trim()}`)
      } else if (typeof val === 'number' || typeof val === 'boolean') {
        parts.push(`**${prettifyName(key)}**: ${val}`)
      } else if (Array.isArray(val) && val.length > 0) {
        const items = val.map((v) => typeof v === 'string' ? v : JSON.stringify(v))
        parts.push(`**${prettifyName(key)}**:\n${items.map((i) => `  • ${i}`).join('\n')}`)
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

/** Replace standalone snake_case identifiers with Title Case. */
function prettifySnakeCase(text: string): string {
  return text.replace(/\b([a-z]+(?:_[a-z]+)+)\b/g, (match) => prettifyName(match))
}
