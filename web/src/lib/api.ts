import type { LLMMessage, Settings } from './types'
import { PROVIDERS } from './types'
import type { OAITool, ToolCallRecord, ToolExecutor } from './tools'
import { toAnthropicTools, executeTool } from './tools'
import { callWebLLM } from './webllm'
import type { ProgressCallback } from './webllm'

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
async function* parseSSE(response: Response): AsyncGenerator<{ event?: string; data: string }> {
  const body = response.body
  if (!body) return
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let currentEvent: string | undefined

  try {
    while (true) {
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

async function streamOpenAIResponse(
  resp: Response,
  onStream?: StreamCallback,
): Promise<{ content: string; toolCalls: OAIToolCall[] }> {
  let content = ''
  const toolCallMap = new Map<number, { id: string; name: string; args: string }>()

  for await (const { data } of parseSSE(resp)) {
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
        if (tc.function?.arguments) existing.args += tc.function.arguments
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
      4096,
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
  if (settings.apiFormat === 'webllm') {
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

  // Disable streaming for local Ollama — SSE parsing can hang and local latency is minimal
  const isLocalOllama = settings.apiEndpoint.includes('localhost:11434') || settings.apiEndpoint.includes('127.0.0.1:11434')
  for (let round = 0; round < 4; round++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    let resp: Response
    const useStream = !!onStream && !isLocalOllama
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
      const result = await streamOpenAIResponse(resp, onStream)
      content = result.content || null
      toolCalls = result.toolCalls
    } else {
      const data = await resp.json()
      const choice = data?.choices?.[0]
      if (!choice) throw new Error(`Empty choices: ${JSON.stringify(data)}`)
      content = typeof choice.message?.content === 'string' ? choice.message.content : null
      toolCalls = choice.message?.tool_calls ?? []
    }

    // Add assistant message to history
    const assistantMsg: OAIMsg = { role: 'assistant', content }
    if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls
    msgs.push(assistantMsg)

    if (toolCalls.length > 0) {
      // Execute all tool calls in this round
      for (const tc of toolCalls) {
        let args: Record<string, unknown> = {}
        try { args = JSON.parse(tc.function.arguments) } catch { /* leave empty */ }

        const exec = executor ?? executeTool
        const record = await exec(tc.id, tc.function.name, args)
        onToolCall({ agentId, record })

        msgs.push({ role: 'tool', tool_call_id: tc.id, content: record.result })
      }
    } else {
      return content ?? ''
    }
  }

  throw new Error('Tool-call loop exceeded max rounds')
}


function oaiFetch(settings: Settings, messages: unknown[], tools?: OAITool[], signal?: AbortSignal, stream = false) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (settings.apiKey.trim()) headers['authorization'] = `Bearer ${settings.apiKey}`
  if (settings.apiEndpoint.includes('openrouter')) {
    headers['http-referer'] = 'http://localhost'
    headers['x-title'] = 'GREMLIN'
  }

  const body: Record<string, unknown> = {
    model: settings.model,
    max_tokens: 4096,
    messages,
    stream,
  }
  if (tools?.length) {
    body.tools = tools
    body.tool_choice = 'auto'
  }

  return proxiedFetch(settings.apiEndpoint, { method: 'POST', headers, body: JSON.stringify(body), signal }, settings)
    .then((r) => {
      if (!r.ok) return r.text().then((t) => {
        // Ollama returns a plain error object when the model isn't installed
        if (t.includes('not found') || t.includes('pull')) {
          throw new Error(`Model "${settings.model}" is not installed. Run: ollama pull ${settings.model}`)
        }
        throw new Error(`API ${r.status}: ${t}`)
      })
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

  for (let round = 0; round < 4; round++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const useStream = !!onStream
    const resp = await anthropicFetch(settings, system, msgs, tools, signal, useStream)

    // Parse response — streaming (SSE) or regular JSON
    let contentBlocks: ABlock[]
    let stopReason: string | null

    if (useStream) {
      const result = await streamAnthropicResponse(resp, onStream)
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
    max_tokens: 4096,
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

  for (let round = 0; round < 4; round++) {
    const resp = await eng.chat.completions.create({
      messages: msgs as Parameters<typeof eng.chat.completions.create>[0]['messages'],
      max_tokens: 4096,
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
const OLLAMA_ENDPOINT = PROVIDERS.find((p) => p.id === 'ollama')!.endpoint

export async function unloadOllamaModels(
  settings: Settings,
  agents: Array<{ model?: string }> = [],
): Promise<string | null> {
  // Only act when the user is actually pointing at an Ollama server
  if (!settings.apiEndpoint.replace(/\/$/, '').startsWith(OLLAMA_ENDPOINT.replace(/\/v1.*$/, ''))) return null

  const base = settings.apiEndpoint.replace(/\/v1.*$/, '')

  // Query what's actually loaded in Ollama and unload those directly
  // This is more reliable than guessing model names (handles :latest tags, etc.)
  try {
    const psResp = await fetch(`${base}/api/ps`, { signal: AbortSignal.timeout(5_000) })
    if (psResp.ok) {
      const psData = await psResp.json()
      const loaded = (psData.models ?? []) as Array<{ name: string }>
      if (loaded.length > 0) {
        const errors: string[] = []
        await Promise.all(loaded.map(async (m) => {
          try {
            const resp = await fetch(`${base}/api/generate`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ model: m.name, keep_alive: 0 }),
              signal: AbortSignal.timeout(10_000),
            })
            if (!resp.ok) errors.push(`${m.name}: HTTP ${resp.status}`)
          } catch (err) {
            errors.push(`${m.name}: ${err instanceof Error ? err.message : String(err)}`)
          }
        }))
        return errors.length > 0 ? `Failed to unload: ${errors.join('; ')}` : null
      }
    }
  } catch { /* fall through to name-based approach */ }

  // Fallback: unload by configured model names
  const models = new Set<string>()
  if (settings.model) models.add(settings.model)
  for (const a of agents) {
    if (a.model?.trim()) models.add(a.model.trim())
  }
  if (models.size === 0) return null

  const errors: string[] = []
  await Promise.all([...models].map(async (model) => {
    try {
      const resp = await fetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, keep_alive: 0 }),
        signal: AbortSignal.timeout(10_000),
      })
      if (!resp.ok) errors.push(`${model}: HTTP ${resp.status}`)
    } catch (err) {
      errors.push(`${model}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }))

  return errors.length > 0 ? `Failed to unload: ${errors.join('; ')}` : null
}

export async function fetchOllamaModels(baseUrl: string): Promise<string[]> {
  const base = baseUrl.replace(/\/v1.*$/, '')
  const resp = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(3000) })
  if (!resp.ok) throw new Error(`${resp.status}`)
  const data = await resp.json()
  return ((data.models ?? []) as Array<{ name: string }>).map((m) => m.name).sort()
}

export async function fetchOpenAIModels(endpoint: string, apiKey: string): Promise<string[]> {
  const base = endpoint.replace(/\/chat\/completions.*$/, '').replace(/\/$/, '')
  const headers: Record<string, string> = {}
  if (apiKey.trim()) headers['authorization'] = `Bearer ${apiKey}`
  const resp = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(5000) })
  if (!resp.ok) throw new Error(`${resp.status}`)
  const data = await resp.json()
  return ((data.data ?? []) as Array<{ id: string }>).map((m) => m.id).sort()
}
