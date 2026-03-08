import { describe, it, expect } from 'vitest'
import { enhanceProse } from '../tableCards'

describe('enhanceProse', () => {
  it('returns simple HTML unchanged', () => {
    const html = '<p>Hello world</p>'
    expect(enhanceProse(html)).toBe(html)
  })

  it('leaves small tables as-is (wrapped in table-wrap)', () => {
    const table = '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>'
    const result = enhanceProse(table)
    expect(result).toContain('table-wrap')
    expect(result).not.toContain('card-grid')
  })

  it('converts wide tables (5+ columns) to card grids', () => {
    const table = '<table><thead><tr><th>Name</th><th>A</th><th>B</th><th>C</th><th>D</th></tr></thead>' +
      '<tbody><tr><td>Row1</td><td>1</td><td>2</td><td>3</td><td>4</td></tr></tbody></table>'
    const result = enhanceProse(table)
    expect(result).toContain('card-grid')
    expect(result).toContain('data-card')
    expect(result).toContain('Row1')
  })

  it('highlights $TICKER symbols', () => {
    const html = '<p>Buy $AAPL and $MSFT</p>'
    const result = enhanceProse(html)
    expect(result).toContain('class="ticker"')
    expect(result).toContain('$AAPL')
    expect(result).toContain('$MSFT')
  })

  it('highlights (TICKER) fallback pattern', () => {
    const html = '<p>Apple (AAPL) is up</p>'
    const result = enhanceProse(html)
    expect(result).toContain('class="ticker"')
  })

  it('styles agent labels like [Agent Name]:', () => {
    const html = '<p>[Risk Manager]: Watch out for volatility</p>'
    const result = enhanceProse(html)
    expect(result).toContain('agent-label')
    expect(result).toContain('Risk Manager')
  })

  it('wraps search result sections in callouts', () => {
    const html = '<h3>Web Search Results</h3><p>Some data</p>'
    const result = enhanceProse(html)
    expect(result).toContain('callout-source')
  })

  it('adds section spacing between h2 elements', () => {
    const html = '<h2>First</h2><p>A</p><h2>Second</h2><p>B</p>'
    const result = enhanceProse(html)
    expect(result).toContain('section-break')
  })

  it('wraps data-dense lists in callout', () => {
    const html = '<ul><li>$AAPL: $195.50</li><li>$MSFT: $420.30</li></ul>'
    const result = enhanceProse(html)
    expect(result).toContain('callout-data')
  })
})

describe('enhanceProse memoization', () => {
  it('returns same reference for identical input', () => {
    const html = '<p>Test memoization</p>'
    const result1 = enhanceProse(html)
    const result2 = enhanceProse(html)
    expect(result1).toBe(result2)
  })
})
