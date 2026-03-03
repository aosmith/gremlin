import type { LLMMessage, Settings } from './types'
import { PROVIDERS } from './types'
import type { OAITool, ToolCallRecord } from './tools'
import { toAnthropicTools, executeTool } from './tools'
import { callWebLLM } from './webllm'
import type { ProgressCallback } from './webllm'

// ── CORS proxy helper ─────────────────────────────────────────────────────────

/**
 * If a proxyUrl is configured, route the request through the CORS proxy.
 * The original URL is passed in the X-Target-URL header.
 * Otherwise, just call fetch directly.
 */
function proxiedFetch(url: string, init: RequestInit, settings: Settings): Promise<Response> {
  if (!settings.proxyUrl) return fetch(url, init)

  const headers = new Headers(init.headers)
  headers.set('X-Target-URL', url)

  return fetch(settings.proxyUrl.replace(/\/$/, ''), {
    ...init,
    headers,
  })
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
      [{ role: 'system', content: systemPrompt }, ...messages],
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
): Promise<string> {
  if (settings.apiFormat === 'anthropic') {
    return callAnthropicWithTools(systemPrompt, messages, settings, tools, agentId, onToolCall, signal)
  }
  if (settings.apiFormat === 'webllm') {
    return callWebLLMWithTools(systemPrompt, messages, settings, tools, agentId, onToolCall)
  }
  return callOpenAIWithTools(systemPrompt, messages, settings, tools, agentId, onToolCall, signal)
}

// ── OpenAI-compatible ─────────────────────────────────────────────────────────

async function callOpenAICompat(
  system: string,
  messages: LLMMessage[],
  settings: Settings,
  signal?: AbortSignal,
): Promise<string> {
  const resp = await oaiFetch(settings, [{ role: 'system', content: system }, ...messages], undefined, signal)
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
): Promise<string> {
  // Internal mutable message list for the tool loop
  type OAIMsg =
    | { role: 'system' | 'user' | 'assistant'; content: string | null; tool_calls?: OAIToolCall[] }
    | { role: 'tool'; tool_call_id: string; content: string }

  interface OAIToolCall {
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }

  const msgs: OAIMsg[] = [{ role: 'system', content: system }, ...messages]

  for (let round = 0; round < 20; round++) {
    const resp = await oaiFetch(settings, msgs, tools, signal)
    const data = await resp.json()
    const choice = data?.choices?.[0]

    if (!choice) throw new Error(`Empty choices: ${JSON.stringify(data)}`)

    const msg = choice.message as OAIMsg
    msgs.push(msg)

    if (choice.finish_reason === 'tool_calls' && msg.role === 'assistant' && msg.tool_calls?.length) {
      // Execute all tool calls in this round
      for (const tc of msg.tool_calls) {
        let args: Record<string, unknown> = {}
        try { args = JSON.parse(tc.function.arguments) } catch { /* leave empty */ }

        const record = await executeTool(tc.id, tc.function.name, args)
        onToolCall({ agentId, record })

        msgs.push({ role: 'tool', tool_call_id: tc.id, content: record.result })
      }
      // Continue the loop to let the model react to tool results
    } else {
      // Model is done with tools — return final text
      const text = typeof msg.content === 'string' ? msg.content : ''
      return text
    }
  }

  throw new Error('Tool-call loop exceeded max rounds')
}

function oaiFetch(settings: Settings, messages: unknown[], tools?: OAITool[], signal?: AbortSignal) {
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
  const resp = await anthropicFetch(settings, system, messages, undefined, signal)
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
): Promise<string> {
  type ABlock =
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
    | { type: 'tool_result'; tool_use_id: string; content: string }

  type AMsg = { role: 'user' | 'assistant'; content: string | ABlock[] }

  const msgs: AMsg[] = messages.map((m) => ({ role: m.role, content: m.content }))

  for (let round = 0; round < 20; round++) {
    const resp = await anthropicFetch(settings, system, msgs, tools, signal)
    const data = await resp.json()

    if (data.stop_reason === 'tool_use') {
      const toolUseBlocks = (data.content as ABlock[]).filter((b) => b.type === 'tool_use') as Array<{
        type: 'tool_use'; id: string; name: string; input: Record<string, unknown>
      }>

      msgs.push({ role: 'assistant', content: data.content })

      const toolResults: ABlock[] = []
      for (const tu of toolUseBlocks) {
        const record = await executeTool(tu.id, tu.name, tu.input)
        onToolCall({ agentId, record })
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: record.result })
      }
      msgs.push({ role: 'user', content: toolResults })
    } else {
      const text = (data.content as ABlock[])
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
) {
  const body: Record<string, unknown> = {
    model: settings.model,
    max_tokens: 4096,
    system,
    messages,
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
): Promise<string> {
  // WebLLM may not support native tool calling in all models.
  // Fall back to a prompt-based tool loop using a schema description.
  // For models that do support tool_calls via the MLC engine, this still works
  // because we use the OpenAI-compatible interface.
  const { getEngine } = await import('./webllm')

  type OAIMsg =
    | { role: 'system' | 'user' | 'assistant'; content: string | null; tool_calls?: OAIToolCall[] }
    | { role: 'tool'; tool_call_id: string; content: string }

  interface OAIToolCall {
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }

  const eng = await getEngine(settings.model)
  const msgs: OAIMsg[] = [{ role: 'system', content: system }, ...messages]

  for (let round = 0; round < 20; round++) {
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

        const record = await executeTool(tc.id, tc.function.name, args)
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
    parts: [{ text: m.content }],
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
