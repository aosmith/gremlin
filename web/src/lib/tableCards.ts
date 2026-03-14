/**
 * Post-process rendered HTML for better visual presentation.
 * - Converts wide tables to card grids
 * - Wraps search result / source sections in callout boxes
 * - Wraps data-heavy bullet sections in highlight boxes
 * - Adds spacing between major sections
 */
// Memoization cache — avoids reprocessing identical HTML on every render
const _cache = new Map<string, string>()
const MAX_CACHE_SIZE = 256

export function enhanceProse(html: string): string {
  const cached = _cache.get(html)
  if (cached !== undefined) return cached

  let result = tablesToCards(html)
  result = wrapSearchSections(result)
  result = wrapDataCallouts(result)
  result = addSectionSpacing(result)
  result = highlightTickers(result)
  result = styleAgentLabels(result)
  result = highlightVerdicts(result)
  result = colorSignedNumbers(result)

  // Evict oldest entries when cache is full
  if (_cache.size >= MAX_CACHE_SIZE) {
    const first = _cache.keys().next().value
    if (first !== undefined) _cache.delete(first)
  }
  _cache.set(html, result)

  return result
}

/**
 * Convert HTML <table> elements into responsive card grids.
 * Each table row becomes a card with label/value pairs.
 * Tables with 3 or fewer columns are left as-is (they fit fine).
 */
function tablesToCards(html: string): string {
  return html.replace(/<table>[\s\S]*?<\/table>/g, (tableHtml) => {
    // Extract headers
    const headers: string[] = []
    const thRegex = /<th[^>]*>([\s\S]*?)<\/th>/gi
    let m
    while ((m = thRegex.exec(tableHtml)) !== null) {
      headers.push(m[1].replace(/<[^>]+>/g, '').trim())
    }

    // If few columns, a regular table works fine
    if (headers.length <= 3) {
      return `<div class="table-wrap">${tableHtml}</div>`
    }

    // Extract body rows
    const rows: string[][] = []
    const tbodyMatch = tableHtml.match(/<tbody>([\s\S]*?)<\/tbody>/i)
    const bodyHtml = tbodyMatch ? tbodyMatch[1] : tableHtml
    const trRegex = /<tr>([\s\S]*?)<\/tr>/gi
    let rowMatch
    let isFirstRow = true
    while ((rowMatch = trRegex.exec(bodyHtml)) !== null) {
      // Skip the header row (contains <th>)
      if (rowMatch[1].includes('<th')) { isFirstRow = false; continue }
      if (isFirstRow && !tbodyMatch) { isFirstRow = false }

      const cells: string[] = []
      const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi
      let cellMatch
      while ((cellMatch = tdRegex.exec(rowMatch[1])) !== null) {
        cells.push(cellMatch[1].trim())
      }
      if (cells.length > 0) rows.push(cells)
    }

    if (rows.length === 0) return tableHtml

    // Build card grid
    // Use the first column as the card title, rest as label/value pairs
    const cards = rows.map((cells) => {
      const title = cells[0] || ''
      const pairs = headers.slice(1).map((h, i) => {
        const val = cells[i + 1] ?? ''
        if (!val || val === '-' || val === 'N/A') return ''
        return `<div class="card-field"><span class="card-label">${h}</span><span class="card-value">${val}</span></div>`
      }).filter(Boolean).join('')

      return `<div class="data-card"><div class="card-title">${title}</div><div class="card-fields">${pairs}</div></div>`
    }).join('')

    return `<div class="card-grid">${cards}</div>`
  })
}

/**
 * Detect headings that indicate search results / sourced data and wrap
 * the heading + following content in a callout box.
 * Matches patterns like "Web Search Results", "Sources", "Search Results",
 * "Market Data", "Recent Headlines", etc.
 * Uses multi-word patterns to avoid false positives on agent section headings.
 */
function wrapSearchSections(html: string): string {
  // Match h2/h3 that look like search/source sections, plus all content until the next h2/h3 or end
  // Patterns require compound phrases to avoid matching agent names like "News & Sentiment"
  const searchPattern = /(<h[23][^>]*>(?:[^<]*(?:search result|web search|web result|source[sd]?\b|news (?:result|headline|summary|roundup|brief|update|flash)|headline[s]?\b|sentiment (?:analysis|overview|summary|score)|market (?:data|overview|update)|recent (?:data|development|report|headline)|social media (?:analysis|sentiment)|breaking news)[^<]*)<\/h[23]>)([\s\S]*?)(?=<h[23]|$)/gi
  return html.replace(searchPattern, (_match, heading: string, body: string) => {
    return `<div class="callout callout-source">${heading}${body}</div>`
  })
}

/**
 * Detect inline data points (prices, percentages, dollar amounts) in list items
 * and wrap the parent <ul>/<ol> in a highlight callout when dense with data.
 */
function wrapDataCallouts(html: string): string {
  // Find <ul> blocks where most items contain data ($ amounts, %, numbers with units)
  return html.replace(/<ul>([\s\S]*?)<\/ul>/g, (match, inner: string) => {
    const items = inner.match(/<li>/g)?.length ?? 0
    // Count items that contain data patterns: $123, 12.3%, ticker symbols like SPY, etc.
    const dataItems = (inner.match(/<li>[^<]*(?:\$[\d,.]+|[\d,.]+%|\b[A-Z]{2,5}\b[^<]*\$|\bP\/E\b|\bYTD\b|\bQ[1-4]\b)[^<]*<\/li>/g) ?? []).length
    // If more than half of items are data-rich, wrap in a callout
    if (items >= 2 && dataItems >= items * 0.5) {
      return `<div class="callout callout-data"><ul>${inner}</ul></div>`
    }
    return match
  })
}

/**
 * Add visual spacing between major content sections.
 * Inserts a spacer div before h2 elements that aren't the first child.
 */
function addSectionSpacing(html: string): string {
  // Add section-break class before h2 tags (but not the very first one)
  let first = true
  return html.replace(/<h2/g, (match) => {
    if (first) { first = false; return match }
    return `<div class="section-break"></div><h2`
  })
}

/**
 * Highlight ticker symbols in rendered HTML.
 * Matches:
 *  - $TICKER (primary format, agents instructed to use this)
 *  - (TICKER) — common fallback when models skip the $
 *  - TICKER: at start of card titles after tablesToCards conversion
 */
function highlightTickers(html: string): string {
  return html.replace(/>([^<]+)</g, (_full, text: string) => {
    // Only match explicit $TICKER — the $ prefix is the signal
    const highlighted = text.replace(/\$([A-Z]{1,5})\b/g, (_m, t: string) =>
      `<span class="ticker">$${t}</span>`)
    return `>${highlighted}<`
  })
}

/**
 * Style [Agent Name]: labels that appear in synthesized output.
 * Matches patterns like [News & Sentiment]:, [Value Analyst]:, [Risk Manager], etc.
 * Limited to 1-3 word names (max ~30 chars) to avoid matching arbitrary bracketed text.
 */
function styleAgentLabels(html: string): string {
  // Match [Agent Name]: — 1-3 words, colon required, & may be HTML-encoded as &amp;
  return html.replace(/\[([A-Z][A-Za-z]{1,15}(?:(?:\s|&amp;|\s&amp;\s|&\s|\s&)+[A-Z][A-Za-z]{1,15}){0,2})\]\s*:/g, (match, name: string) => {
    // Skip markdown link syntax — [text](url)
    if (match.endsWith('](')) return match
    // Decode &amp; back to & for display
    const display = name.replace(/&amp;/g, '&')
    return `<span class="agent-label">${display}</span>`
  })
}

/**
 * Convert standalone bold verdict words into colored badge pills.
 * Matches <strong>BUY</strong>, <strong>HOLD</strong>, etc.
 * Only matches short bold text (≤25 chars) that exactly matches a known verdict.
 */
const VERDICT_POS = new Set(['BUY', 'STRONG BUY', 'OVERWEIGHT', 'OUTPERFORM', 'BULLISH', 'ACCUMULATE', 'LONG', 'POSITIVE', 'LOW RISK'])
const VERDICT_NEU = new Set(['HOLD', 'NEUTRAL', 'MARKET PERFORM', 'EQUAL WEIGHT', 'SECTOR PERFORM', 'MIXED', 'MODERATE', 'MARKET WEIGHT', 'MEDIUM', 'MEDIUM RISK'])
const VERDICT_NEG = new Set(['SELL', 'STRONG SELL', 'UNDERWEIGHT', 'UNDERPERFORM', 'BEARISH', 'AVOID', 'REDUCE', 'SHORT', 'CRITICAL', 'NEGATIVE', 'HIGH RISK'])

function highlightVerdicts(html: string): string {
  return html.replace(/<strong>([^<]{2,25})<\/strong>/g, (match, inner: string) => {
    const upper = inner.trim().toUpperCase()
    if (VERDICT_POS.has(upper)) return `<span class="verdict verdict-pos">${inner.trim()}</span>`
    if (VERDICT_NEU.has(upper)) return `<span class="verdict verdict-neut">${inner.trim()}</span>`
    if (VERDICT_NEG.has(upper)) return `<span class="verdict verdict-neg">${inner.trim()}</span>`
    return match
  })
}

/**
 * Color explicitly signed numbers: +12.3% green, -5.2% red.
 * Only matches numbers with a leading + or − and a trailing unit (%, bp, bps).
 * Operates on text nodes (between > and <) to avoid mangling HTML.
 */
function colorSignedNumbers(html: string): string {
  return html.replace(/>([^<]+)</g, (_full, text: string) => {
    const colored = text
      .replace(/(\+\d[\d,.]*(?:%|bp|bps)\b)/g, '<span class="num-pos">$1</span>')
      .replace(/([-−]\d[\d,.]*(?:%|bp|bps)\b)/g, '<span class="num-neg">$1</span>')
    return `>${colored}<`
  })
}
