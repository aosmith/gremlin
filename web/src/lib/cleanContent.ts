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

/**
 * Format agent JSON into readable text for the Activity Monitor / Agent Panel.
 * Compact single-line format.
 */
export function cleanContent(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('{')) return raw

  const obj = tryParseJson(trimmed)
  if (!obj) return raw

  const parts: string[] = []

  if (typeof obj.analysis === 'string' && obj.analysis.trim()) {
    parts.push(obj.analysis.trim())
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

  return parts.length > 0 ? parts.join('\n') : raw
}

/**
 * Format output for the Results Modal.
 * Produces styled Markdown with all fields visible.
 * Handles both plain Markdown (new) and legacy JSON-wrapped output.
 */
export function formatOutputAsMarkdown(raw: string): string {
  if (!raw) return ''

  // Try to parse as JSON (legacy format or raw model JSON)
  const obj = tryParseJson(raw)
  if (!obj) {
    // Not JSON — already human-readable, just clean up snake_case names
    return prettifySnakeCase(raw)
  }

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

/**
 * Extract a clean plain-text version of the output for clipboard copy.
 * Handles both plain Markdown and legacy JSON-wrapped output.
 */
export function cleanOutputForCopy(raw: string): string {
  if (!raw) return ''

  const obj = tryParseJson(raw)
  if (!obj) return raw  // Already plain text

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

  return parts.length > 0 ? parts.join('\n\n') : raw
}

/** Replace standalone snake_case identifiers with Title Case. */
function prettifySnakeCase(text: string): string {
  return text.replace(/\b([a-z]+(?:_[a-z]+)+)\b/g, (match) => prettifyName(match))
}
