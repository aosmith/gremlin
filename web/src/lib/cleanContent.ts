// Fix literal newlines inside JSON strings so JSON.parse doesn't choke
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

/** Format agent JSON into clean, readable display text for the activity monitor. */
export function cleanContent(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('{')) return raw

  try {
    const obj = JSON.parse(fixJsonNewlines(trimmed))
    const parts: string[] = []

    if (typeof obj.analysis === 'string' && obj.analysis.trim()) {
      parts.push(`${obj.analysis.trim()}`)
    }

    if (Array.isArray(obj.messages) && obj.messages.length > 0) {
      for (const m of obj.messages) {
        if (m.to && m.content) parts.push(`  \u2192 ${m.to}: ${m.content}`)
      }
    }

    if (obj.done === true) {
      parts.push(`\u2714 Done`)
    }

    if (typeof obj.result === 'string' && obj.result.trim()) {
      parts.push(`\u2605 Result: ${obj.result.trim()}`)
    }

    if (parts.length > 0) return parts.join('\n')
  } catch { /* JSON parse failed */ }

  // Regex fallback for malformed JSON
  const parts: string[] = []
  const re = /"(\w+)"\s*:\s*"((?:[^"\\]|\\.)*)"/gs
  let m
  while ((m = re.exec(trimmed)) !== null) {
    const val = m[2].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim()
    if (val) parts.push(val)
  }
  if (parts.length > 0) return parts.join('\n')

  return raw
}
