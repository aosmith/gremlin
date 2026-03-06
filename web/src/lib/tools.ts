/**
 * Tool definitions exposed to agents.
 * Dev tools: file CRUD for engineering mode.
 * Search tools: web search for all modes.
 */

import { projectFS } from './filesystem'
import { performWebSearch } from './search'
import { proxiedFetch } from './api'
import { extractContent, renderPage } from './headless'
import type { Settings } from './types'

// ── OpenAI-format tool definitions ────────────────────────────────────────────

interface OAIToolParam {
  type: string
  description: string
  enum?: string[]
}

export interface OAITool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, OAIToolParam>
      required: string[]
    }
  }
}

export const DEV_TOOLS: OAITool[] = [
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Write (create or overwrite) a file in the project directory. ' +
        'Parent directories are created automatically. ' +
        'Always write complete file contents — never partial.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to project root, e.g. "src/App.tsx"' },
          content: { type: 'string', description: 'Complete file content' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the full content of an existing file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to project root' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List files and sub-directories at a path. Use "/" for the project root.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path relative to project root' },
        },
        required: ['path'],
      },
    },
  },
]

// ── Search tools ─────────────────────────────────────────────────────────────

export const SEARCH_TOOLS: OAITool[] = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the web for current information. Returns relevant results with titles, URLs, and snippets. ' +
        'Use this when you need real-time data, current prices, recent events, or anything beyond your training cutoff.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description:
        'Fetch a web page and return its text content. Works for public APIs, JSON endpoints, and sites that allow cross-origin access. ' +
        'If a page blocks the request, fall back to web_search instead. Use this to read specific URLs from search results or known data sources.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The full URL to fetch (must start with http:// or https://)' },
        },
        required: ['url'],
      },
    },
  },
]

// ── Protocol tools (multi-agent coordination) ────────────────────────────────

/** Protocol tools used by all agents for inter-agent communication. */
export const PROTOCOL_TOOLS: OAITool[] = [
  {
    type: 'function',
    function: {
      name: 'send_message',
      description:
        'Send a message to another agent in the GREMLIN multi-agent system. ' +
        'Use the agent\'s ID or name from the list of available agents.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Target agent ID or name' },
          content: { type: 'string', description: 'Message content to send' },
        },
        required: ['to', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mark_done',
      description:
        'Signal that you have completed your assigned task. ' +
        'Optionally include a final result string (synthesizers MUST include their full report here).',
      parameters: {
        type: 'object',
        properties: {
          result: {
            type: 'string',
            description: 'Final result or conclusion (required for synthesizers, optional for others)',
          },
        },
        required: [],
      },
    },
  },
]

/** Set of protocol tool names for quick lookup. */
export const PROTOCOL_TOOL_NAMES = new Set(PROTOCOL_TOOLS.map((t) => t.function.name))

/** A custom function that executes a tool call. */
export type ToolExecutor = (
  id: string,
  name: string,
  args: Record<string, unknown>,
) => Promise<ToolCallRecord>

// ── Anthropic-format tool definitions ─────────────────────────────────────────
// Derived from DEV_TOOLS so they stay in sync automatically.

export function toAnthropicTools(tools: OAITool[]) {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }))
}

// ── Tool executor ─────────────────────────────────────────────────────────────

export interface ToolCallRecord {
  id: string
  name: string
  args: Record<string, unknown>
  result: string
  isError: boolean
}

/** Callback invoked when an agent calls web_search but no provider is configured. */
type OnSearchNotConfigured = () => Promise<boolean>

/** Combine an optional parent abort signal with a per-call timeout. */
function withTimeout(signal?: AbortSignal, ms = 30_000): AbortSignal {
  const timeout = AbortSignal.timeout(ms)
  if (!signal) return timeout
  return AbortSignal.any([signal, timeout])
}

export async function executeTool(
  id: string,
  name: string,
  args: Record<string, unknown>,
  settings?: Settings,
  onSearchNotConfigured?: OnSearchNotConfigured,
  signal?: AbortSignal,
): Promise<ToolCallRecord> {
  try {
    let result = ''
    switch (name) {
      case 'write_file': {
        const { path, content } = args as { path: string; content: string }
        await projectFS.writeFile(path, content)
        result = `Written ${path} (${content.length.toLocaleString()} chars)`
        break
      }
      case 'read_file': {
        const { path } = args as { path: string }
        result = await projectFS.readFile(path)
        break
      }
      case 'list_directory': {
        const { path = '/' } = args as { path?: string }
        const entries = await projectFS.listDirectory(path)
        result = entries
          .map((e) => `${e.kind === 'directory' ? '📁' : '📄'} ${e.name}`)
          .join('\n') || '(empty)'
        break
      }
      case 'web_search': {
        const { query } = args as { query: string }
        if (!settings?.searchProvider) {
          // Prompt user to configure search
          if (onSearchNotConfigured) {
            const configured = await onSearchNotConfigured()
            if (!configured) throw new Error('Web search not configured — user skipped setup')
            // settings object is mutated by store when user configures, so retry
          } else {
            throw new Error('Web search not configured. Set a search provider in Settings.')
          }
        }
        result = await performWebSearch(query, settings!, withTimeout(signal, 30_000))
        break
      }
      case 'web_fetch': {
        const { url } = args as { url: string }
        result = await fetchWebPage(url, settings, withTimeout(signal, 30_000))
        break
      }
      default:
        throw new Error(`Unknown tool: ${name}`)
    }
    return { id, name, args, result, isError: false }
  } catch (err) {
    let result = err instanceof Error ? err.message : String(err)
    // CORS / network errors from browser — tell the LLM to stop retrying
    if (err instanceof TypeError && (result.includes('Failed to fetch') || result.includes('NetworkError'))) {
      result = `CORS/network error: ${result}. This tool cannot reach the external service from the browser. A CORS proxy is required in Settings, or use a different search provider. Do NOT retry this call — it will fail again.`
    }
    // Timeout errors — tell the LLM the call timed out, don't retry
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      result = `Request timed out after 30 seconds. The service is too slow or unreachable. Do NOT retry — move on with what you have.`
    }
    return { id, name, args, result, isError: true }
  }
}

// ── Web fetch helper ──────────────────────────────────────────────────────────

const MAX_FETCH_CHARS = 30_000

/** Minimum content length before trying the iframe JS renderer as SPA fallback. */
const SPA_THRESHOLD = 200

async function fetchWebPage(url: string, settings?: Settings, signal?: AbortSignal): Promise<string> {
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    throw new Error('URL must start with http:// or https://')
  }

  const fetcher = settings?.proxyUrl ? proxiedFetch : fetch
  const resp = await fetcher(url, {
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    signal,
  }, settings!)

  if (!resp.ok) throw new Error(`Fetch failed: HTTP ${resp.status}`)

  const contentType = resp.headers.get('content-type') ?? ''
  const raw = await resp.text()

  // JSON responses: return as-is (truncated)
  if (contentType.includes('json')) {
    return raw.length > MAX_FETCH_CHARS ? raw.slice(0, MAX_FETCH_CHARS) + '\n...(truncated)' : raw
  }

  // HTML: extract structured Markdown via headless DOMParser
  let text = extractContent(raw, url)

  // SPA fallback: if DOMParser yielded very little text but the page had scripts,
  // render in a sandboxed iframe to let JS populate the content.
  if (text.length < SPA_THRESHOLD && /<script[\s>]/i.test(raw)) {
    try {
      const rendered = await renderPage(raw, url)
      if (rendered.length > text.length) text = rendered
    } catch { /* iframe fallback is best-effort */ }
  }

  return text.length > MAX_FETCH_CHARS ? text.slice(0, MAX_FETCH_CHARS) + '\n...(truncated)' : text
}
