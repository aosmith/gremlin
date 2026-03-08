import { describe, it, expect } from 'vitest'
import { cleanContent, formatOutputAsMarkdown, cleanOutputForCopy } from '../cleanContent'

describe('cleanContent', () => {
  it('returns plain text unchanged', () => {
    expect(cleanContent('Hello world')).toBe('Hello world')
  })

  it('strips routing prefixes', () => {
    expect(cleanContent('[From Orchestrator]: Hello')).toBe('Hello')
    expect(cleanContent('[To Worker]: Do this')).toBe('Do this')
  })

  it('parses protocol JSON into readable format', () => {
    const json = JSON.stringify({
      analysis: 'Task received',
      messages: [{ to: 'worker_1', content: 'Do research' }],
      done: false,
    })
    const result = cleanContent(json)
    expect(result).toContain('Task received')
    expect(result).toContain('Worker 1')
    expect(result).toContain('Do research')
  })

  it('formats done flag', () => {
    const json = JSON.stringify({ done: true, result: 'All complete' })
    const result = cleanContent(json)
    expect(result).toContain('\u2714 Done')
    expect(result).toContain('All complete')
  })

  it('handles malformed JSON gracefully', () => {
    const broken = '{ not valid json }'
    expect(cleanContent(broken)).toBe('{ not valid json }')
  })

  it('renders non-protocol JSON as key-value pairs', () => {
    const json = JSON.stringify({ status: 'complete', confidence: 0.95 })
    const result = cleanContent(json)
    expect(result).toContain('**Status**: complete')
    expect(result).toContain('**Confidence**: 0.95')
  })

  it('strips visual noise characters', () => {
    expect(cleanContent('████ Title ████')).toBe('Title')
    expect(cleanContent('★★★★★ Rating')).toBe('★★ Rating')
    expect(cleanContent('═══════════')).toBe('---')
  })

  it('collapses excessive blank lines', () => {
    expect(cleanContent('A\n\n\n\n\nB')).toBe('A\n\nB')
  })
})

describe('formatOutputAsMarkdown', () => {
  it('returns empty string for empty input', () => {
    expect(formatOutputAsMarkdown('')).toBe('')
  })

  it('passes through plain markdown', () => {
    const md = '## Results\n\nEverything looks good.'
    expect(formatOutputAsMarkdown(md)).toContain('Results')
    expect(formatOutputAsMarkdown(md)).toContain('Everything looks good.')
  })

  it('extracts result from JSON wrapper', () => {
    const json = JSON.stringify({ result: 'The answer is 42' })
    expect(formatOutputAsMarkdown(json)).toContain('The answer is 42')
  })

  it('renders analysis when no result', () => {
    const json = JSON.stringify({ analysis: 'Detailed analysis here' })
    expect(formatOutputAsMarkdown(json)).toContain('Detailed analysis here')
  })

  it('detects portfolio format', () => {
    const json = JSON.stringify({
      positions: [
        { ticker: 'AAPL', company: 'Apple', weight: 20, conviction: 'High', catalyst: 'AI', risk: 'Valuation' },
      ],
    })
    const result = formatOutputAsMarkdown(json)
    expect(result).toContain('$AAPL')
    expect(result).toContain('Apple')
    expect(result).toContain('Portfolio')
  })

  it('detects Polymarket trade format', () => {
    const json = JSON.stringify({
      trades: [
        { market: 'Election 2026', currentPrice: 0.55, position: 'YES', conviction: 'Medium' },
      ],
    })
    const result = formatOutputAsMarkdown(json)
    expect(result).toContain('Election 2026')
    expect(result).toContain('Trade Recommendations')
  })
})

describe('cleanOutputForCopy', () => {
  it('returns empty string for empty input', () => {
    expect(cleanOutputForCopy('')).toBe('')
  })

  it('strips markdown formatting', () => {
    expect(cleanOutputForCopy('**bold** and *italic*')).toBe('bold and italic')
  })

  it('extracts result from JSON', () => {
    const json = JSON.stringify({ result: 'Plain text result' })
    expect(cleanOutputForCopy(json)).toBe('Plain text result')
  })

  it('preserves code block content', () => {
    const md = '```\nconst x = 1\n```'
    expect(cleanOutputForCopy(md)).toContain('const x = 1')
  })
})
