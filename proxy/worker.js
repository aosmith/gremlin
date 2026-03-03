/**
 * CORS Proxy — Cloudflare Worker
 *
 * Forwards requests to a target URL specified in the X-Target-URL header,
 * adding CORS headers to the response. Deploy with `npx wrangler deploy`.
 */

export default {
  async fetch(request) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Max-Age': '86400',
        },
      })
    }

    const targetUrl = request.headers.get('X-Target-URL')
    if (!targetUrl) {
      return new Response('Missing X-Target-URL header', { status: 400 })
    }

    // Forward the request to the target
    const headers = new Headers(request.headers)
    headers.delete('X-Target-URL')
    headers.delete('host')

    const resp = await fetch(targetUrl, {
      method: request.method,
      headers,
      body: request.body,
    })

    // Return response with CORS headers
    const corsHeaders = new Response(resp.body, resp)
    corsHeaders.headers.set('Access-Control-Allow-Origin', '*')
    corsHeaders.headers.set('Access-Control-Expose-Headers', '*')
    return corsHeaders
  },
}
