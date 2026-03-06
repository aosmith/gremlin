/**
 * Headless browser-in-browser — zero external dependencies.
 *
 * Tier 1: DOMParser-based HTML → Markdown extraction (synchronous, fast).
 * Tier 2: Sandboxed iframe rendering for JS-heavy pages (async, fallback).
 *
 * Uses only browser built-in APIs: DOMParser, iframe sandbox, postMessage.
 */

// ── Tier 1: DOMParser extraction ────────────────────────────────────────────

const NOISE_TAGS = new Set([
  'script', 'style', 'nav', 'footer', 'header', 'aside',
  'iframe', 'noscript', 'svg', 'form', 'button', 'input',
  'select', 'textarea',
])

const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'main', 'blockquote',
  'li', 'dt', 'dd', 'figcaption', 'details', 'summary',
  'address', 'hgroup',
])

const HEADING_TAGS: Record<string, string> = {
  h1: '#', h2: '##', h3: '###', h4: '####', h5: '#####', h6: '######',
}

/**
 * Parse HTML and extract structured Markdown content.
 * Uses the browser's built-in DOMParser — no external deps.
 */
export function extractContent(html: string, baseUrl?: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')

  // Inject <base> for relative URL resolution
  if (baseUrl) {
    const base = doc.createElement('base')
    base.href = baseUrl
    doc.head.prepend(base)
  }

  // Remove noise elements
  for (const tag of NOISE_TAGS) {
    doc.querySelectorAll(tag).forEach((el) => el.remove())
  }

  // Prefer semantic content root
  const root =
    doc.querySelector('article') ??
    doc.querySelector('main') ??
    doc.querySelector('[role="main"]') ??
    doc.body

  if (!root) return ''

  const md = domToMarkdown(root, baseUrl).trim()
  // Collapse excessive blank lines
  return md.replace(/\n{3,}/g, '\n\n')
}

// ── DOM → Markdown recursive walker ─────────────────────────────────────────

function domToMarkdown(node: Node, baseUrl?: string): string {
  if (node.nodeType === Node.TEXT_NODE) {
    // Collapse whitespace in text nodes (preserving single spaces)
    return (node.textContent ?? '').replace(/[ \t]+/g, ' ')
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return ''

  const el = node as Element
  const tag = el.tagName.toLowerCase()

  // Skip hidden elements
  if (el.getAttribute('hidden') !== null) return ''
  if (el.getAttribute('aria-hidden') === 'true') return ''

  // Headings
  if (tag in HEADING_TAGS) {
    const text = textOf(el).trim()
    return text ? `\n\n${HEADING_TAGS[tag]} ${text}\n\n` : ''
  }

  // Links
  if (tag === 'a') {
    const text = textOf(el).trim()
    const href = resolveUrl(el.getAttribute('href'), baseUrl)
    if (!text) return ''
    return href ? `[${text}](${href})` : text
  }

  // Images
  if (tag === 'img') {
    const alt = el.getAttribute('alt')?.trim()
    const src = resolveUrl(el.getAttribute('src'), baseUrl)
    if (alt && src) return `![${alt}](${src})`
    if (alt) return alt
    return ''
  }

  // Bold / italic
  if (tag === 'strong' || tag === 'b') {
    const text = childrenToMd(el, baseUrl)
    return text.trim() ? `**${text.trim()}**` : ''
  }
  if (tag === 'em' || tag === 'i') {
    const text = childrenToMd(el, baseUrl)
    return text.trim() ? `*${text.trim()}*` : ''
  }

  // Inline code
  if (tag === 'code' && el.parentElement?.tagName.toLowerCase() !== 'pre') {
    const text = textOf(el).trim()
    return text ? `\`${text}\`` : ''
  }

  // Code blocks
  if (tag === 'pre') {
    const code = el.querySelector('code')
    const text = textOf(code ?? el)
    const lang = code?.className.replace(/^language-/, '') ?? ''
    return text.trim() ? `\n\n\`\`\`${lang}\n${text.trim()}\n\`\`\`\n\n` : ''
  }

  // Unordered lists
  if (tag === 'ul') {
    const items = Array.from(el.children)
      .filter((c) => c.tagName.toLowerCase() === 'li')
      .map((li) => `- ${childrenToMd(li, baseUrl).trim()}`)
      .filter(Boolean)
    return items.length ? `\n\n${items.join('\n')}\n\n` : ''
  }

  // Ordered lists
  if (tag === 'ol') {
    const items = Array.from(el.children)
      .filter((c) => c.tagName.toLowerCase() === 'li')
      .map((li, i) => `${i + 1}. ${childrenToMd(li, baseUrl).trim()}`)
      .filter(Boolean)
    return items.length ? `\n\n${items.join('\n')}\n\n` : ''
  }

  // Tables
  if (tag === 'table') return tableToMarkdown(el, baseUrl)

  // Blockquote
  if (tag === 'blockquote') {
    const inner = childrenToMd(el, baseUrl).trim()
    if (!inner) return ''
    const quoted = inner.split('\n').map((l) => `> ${l}`).join('\n')
    return `\n\n${quoted}\n\n`
  }

  // Line breaks
  if (tag === 'br') return '\n'
  if (tag === 'hr') return '\n\n---\n\n'

  // Block-level elements get newlines
  if (BLOCK_TAGS.has(tag) || tag === 'div') {
    const inner = childrenToMd(el, baseUrl)
    return inner.trim() ? `\n\n${inner.trim()}\n\n` : ''
  }

  // Everything else: recurse into children
  return childrenToMd(el, baseUrl)
}

function childrenToMd(el: Element, baseUrl?: string): string {
  return Array.from(el.childNodes).map((c) => domToMarkdown(c, baseUrl)).join('')
}

function textOf(el: Element): string {
  return el.textContent ?? ''
}

function resolveUrl(href: string | null, baseUrl?: string): string {
  if (!href || href.startsWith('#') || href.startsWith('javascript:')) return ''
  if (href.startsWith('http://') || href.startsWith('https://')) return href
  if (!baseUrl) return href
  try {
    return new URL(href, baseUrl).href
  } catch {
    return href
  }
}

// ── Table → Markdown ────────────────────────────────────────────────────────

function tableToMarkdown(table: Element, baseUrl?: string): string {
  const rows: string[][] = []

  // Gather rows from thead and tbody
  const allRows = table.querySelectorAll('tr')
  for (const tr of allRows) {
    const cells = Array.from(tr.querySelectorAll('th, td'))
      .map((c) => childrenToMd(c, baseUrl).trim().replace(/\|/g, '\\|').replace(/\n/g, ' '))
    if (cells.length > 0) rows.push(cells)
  }

  if (rows.length === 0) return ''

  // Normalize column count
  const cols = Math.max(...rows.map((r) => r.length))
  const normalized = rows.map((r) => {
    while (r.length < cols) r.push('')
    return r
  })

  const header = normalized[0]
  const separator = header.map(() => '---')
  const body = normalized.slice(1)

  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${separator.join(' | ')} |`,
    ...body.map((r) => `| ${r.join(' | ')} |`),
  ]

  return `\n\n${lines.join('\n')}\n\n`
}

// ── Tier 2: Sandboxed iframe rendering ──────────────────────────────────────

const IFRAME_TIMEOUT_MS = 8_000
const JS_SETTLE_MS = 2_000

/**
 * Render an HTML page in a sandboxed iframe (executes JavaScript),
 * then extract the resulting text content via postMessage.
 *
 * Security: sandbox="allow-scripts" without allow-same-origin.
 * Scripts execute but can't access parent DOM or make authenticated requests.
 */
export function renderPage(html: string, baseUrl?: string): Promise<string> {
  return new Promise((resolve) => {
    const iframe = document.createElement('iframe')
    iframe.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1024px;height:768px;visibility:hidden;pointer-events:none'
    iframe.setAttribute('sandbox', 'allow-scripts')
    iframe.setAttribute('tabindex', '-1')

    let resolved = false
    const cleanup = () => {
      if (iframe.parentNode) iframe.remove()
      window.removeEventListener('message', onMessage)
    }
    const finish = (text: string) => {
      if (resolved) return
      resolved = true
      cleanup()
      resolve(text)
    }

    // Listen for extraction result from iframe
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === 'gremlin-headless-extract' && typeof e.data.text === 'string') {
        finish(e.data.text)
      }
    }
    window.addEventListener('message', onMessage)

    // Hard timeout
    setTimeout(() => finish(''), IFRAME_TIMEOUT_MS)

    // Injection script: waits for page JS to settle, then extracts text
    const extractionScript = `
<script>
(function() {
  function extract() {
    try {
      var text = document.body ? document.body.innerText : '';
      parent.postMessage({ type: 'gremlin-headless-extract', text: text }, '*');
    } catch(e) {
      parent.postMessage({ type: 'gremlin-headless-extract', text: '' }, '*');
    }
  }
  if (document.readyState === 'complete') {
    setTimeout(extract, ${JS_SETTLE_MS});
  } else {
    window.addEventListener('load', function() {
      setTimeout(extract, ${JS_SETTLE_MS});
    });
  }
})();
</script>`

    const base = baseUrl ? `<base href="${baseUrl}">` : ''
    iframe.srcdoc = `${base}${html}${extractionScript}`

    document.body.appendChild(iframe)
  })
}
