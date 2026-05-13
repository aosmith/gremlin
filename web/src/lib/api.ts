import type { LLMMessage, Settings } from './types'
import { PROVIDERS } from './types'
import type { OAITool, ToolCallRecord, ToolExecutor } from './tools'
import { toAnthropicTools, executeTool } from './tools'
import { callWebLLM } from './webllm'
import type { ProgressCallback } from './webllm'

// ── Ollama context window sizing ─────────────────────────────────────────────
// Cached hardware + model info, populated once per session via initOllamaProfile().

let _gpuMemoryGB = 0
let _modelSizeMap = new Map<string, number>()

/**
 * Fetch hardware profile + installed model sizes from local LLM servers.
 * Called once by AgentRunner before the main loop so that oaiFetch can
 * compute an appropriate num_ctx per-request without async overhead.
 * Works for Ollama (via /api/tags) and any OpenAI-compatible local server.
 */
export async function initLocalModelProfile(endpoints: string[]): Promise<void> {
  // Hardware — try Vite server endpoint, fall back to navigator API
  if (_gpuMemoryGB === 0) {
    try {
      const resp = await fetch('/api/system-info', { signal: AbortSignal.timeout(2_000) })
      if (resp.ok) {
        const info = await resp.json()
        _gpuMemoryGB = info.gpuMemoryGB || info.totalMemoryGB || 0
      }
    } catch { /* fallback */ }
    if (_gpuMemoryGB === 0) {
      _gpuMemoryGB = (navigator as any).deviceMemory ?? 8
    }
  }

  // Collect model sizes from all local endpoints
  _modelSizeMap = new Map()
  for (const ep of endpoints) {
    if (!isLocalEndpoint(ep)) continue
    const base = ep.replace(/\/v1.*$/, '')
    // Try Ollama /api/tags first (has size info)
    try {
      const resp = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(3_000) })
      if (resp.ok) {
        const data = await resp.json()
        for (const m of (data.models ?? []) as Array<{ name: string; size: number }>) {
          _modelSizeMap.set(m.name, Math.round(m.size / 1e9 * 10) / 10)
        }
        continue
      }
    } catch { /* not Ollama — try OpenAI models endpoint */ }
    // Fallback: OpenAI-compatible /v1/models (no size info — use 0 for conservative default)
    try {
      const resp = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(3_000) })
      if (resp.ok) {
        const data = await resp.json()
        for (const m of (data.data ?? []) as Array<{ id: string }>) {
          if (!_modelSizeMap.has(m.id)) _modelSizeMap.set(m.id, 0)
        }
      }
    } catch { /* endpoint not reachable */ }
  }
}

/** Check if an endpoint is a local LLM server (Ollama, LM Studio, etc.). */
function isLocalEndpoint(endpoint: string): boolean {
  return /localhost|127\.0\.0\.1/.test(endpoint)
}

/**
 * Compute optimal num_ctx for a given model based on GPU memory budget.
 * Goal: leave enough room for KV cache without spilling layers to CPU.
 */
/** User-configured context length (0 = auto-detect). Set from settings. */
let _contextLength = 0

export function setContextLength(len: number) { _contextLength = len }

export function computeNumCtx(modelName: string): number {
  // If user set an explicit context length, use it
  if (_contextLength > 0) return _contextLength

  if (_gpuMemoryGB === 0) return 16384  // no hardware info — generous default for modern hardware

  const modelGB = _modelSizeMap.get(modelName) ?? 0
  // Available memory for KV cache = 95% of GPU minus model weights
  // (unified memory machines can use nearly all RAM for inference)
  const kvBudgetGB = _gpuMemoryGB * 0.95 - modelGB

  // Minimum 16384 — Ollama can partially offload models larger than VRAM,
  // and 4096 is too small for multi-agent prompts (causes stuck agents).
  if (kvBudgetGB <= 0) return 16384
  if (kvBudgetGB < 1) return 16384
  if (kvBudgetGB < 2) return 16384
  if (kvBudgetGB < 4) return 24576
  return 32768
}

// ── Multimodal content helpers ───────────────────────────────────────────────

/** Convert LLMMessage to OpenAI-format content (string or content blocks). */
function toOaiContent(msg: LLMMessage): string | unknown[] {
  if (!msg.attachments?.length) return msg.content
  return [
    { type: 'text', text: msg.content },
    ...msg.attachments.filter((a) => a.mimeType.startsWith('image/')).map((a) => ({
      type: 'image_url',
      image_url: { url: `data:${a.mimeType};base64,${a.base64}` },
    })),
  ]
}

/** Convert LLMMessage to Anthropic-format content (string or content blocks). */
function toAnthropicContent(msg: LLMMessage): string | unknown[] {
  if (!msg.attachments?.length) return msg.content
  return [
    ...msg.attachments.filter((a) => a.mimeType.startsWith('image/')).map((a) => ({
      type: 'image',
      source: { type: 'base64', media_type: a.mimeType, data: a.base64 },
    })),
    { type: 'text', text: msg.content },
  ]
}

/** Convert LLMMessage to Gemini-format parts array. */
function toGeminiParts(msg: LLMMessage): unknown[] {
  if (!msg.attachments?.length) return [{ text: msg.content }]
  return [
    ...msg.attachments.filter((a) => a.mimeType.startsWith('image/')).map((a) => ({
      inline_data: { mime_type: a.mimeType, data: a.base64 },
    })),
    { text: msg.content },
  ]
}

// ── Streaming helpers ─────────────────────────────────────────────────────────

/** Callback for streaming LLM output token-by-token. */
export type StreamCallback = (delta: string, accumulated: string) => void

/** Parse an SSE (Server-Sent Events) response stream into individual events. */
async function* parseSSE(response: Response, signal?: AbortSignal): AsyncGenerator<{ event?: string; data: string }> {
  const body = response.body
  if (!body) return
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let currentEvent: string | undefined

  // Cancel the reader when abort fires — this unblocks reader.read()
  const onAbort = () => { reader.cancel().catch(() => {}) }
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    while (true) {
      if (signal?.aborted) break
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let newlineIdx: number
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx).trimEnd()
        buffer = buffer.slice(newlineIdx + 1)
        if (line === '') { currentEvent = undefined; continue }
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim()
        } else if (line.startsWith('data: ')) {
          const data = line.slice(6)
          if (data === '[DONE]') return
          yield { event: currentEvent, data }
        }
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    reader.releaseLock()
  }
}

// ── Shared types ─────────────────────────────────────────────────────────────

interface OAIToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

type OAIMsg =
  | { role: 'system' | 'user' | 'assistant'; content: string | null; tool_calls?: OAIToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

// ── OpenAI SSE stream parser ─────────────────────────────────────────────────

/**
 * Extract readable text from partial tool call JSON args.
 * For send_message → shows the "content" field; for mark_done → shows "result".
 * Returns empty string if no readable text found yet.
 */
function extractToolCallText(name: string, args: string): string {
  const field = name === 'mark_done' || name === 'set_result' ? 'result' : 'content'
  // Match the field value — handles partial JSON where closing quote may not exist yet
  const match = args.match(new RegExp(`"${field}"\\s*:\\s*"([\\s\\S]*)$`))
  if (!match) return ''
  let text = match[1]
  // Remove trailing quote + any JSON after it (next field or closing brace)
  if (text.endsWith('"}') || text.endsWith('",')) text = text.slice(0, -2)
  else if (text.endsWith('"')) text = text.slice(0, -1)
  return text
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"')
    .replace(/\\t/g, '\t')
    .replace(/\\\\/g, '\\')
}

async function streamOpenAIResponse(
  resp: Response,
  onStream?: StreamCallback,
  signal?: AbortSignal,
): Promise<{ content: string; toolCalls: OAIToolCall[] }> {
  let content = ''
  const toolCallMap = new Map<number, { id: string; name: string; args: string }>()

  for await (const { data } of parseSSE(resp, signal)) {
    if (signal?.aborted) break
    let chunk: any
    try { chunk = JSON.parse(data) } catch { continue }

    const delta = chunk.choices?.[0]?.delta
    if (!delta) continue

    if (delta.content) {
      content += delta.content
      onStream?.(delta.content, content)
    }

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0
        const existing = toolCallMap.get(idx) ?? { id: '', name: '', args: '' }
        if (tc.id) existing.id = tc.id
        if (tc.function?.name) existing.name += tc.function.name
        if (tc.function?.arguments) {
          existing.args += tc.function.arguments
          // Stream extracted readable text, not raw JSON
          const readable = extractToolCallText(existing.name, existing.args)
          if (readable) {
            onStream?.(tc.function.arguments, content + readable)
          }
        }
        toolCallMap.set(idx, existing)
      }
    }
  }

  return {
    content,
    toolCalls: [...toolCallMap.values()].map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.name, arguments: tc.args },
    })),
  }
}

// ── Ollama native stream parser ──────────────────────────────────────────────

/**
 * Parse Ollama /api/chat streaming response (newline-delimited JSON).
 * Returns the same format as streamOpenAIResponse for interchangeability.
 */
async function streamOllamaResponse(
  resp: Response,
  onStream?: StreamCallback,
  signal?: AbortSignal,
): Promise<{ content: string; toolCalls: OAIToolCall[] }> {
  let content = ''
  const toolCalls: OAIToolCall[] = []

  const body = resp.body
  if (!body) return { content, toolCalls }
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  // Cancel the reader when abort fires — this unblocks reader.read()
  const onAbort = () => { reader.cancel().catch(() => {}) }
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    while (true) {
      if (signal?.aborted) break
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let newlineIdx: number
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim()
        buffer = buffer.slice(newlineIdx + 1)
        if (!line) continue

        let chunk: any
        try { chunk = JSON.parse(line) } catch { continue }

        // Text content delta
        if (chunk.message?.content) {
          content += chunk.message.content
          onStream?.(chunk.message.content, content)
        }

        // Tool calls (returned in the final chunk)
        if (chunk.message?.tool_calls?.length) {
          for (const tc of chunk.message.tool_calls) {
            const args = tc.function?.arguments
            toolCalls.push({
              id: tc.id || `call_${toolCalls.length}`,
              type: 'function',
              function: {
                name: tc.function?.name ?? '',
                // Ollama returns args as object, stringify for consistency
                arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
              },
            })
          }
        }
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    reader.releaseLock()
  }

  return { content, toolCalls }
}

// ── Anthropic SSE stream parser ──────────────────────────────────────────────

interface AStreamBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  _rawInput?: string
}

async function streamAnthropicResponse(
  resp: Response,
  onStream?: StreamCallback,
): Promise<{ content: AStreamBlock[]; stopReason: string | null }> {
  const blocks: AStreamBlock[] = []
  let stopReason: string | null = null
  let textAccumulated = ''

  for await (const { data } of parseSSE(resp)) {
    let parsed: any
    try { parsed = JSON.parse(data) } catch { continue }

    switch (parsed.type) {
      case 'content_block_start': {
        const block = parsed.content_block
        if (block.type === 'text') {
          blocks.push({ type: 'text', text: '' })
        } else if (block.type === 'tool_use') {
          blocks.push({ type: 'tool_use', id: block.id, name: block.name, input: {}, _rawInput: '' })
        }
        break
      }
      case 'content_block_delta': {
        const delta = parsed.delta
        const block = blocks[parsed.index]
        if (delta.type === 'text_delta' && block?.type === 'text') {
          block.text = (block.text ?? '') + delta.text
          textAccumulated += delta.text
          onStream?.(delta.text, textAccumulated)
        } else if (delta.type === 'input_json_delta' && block?.type === 'tool_use') {
          block._rawInput = (block._rawInput ?? '') + delta.partial_json
          // Stream extracted readable text, not raw JSON
          const readable = extractToolCallText(block.name ?? '', block._rawInput)
          if (readable) {
            onStream?.(delta.partial_json, textAccumulated + readable)
          }
        }
        break
      }
      case 'message_delta': {
        if (parsed.delta?.stop_reason) stopReason = parsed.delta.stop_reason
        break
      }
    }
  }

  // Parse accumulated JSON for tool inputs
  for (const block of blocks) {
    if (block.type === 'tool_use' && block._rawInput) {
      try { block.input = JSON.parse(block._rawInput) } catch { /* leave empty */ }
      delete block._rawInput
    }
  }

  return { content: blocks, stopReason }
}

// ── CORS proxy helper ─────────────────────────────────────────────────────────

/**
 * Route through the CORS proxy only when necessary.
 * Local targets and domains with native browser CORS support go direct.
 */
export function proxiedFetch(url: string, init: RequestInit, settings: Settings): Promise<Response> {
  if (!needsProxy(url)) return fetch(url, init)

  // Resolve proxy URL — ensure it's absolute
  let proxyUrl = settings.proxyUrl?.trim() || '/cors-proxy'
  if (proxyUrl.startsWith('/')) proxyUrl = `${window.location.origin}${proxyUrl}`
  proxyUrl = proxyUrl.replace(/\/$/, '')

  const headers = new Headers(init.headers)
  headers.set('X-Target-URL', url)

  return fetch(proxyUrl, {
    ...init,
    headers,
  }).catch((err) => {
    throw new TypeError(`${err.message} [proxy=${proxyUrl}, target=${url}]`)
  })
}

/** Domains that DON'T need the CORS proxy (they already allow browser requests). */
const SKIP_PROXY = new Set([
  'localhost', '127.0.0.1', '::1', '0.0.0.0',
  'api.openai.com',
  'api.anthropic.com',
  'openrouter.ai',
  'generativelanguage.googleapis.com',
  'api.together.xyz',
  'api.cloudflare.com',
])

function needsProxy(url: string): boolean {
  try {
    return !SKIP_PROXY.has(new URL(url).hostname)
  } catch {
    return true
  }
}

// ── Simple text call (no tools) ───────────────────────────────────────────────

export async function callLLM(
  systemPrompt: string,
  messages: LLMMessage[],
  settings: Settings,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<string> {
  switch (settings.apiFormat) {
    case 'anthropic': return callAnthropic(systemPrompt, messages, settings, signal)
    case 'gemini':    return callGemini(systemPrompt, messages, settings, signal)
    case 'webllm':    return callWebLLM(
      [{ role: 'system', content: systemPrompt }, ...messages.map((m) => ({ role: m.role, content: toOaiContent(m) as string }))],
      settings.model,
      16384,
      onProgress,
    )
    default:          return callOpenAICompat(systemPrompt, messages, settings, signal)
  }
}

// ── Tool-enabled call (handles multi-turn tool loop internally) ───────────────

export interface ToolCallEvent {
  agentId: string
  record: ToolCallRecord
}

export async function callLLMWithTools(
  systemPrompt: string,
  messages: LLMMessage[],
  settings: Settings,
  tools: OAITool[],
  agentId: string,
  onToolCall: (e: ToolCallEvent) => void,
  signal?: AbortSignal,
  executor?: ToolExecutor,
  onProgress?: ProgressCallback,
  onStream?: StreamCallback,
): Promise<string> {
  // Gemini has no tool calling support — fall back to text-only
  if (settings.apiFormat === 'gemini') {
    return callGemini(systemPrompt, messages, settings, signal)
  }
  if (settings.apiFormat === 'anthropic') {
    return callAnthropicWithTools(systemPrompt, messages, settings, tools, agentId, onToolCall, signal, executor, onStream)
  }
  // Only route to WebLLM when it's explicitly enabled.
  // If apiFormat='webllm' but webllmEnabled=false (e.g. stale settings from a previous session),
  // fall through to OpenAI-compat so agents aren't silently broken.
  if (settings.apiFormat === 'webllm' && settings.webllmEnabled) {
    return callWebLLMWithTools(systemPrompt, messages, settings, tools, agentId, onToolCall, executor, onProgress)
  }
  return callOpenAIWithTools(systemPrompt, messages, settings, tools, agentId, onToolCall, signal, executor, onStream)
}

// ── OpenAI-compatible ─────────────────────────────────────────────────────────

async function callOpenAICompat(
  system: string,
  messages: LLMMessage[],
  settings: Settings,
  signal?: AbortSignal,
): Promise<string> {
  const oaiMsgs = [{ role: 'system', content: system }, ...messages.map((m) => ({ role: m.role, content: toOaiContent(m) }))]
  const resp = await oaiFetch(settings, oaiMsgs, undefined, signal)
  const data = await resp.json()
  const text = data?.choices?.[0]?.message?.content
  if (typeof text !== 'string') throw new Error(`Unexpected response: ${JSON.stringify(data)}`)
  return text
}

async function callOpenAIWithTools(
  system: string,
  messages: LLMMessage[],
  settings: Settings,
  tools: OAITool[],
  agentId: string,
  onToolCall: (e: ToolCallEvent) => void,
  signal?: AbortSignal,
  executor?: ToolExecutor,
  onStream?: StreamCallback,
): Promise<string> {
  let activeTools: OAITool[] | undefined = tools
  const msgs: OAIMsg[] = [{ role: 'system', content: system }, ...messages.map((m) => ({ role: m.role, content: toOaiContent(m) } as OAIMsg))]
  // Track total accumulated text across tool-call rounds so streaming doesn't reset
  let totalAccumulated = ''

  for (let round = 0; round < 12; round++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    let resp: Response
    const useStream = !!onStream
    // Wrap the stream callback to add the prior rounds' text
    const roundStreamCb: StreamCallback | undefined = onStream
      ? (delta, _acc) => { totalAccumulated += delta; onStream(delta, totalAccumulated) }
      : undefined
    try {
      resp = await oaiFetch(settings, msgs, activeTools, signal, useStream)
    } catch (err) {
      // If the model doesn't support tools, retry without them (text-only fallback)
      if (activeTools?.length && err instanceof Error && err.message.includes('does not support tools')) {
        activeTools = undefined
        resp = await oaiFetch(settings, msgs, undefined, signal, useStream)
      } else {
        throw err
      }
    }

    // Parse response — streaming (SSE) or regular JSON
    let content: string | null = null
    let toolCalls: OAIToolCall[] = []

    if (useStream) {
      const streamParser = isOllamaEndpoint(settings.apiEndpoint) ? streamOllamaResponse : streamOpenAIResponse
      const result = await streamParser(resp, roundStreamCb, signal)
      content = result.content || null
      toolCalls = result.toolCalls
    } else {
      const data = await resp.json()
      const choice = data?.choices?.[0]
      if (!choice) throw new Error(`Empty choices: ${JSON.stringify(data)}`)
      content = typeof choice.message?.content === 'string' ? choice.message.content : null
      toolCalls = choice.message?.tool_calls ?? []
    }

    const isOllama = isOllamaEndpoint(settings.apiEndpoint)

    // Add assistant message to history
    // Ollama /api/chat expects tool_call arguments as objects, not JSON strings.
    // It also doesn't use 'id' or 'type' fields on tool_calls.
    if (toolCalls.length > 0) {
      if (isOllama) {
        const ollamaToolCalls = toolCalls.map((tc) => {
          const rawArgs = tc.function.arguments
          const argsObj = typeof rawArgs === 'object' && rawArgs !== null
            ? rawArgs
            : (() => { try { return JSON.parse(rawArgs as string) } catch { return {} } })()
          return { function: { name: tc.function.name, arguments: argsObj } }
        })
        msgs.push({ role: 'assistant', content: content ?? '', tool_calls: ollamaToolCalls } as OAIMsg)
      } else {
        const assistantMsg: OAIMsg = { role: 'assistant', content }
        assistantMsg.tool_calls = toolCalls
        msgs.push(assistantMsg)
      }
    } else {
      msgs.push({ role: 'assistant', content } as OAIMsg)
    }

    if (toolCalls.length > 0) {
      // Execute all tool calls in this round
      for (const tc of toolCalls) {
        let args: Record<string, unknown> = {}
        // Ollama /api/chat returns arguments as object; OpenAI returns as string
        const rawArgs = tc.function.arguments
        if (typeof rawArgs === 'object' && rawArgs !== null) {
          args = rawArgs as Record<string, unknown>
        } else {
          try { args = JSON.parse(rawArgs) } catch { /* leave empty */ }
        }

        const exec = executor ?? executeTool
        const record = await exec(tc.id, tc.function.name, args)
        onToolCall({ agentId, record })

        // Ollama /api/chat doesn't use tool_call_id
        if (isOllama) {
          msgs.push({ role: 'tool', tool_call_id: '', content: record.result })
        } else {
          msgs.push({ role: 'tool', tool_call_id: tc.id, content: record.result })
        }
      }
    } else {
      return content ?? ''
    }
  }

  throw new Error('Tool-call loop exceeded max rounds')
}


/** Detect if an endpoint is an Ollama instance (localhost:11434). */
function isOllamaEndpoint(endpoint: string): boolean {
  return endpoint.includes('localhost:11434') || endpoint.includes('127.0.0.1:11434')
}

function oaiFetch(settings: Settings, messages: unknown[], tools?: OAITool[], signal?: AbortSignal, stream = false) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (settings.apiKey.trim()) headers['authorization'] = `Bearer ${settings.apiKey}`
  if (settings.apiEndpoint.includes('openrouter')) {
    headers['http-referer'] = 'http://localhost'
    headers['x-title'] = 'GREMLIN'
  }

  // For Ollama: use native /api/chat so options.num_ctx is respected.
  // The /v1/chat/completions shim silently ignores num_ctx.
  const useOllamaNative = isOllamaEndpoint(settings.apiEndpoint)

  const body: Record<string, unknown> = {
    model: settings.model,
    messages,
    stream,
  }

  if (useOllamaNative) {
    body.options = { num_ctx: computeNumCtx(settings.model) }
    body.keep_alive = -1  // keep loaded indefinitely — unloaded explicitly on stop
  } else {
    body.max_tokens = 16384
    if (isLocalEndpoint(settings.apiEndpoint)) {
      body.options = { num_ctx: computeNumCtx(settings.model) }
    }
  }

  if (tools?.length) {
    body.tools = tools
    // Ollama /api/chat does not support tool_choice — only set for OpenAI-compat
    if (!useOllamaNative) body.tool_choice = 'auto'
  }

  // Rewrite URL to /api/chat for Ollama
  let endpoint = settings.apiEndpoint
  if (useOllamaNative) {
    endpoint = endpoint.replace(/\/v1\/chat\/completions.*$/, '/api/chat')
  }

  return proxiedFetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal }, settings)
    .then(async (r) => {
      if (!r.ok) return r.text().then((t) => {
        if (t.includes('not found') || t.includes('pull')) {
          throw new Error(`Model "${settings.model}" is not installed. Run: ollama pull ${settings.model}`)
        }
        throw new Error(`API ${r.status}: ${t}`)
      })
      // Non-streaming Ollama: wrap response into OpenAI format
      if (useOllamaNative && !stream) {
        const data = await r.json()
        const hasToolCalls = data.message?.tool_calls?.length > 0
        const wrapped = {
          choices: [{
            index: 0,
            message: data.message,
            finish_reason: hasToolCalls ? 'tool_calls' : (data.done ? 'stop' : null),
          }],
          model: data.model,
          usage: {
            prompt_tokens: data.prompt_eval_count ?? 0,
            completion_tokens: data.eval_count ?? 0,
          },
        }
        return new Response(JSON.stringify(wrapped), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return r
    })
}

// ── Anthropic ─────────────────────────────────────────────────────────────────

async function callAnthropic(
  system: string,
  messages: LLMMessage[],
  settings: Settings,
  signal?: AbortSignal,
): Promise<string> {
  const aMsgs = messages.map((m) => ({ role: m.role, content: toAnthropicContent(m) }))
  const resp = await anthropicFetch(settings, system, aMsgs, undefined, signal)
  const data = await resp.json()
  const text = data?.content?.find((b: { type: string }) => b.type === 'text')?.text
  if (typeof text !== 'string') throw new Error(`Unexpected Anthropic response: ${JSON.stringify(data)}`)
  return text
}

async function callAnthropicWithTools(
  system: string,
  messages: LLMMessage[],
  settings: Settings,
  tools: OAITool[],
  agentId: string,
  onToolCall: (e: ToolCallEvent) => void,
  signal?: AbortSignal,
  executor?: ToolExecutor,
  onStream?: StreamCallback,
): Promise<string> {
  type ABlock =
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
    | { type: 'tool_result'; tool_use_id: string; content: string }

  type AMsg = { role: 'user' | 'assistant'; content: string | ABlock[] }

  const msgs: AMsg[] = messages.map((m) => ({ role: m.role, content: toAnthropicContent(m) }))
  // Track total accumulated text across tool-call rounds so streaming doesn't reset
  let totalAccumulated = ''

  for (let round = 0; round < 12; round++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const useStream = !!onStream
    const roundStreamCb: StreamCallback | undefined = onStream
      ? (delta, _acc) => { totalAccumulated += delta; onStream(delta, totalAccumulated) }
      : undefined
    const resp = await anthropicFetch(settings, system, msgs, tools, signal, useStream)

    // Parse response — streaming (SSE) or regular JSON
    let contentBlocks: ABlock[]
    let stopReason: string | null

    if (useStream) {
      const result = await streamAnthropicResponse(resp, roundStreamCb)
      contentBlocks = result.content as ABlock[]
      stopReason = result.stopReason
    } else {
      const data = await resp.json()
      contentBlocks = data.content as ABlock[]
      stopReason = data.stop_reason
    }

    const toolUseBlocks = contentBlocks.filter((b) => b.type === 'tool_use') as Array<{
      type: 'tool_use'; id: string; name: string; input: Record<string, unknown>
    }>

    if (stopReason === 'tool_use' || toolUseBlocks.length > 0) {
      msgs.push({ role: 'assistant', content: contentBlocks })

      const toolResults: ABlock[] = []
      for (const tu of toolUseBlocks) {
        const exec = executor ?? executeTool
        const record = await exec(tu.id, tu.name, tu.input)
        onToolCall({ agentId, record })
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: record.result })
      }
      msgs.push({ role: 'user', content: toolResults })
    } else {
      const text = contentBlocks
        .filter((b) => b.type === 'text')
        .map((b) => (b as { type: 'text'; text: string }).text)
        .join('')
      return text
    }
  }

  throw new Error('Anthropic tool-call loop exceeded max rounds')
}

function anthropicFetch(
  settings: Settings,
  system: string,
  messages: unknown[],
  tools?: OAITool[],
  signal?: AbortSignal,
  stream = false,
) {
  const body: Record<string, unknown> = {
    model: settings.model,
    max_tokens: 16384,
    system,
    messages,
    stream,
  }
  if (tools?.length) body.tools = toAnthropicTools(tools)

  return proxiedFetch(settings.apiEndpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': settings.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
    signal,
  }, settings).then((r) => {
    if (!r.ok) return r.text().then((t) => { throw new Error(`Anthropic ${r.status}: ${t}`) })
    return r
  })
}

// ── WebLLM (in-browser WebGPU inference) ─────────────────────────────────────

async function callWebLLMWithTools(
  system: string,
  messages: LLMMessage[],
  settings: Settings,
  tools: OAITool[],
  agentId: string,
  onToolCall: (e: ToolCallEvent) => void,
  executor?: ToolExecutor,
  onProgress?: ProgressCallback,
): Promise<string> {
  const { getEngine } = await import('./webllm')

  const eng = await getEngine(settings.model, onProgress)
  const msgs: OAIMsg[] = [{ role: 'system', content: system }, ...messages.map((m) => ({ role: m.role, content: toOaiContent(m) } as OAIMsg))]

  for (let round = 0; round < 12; round++) {
    const resp = await eng.chat.completions.create({
      messages: msgs as Parameters<typeof eng.chat.completions.create>[0]['messages'],
      max_tokens: 16384,
      tools: tools as Parameters<typeof eng.chat.completions.create>[0]['tools'],
      tool_choice: 'auto',
      stream: false,
    })

    const choice = resp.choices[0]
    if (!choice) throw new Error('WebLLM: empty choices')

    const msg = choice.message as OAIMsg
    msgs.push(msg)

    if (choice.finish_reason === 'tool_calls' && msg.role === 'assistant' && msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        let args: Record<string, unknown> = {}
        try { args = JSON.parse(tc.function.arguments) } catch { /* leave empty */ }

        const exec = executor ?? executeTool
        const record = await exec(tc.id, tc.function.name, args)
        onToolCall({ agentId, record })
        msgs.push({ role: 'tool', tool_call_id: tc.id, content: record.result })
      }
    } else {
      return typeof msg.content === 'string' ? msg.content : ''
    }
  }

  throw new Error('WebLLM tool-call loop exceeded max rounds')
}

// ── Google Gemini ─────────────────────────────────────────────────────────────

async function callGemini(
  system: string,
  messages: LLMMessage[],
  settings: Settings,
  signal?: AbortSignal,
): Promise<string> {
  const base = settings.apiEndpoint.replace(/\/$/, '')
  const url = `${base}/models/${settings.model}:generateContent?key=${settings.apiKey}`

  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: toGeminiParts(m),
  }))

  const resp = await proxiedFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents,
      generationConfig: { maxOutputTokens: 4096 },
    }),
    signal,
  }, settings)
  if (!resp.ok) throw new Error(`Gemini ${resp.status}: ${await resp.text()}`)
  const data = await resp.json()
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text
  if (typeof text !== 'string') throw new Error(`Unexpected Gemini response: ${JSON.stringify(data)}`)
  return text
}

// ── Model discovery ───────────────────────────────────────────────────────────

/**
 * Tell Ollama to unload model(s) from memory immediately.
 * Detects Ollama by matching the provider endpoint (not a magic port number).
 * Unloads the global model AND any per-agent model overrides.
 * Returns a log string on failure, or null on success/no-op.
 */
export async function unloadOllamaModels(
  settings: Settings,
  agents: Array<{ model?: string }> = [],
): Promise<string | null> {
  // Collect ALL Ollama base URLs from global endpoint + multi-provider list
  const ollamaPattern = /localhost:11434|127\.0\.0\.1:11434/
  const bases = new Set<string>()

  if (ollamaPattern.test(settings.apiEndpoint)) {
    bases.add(settings.apiEndpoint.replace(/\/v1.*$/, ''))
  }
  for (const p of settings.llmProviders ?? []) {
    if (ollamaPattern.test(p.endpoint)) {
      bases.add(p.endpoint.replace(/\/v1.*$/, ''))
    }
  }

  if (bases.size === 0) return null

  const errors: string[] = []

  for (const base of bases) {
    // Query what's actually loaded in Ollama and unload those directly
    // This is more reliable than guessing model names (handles :latest tags, etc.)
    try {
      const psResp = await fetch(`${base}/api/ps`)
      if (psResp.ok) {
        const psData = await psResp.json()
        const loaded = (psData.models ?? []) as Array<{ name: string }>
        await Promise.all(loaded.map(async (m) => {
          try {
            const resp = await fetch(`${base}/api/generate`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ model: m.name, keep_alive: 0 }),
            })
            if (!resp.ok) errors.push(`${m.name}: HTTP ${resp.status}`)
          } catch (err) {
            errors.push(`${m.name}: ${err instanceof Error ? err.message : String(err)}`)
          }
        }))
        continue  // ps-based unload succeeded — skip name-based fallback for this endpoint
      }
    } catch { /* fall through to name-based approach */ }

    // Fallback: unload by configured model names
    const models = new Set<string>()
    if (settings.model) models.add(settings.model)
    for (const a of agents) {
      if (a.model?.trim()) models.add(a.model.trim())
    }
    await Promise.all([...models].map(async (model) => {
      try {
        const resp = await fetch(`${base}/api/generate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, keep_alive: 0 }),
        })
        if (!resp.ok) errors.push(`${model}: HTTP ${resp.status}`)
      } catch (err) {
        errors.push(`${model}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }))
  }

  return errors.length > 0 ? `Failed to unload: ${errors.join('; ')}` : null
}

export async function fetchOllamaModels(baseUrl: string): Promise<string[]> {
  const base = baseUrl.replace(/\/v1.*$/, '')
  const resp = await fetch(`${base}/api/tags`)
  if (!resp.ok) throw new Error(`${resp.status}`)
  const data = await resp.json()
  return ((data.models ?? []) as Array<{ name: string }>).map((m) => m.name).sort()
}

// ── Ollama library (remote model catalog) ────────────────────────────────────

export interface OllamaLibraryModel {
  name: string
  sizeGB: number
  modifiedAt: string
}

const LIBRARY_CACHE_KEY = 'gremlin_ollama_library'
const LIBRARY_CACHE_TTL = 24 * 60 * 60 * 1000 // 24 hours

/**
 * Fetch available models from the Ollama library (ollama.com/api/tags).
 * Result is cached in localStorage for 24 hours.
 */
export async function fetchOllamaLibrary(): Promise<OllamaLibraryModel[]> {
  // Return cached data if fresh
  try {
    const raw = localStorage.getItem(LIBRARY_CACHE_KEY)
    if (raw) {
      const { data, ts } = JSON.parse(raw)
      if (Date.now() - ts < LIBRARY_CACHE_TTL) return data
    }
  } catch { /* ignore */ }

  // Fetch via built-in CORS proxy
  const proxyUrl = `${window.location.origin}/cors-proxy`
  const resp = await fetch(proxyUrl, {
    headers: { 'X-Target-URL': 'https://ollama.com/api/tags?limit=1000' },
  })
  if (!resp.ok) throw new Error(`Ollama library: HTTP ${resp.status}`)
  const json = await resp.json()

  const models: OllamaLibraryModel[] = ((json.models ?? []) as Array<{ name: string; size: number; modified_at: string }>)
    .map((m) => ({
      name: m.name,
      sizeGB: Math.round(m.size / 1e9 * 10) / 10,
      modifiedAt: m.modified_at,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))

  try {
    localStorage.setItem(LIBRARY_CACHE_KEY, JSON.stringify({ data: models, ts: Date.now() }))
  } catch { /* ignore */ }

  return models
}

/**
 * Pull an Ollama model, streaming progress to a callback.
 * Resolves when pull is complete; rejects on error.
 */
export async function pullOllamaModel(
  baseUrl: string,
  model: string,
  onProgress?: (status: string, pct: number | null) => void,
): Promise<void> {
  const base = baseUrl.replace(/\/v1.*$/, '')
  const resp = await fetch(`${base}/api/pull`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: true }),
  })
  if (!resp.ok) throw new Error(`Pull ${model}: HTTP ${resp.status}`)
  const reader = resp.body?.getReader()
  if (!reader) throw new Error('No response body')
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const j = JSON.parse(line)
        const pct = j.total ? Math.round((j.completed ?? 0) / j.total * 100) : null
        onProgress?.(j.status ?? '', pct)
        if (j.error) throw new Error(j.error)
      } catch (e) {
        if (e instanceof SyntaxError) continue
        throw e
      }
    }
  }
}

/**
 * Check which models from a list are missing in Ollama and pull them.
 * Returns the list of models that were pulled.
 */
export async function ensureOllamaModels(
  baseUrl: string,
  needed: string[],
  onProgress?: (model: string, status: string, pct: number | null) => void,
  signal?: AbortSignal,
): Promise<string[]> {
  if (needed.length === 0) return []
  let installed: string[]
  try {
    installed = await fetchOllamaModels(baseUrl)
  } catch {
    return [] // Ollama not reachable — skip check, let the LLM call fail naturally
  }

  // Normalize: Ollama tags may include ":latest" implicitly
  const installedSet = new Set(installed)
  const missing = needed.filter((m) => {
    if (installedSet.has(m)) return false
    // Also check with :latest suffix
    if (!m.includes(':') && installedSet.has(`${m}:latest`)) return false
    return true
  })

  if (missing.length === 0) return []

  const pulled: string[] = []
  for (const model of missing) {
    if (signal?.aborted) break
    try {
      await pullOllamaModel(baseUrl, model, (status, pct) => onProgress?.(model, status, pct))
      pulled.push(model)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      onProgress?.(model, `error: ${msg}`, null)
    }
  }
  return pulled
}

export async function fetchOpenAIModels(endpoint: string, apiKey: string): Promise<string[]> {
  const base = endpoint.replace(/\/chat\/completions.*$/, '').replace(/\/$/, '')
  const headers: Record<string, string> = {}
  if (apiKey.trim()) headers['authorization'] = `Bearer ${apiKey}`
  const resp = await fetch(`${base}/models`, { headers })
  if (!resp.ok) throw new Error(`${resp.status}`)
  const data = await resp.json()
  return ((data.data ?? []) as Array<{ id: string }>).map((m) => m.id).sort()
}
