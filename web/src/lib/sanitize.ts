import DOMPurify from 'dompurify'

/** Sanitize HTML output to prevent XSS from agent-generated content. */
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ['target', 'rel', 'style'],
    ADD_TAGS: ['span'],
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form'],
  })
}
