import { describe, it, expect } from 'vitest'
import { sanitizeHtml } from '../sanitize'

describe('sanitizeHtml', () => {
  it('passes through safe HTML', () => {
    const html = '<p>Hello <strong>world</strong></p>'
    expect(sanitizeHtml(html)).toBe(html)
  })

  it('strips script tags', () => {
    const html = '<p>Safe</p><script>alert("xss")</script>'
    expect(sanitizeHtml(html)).toBe('<p>Safe</p>')
  })

  it('strips iframe tags', () => {
    const html = '<p>Safe</p><iframe src="evil.com"></iframe>'
    expect(sanitizeHtml(html)).toBe('<p>Safe</p>')
  })

  it('strips onerror attributes', () => {
    const html = '<img src="x" onerror="alert(1)">'
    const result = sanitizeHtml(html)
    expect(result).not.toContain('onerror')
  })

  it('strips onclick attributes', () => {
    const html = '<div onclick="alert(1)">click me</div>'
    const result = sanitizeHtml(html)
    expect(result).not.toContain('onclick')
  })

  it('preserves style attributes', () => {
    const html = '<span style="color: red">Red text</span>'
    expect(sanitizeHtml(html)).toContain('style=')
  })

  it('preserves span tags for ticker/agent-label classes', () => {
    const html = '<span class="ticker">$AAPL</span>'
    expect(sanitizeHtml(html)).toContain('class="ticker"')
  })

  it('strips form tags', () => {
    const html = '<form action="evil.com"><input type="text"></form>'
    const result = sanitizeHtml(html)
    expect(result).not.toContain('<form')
  })

  it('handles empty input', () => {
    expect(sanitizeHtml('')).toBe('')
  })

  it('strips javascript: URLs', () => {
    const html = '<a href="javascript:alert(1)">Click</a>'
    const result = sanitizeHtml(html)
    expect(result).not.toContain('javascript:')
  })
})
