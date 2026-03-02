/**
 * AgentRunner — the multi-agent orchestration engine.
 *
 * Execution model:
 *   Round 1 : Orchestrator receives the user task, decomposes it, assigns subtasks to workers.
 *   Round 2+ : Workers execute, can message each other or the synthesizer.
 *   Final   : Synthesizer receives all worker outputs and produces the final answer.
 *
 * All messages are routed through the WASM Coordinator so the UI can monitor everything.
 * In engineering mode (tools provided) agents can call write_file / read_file / list_directory.
 */

import { callLLM, callLLMWithTools } from './api'
import type { ToolCallEvent } from './api'
import type { OAITool } from './tools'
import type { ProgressCallback } from './webllm'
import * as coord from './coordinator'
import type { AgentConfig, AgentResponse, AgentStatus, LLMMessage, Message, Settings } from './types'

export interface RunnerCallbacks {
  onMessage: (msg: Message) => void
  onStatusUpdate: (agentId: string, status: AgentStatus) => void
  onLog: (text: string) => void
  onOutput: (output: string) => void
  onRound?: (round: number) => void
  onToolCall?: (e: ToolCallEvent) => void
  onProgress?: ProgressCallback   // WebLLM model-load progress
  onDone: () => void
}

/** Max LLM messages kept per agent (20 = 10 user/assistant turn pairs). */
const MAX_HISTORY_PER_AGENT = 20

/** Retry config for transient LLM errors (network failures, 429/5xx). */
const MAX_RETRIES = 3
const RETRY_BASE_MS = 2_000

export class AgentRunner {
  private configs = new Map<string, AgentConfig>()
  private histories = new Map<string, LLMMessage[]>()
  /** How many messages each agent has already processed (index into coord.getMessagesFor). */
  private processedCounts = new Map<string, number>()
  private settings!: Settings
  private cb!: RunnerCallbacks
  private tools: OAITool[] = []
  private aborted = false
  private abortController = new AbortController()
  private loopRunning = false
  private agents: AgentConfig[] = []
  private round = 0

  abort() {
    this.aborted = true
    this.abortController.abort()
    this.histories.clear()
  }

  async run(
    task: string,
    agents: AgentConfig[],
    settings: Settings,
    callbacks: RunnerCallbacks,
    tools: OAITool[] = [],
  ): Promise<void> {
    this.aborted = false
    this.abortController = new AbortController()
    this.settings = settings
    this.cb = callbacks
    this.tools = tools
    this.agents = agents
    this.round = 0
    this.configs = new Map(agents.map((a) => [a.id, a]))
    this.histories = new Map(agents.map((a) => [a.id, []]))
    this.processedCounts = new Map(agents.map((a) => [a.id, 0]))

    // Reset WASM coordinator state and register all agents
    coord.clearSession()
    coord.setRunning(true)
    for (const agent of agents) coord.addAgent(agent)

    const orchestrator = agents.find((a) => a.role === 'orchestrator')
    if (!orchestrator) throw new Error('No orchestrator agent found')

    // Inject user task into orchestrator's inbox
    this.emit({ fromAgent: 'user', toAgent: orchestrator.id, content: task, type: 'task', timestamp: Date.now(), round: 0 })

    callbacks.onLog(`Session started${tools.length ? ' (dev mode — file tools enabled)' : ''}`)

    await this.runLoop()

    coord.setRunning(false)
    callbacks.onDone()
  }

  // ── Core loop — shared between initial run and human-message resumption ──────
  private async runLoop(): Promise<void> {
    if (this.loopRunning) return   // already running, the next iteration will pick it up
    this.loopRunning = true

    const agents = this.agents

    try {
      while (!this.aborted) {
        this.round++
        if (this.round > this.settings.maxRounds) break

        const pending = agents.filter((a) => {
          const total = coord.getMessageCountFor(a.id)
          return total > (this.processedCounts.get(a.id) ?? 0)
        })

        if (pending.length === 0) {
          this.cb.onLog('No pending messages — session complete')
          break
        }

        this.cb.onLog(`Round ${this.round}: running ${pending.map((a) => a.name).join(', ')}`)
        this.cb.onRound?.(this.round)

        await Promise.all(pending.map((a) => this.runAgentTurn(a, this.round)))

        if (this.aborted) break

        // Check if all workers are done so we can prompt the synthesizer
        const workers = agents.filter((a) => a.role === 'worker' || a.role === 'custom')
        const synthesizer = agents.find((a) => a.role === 'synthesizer')

        if (workers.length > 0 && synthesizer) {
          const allWorkersDone = workers.every(
            (w) => coord.getAgentStatus(w.id) === 'done' || coord.getAgentStatus(w.id) === 'error',
          )
          const synthStatus = coord.getAgentStatus(synthesizer.id)

          if (allWorkersDone && synthStatus !== 'done') {
            const workerSummaries = workers.map((w) => {
              const msgs = coord.getMessagesFor(synthesizer.id).filter((m) => m.fromAgent === w.id)
              if (msgs.length > 0) return null
              const hist = this.histories.get(w.id) ?? []
              const lastAssistant = [...hist].reverse().find((m) => m.role === 'assistant')
              return lastAssistant ? `[${w.name}]: ${lastAssistant.content}` : null
            })

            const unseenSummaries = workerSummaries.filter(Boolean)
            if (unseenSummaries.length > 0) {
              this.emit({
                fromAgent: 'system',
                toAgent: synthesizer.id,
                content: 'All workers have completed. Please synthesize their findings:\n\n' + unseenSummaries.join('\n\n'),
                type: 'system',
                timestamp: Date.now(),
                round: this.round,
              })
            }
          }

          // Only exit when done AND no pending human messages remain
          if (allWorkersDone && synthStatus === 'done') {
            const anyPending = agents.some(
              (a) => coord.getMessageCountFor(a.id) > (this.processedCounts.get(a.id) ?? 0),
            )
            if (!anyPending) {
              this.cb.onLog('All agents done')
              break
            }
          }
        }

        // Single-agent / orchestrator-only mode
        if (workers.length === 0 && !agents.find((a) => a.role === 'synthesizer')) {
          const allDone = agents.every(
            (a) => coord.getAgentStatus(a.id) === 'done' || coord.getAgentStatus(a.id) === 'error',
          )
          if (allDone) {
            const anyPending = agents.some(
              (a) => coord.getMessageCountFor(a.id) > (this.processedCounts.get(a.id) ?? 0),
            )
            if (!anyPending) break
          }
        }
      }
    } finally {
      this.loopRunning = false
    }
  }

  // ── Human-in-the-loop: inject a message into a running agent's inbox ────────
  injectHumanMessage(targetAgentId: string, content: string): void {
    this.emit({ fromAgent: 'user', toAgent: targetAgentId, content, type: 'human', timestamp: Date.now(), round: this.round })
    // If the main loop has already exited, resume it to process this message
    if (!this.loopRunning && !this.aborted) {
      coord.setRunning(true)
      this.runLoop().then(() => {
        coord.setRunning(false)
        this.cb?.onDone()
      })
    }
  }

  // ── Retry: re-run a failed agent's last turn ──────────────────────────────────
  retryAgent(agentId: string): void {
    const agent = this.configs.get(agentId)
    if (!agent) return
    const count = this.processedCounts.get(agentId) ?? 0
    if (count === 0) return

    // Roll back so the agent re-processes its last batch of messages
    this.processedCounts.set(agentId, Math.max(0, count - 1))
    coord.updateAgentStatus(agentId, 'waiting')
    this.cb.onStatusUpdate(agentId, 'waiting')
    this.cb.onLog(`Retrying ${agent.name}…`)

    // Run the single agent turn directly (bypass runLoop to avoid maxRounds block)
    coord.setRunning(true)
    this.runAgentTurn(agent, this.round).then(() => {
      // After the retry, resume the loop for any follow-on messages
      // Give it headroom by resetting the round counter
      this.round = Math.max(0, this.round - 2)
      if (!this.aborted) {
        this.runLoop().then(() => {
          coord.setRunning(false)
          this.cb?.onDone()
        })
      } else {
        coord.setRunning(false)
        this.cb?.onDone()
      }
    })
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  /** Route a message through the coordinator and emit it to the UI in one call. */
  private emit(msg: Omit<Message, 'id'>): void {
    const id = coord.routeMessage(msg)
    this.cb.onMessage({ ...msg, id })
  }

  private async runAgentTurn(agent: AgentConfig, round: number): Promise<void> {
    const allMsgs = coord.getMessagesFor(agent.id)
    const processed = this.processedCounts.get(agent.id) ?? 0
    const newMsgs = allMsgs.slice(processed)

    if (newMsgs.length === 0) return

    this.processedCounts.set(agent.id, allMsgs.length)

    coord.updateAgentStatus(agent.id, 'running')
    this.cb.onStatusUpdate(agent.id, 'running')

    // Compose the turn's user-facing content from new messages
    const userContent = newMsgs
      .map((m) => {
        const fromName = this.configs.get(m.fromAgent)?.name ?? m.fromAgent
        return `[From ${fromName}]:\n${m.content}`
      })
      .join('\n\n---\n\n')

    const history = this.histories.get(agent.id) ?? []
    const systemPrompt = this.buildSystemPrompt(agent)

    // Per-agent model override: merge into a local settings copy if set
    const agentSettings = agent.model?.trim()
      ? { ...this.settings, model: agent.model.trim() }
      : this.settings

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        let response: string

        const signal = this.abortController.signal
        if (this.tools.length > 0) {
          response = await callLLMWithTools(
            systemPrompt,
            [...history, { role: 'user', content: userContent }],
            agentSettings,
            this.tools,
            agent.id,
            (e) => {
              this.cb.onToolCall?.(e)
              const summary = e.record.isError
                ? `✖ ${e.record.name} failed: ${e.record.result}`
                : `🔧 ${e.record.name}(${JSON.stringify(e.record.args)}) → ${e.record.result.slice(0, 120)}`
              this.emit({ fromAgent: agent.id, toAgent: 'system', content: summary, type: 'system', timestamp: Date.now(), round })
            },
            signal,
          )
        } else {
          response = await callLLM(
            systemPrompt,
            [...history, { role: 'user', content: userContent }],
            agentSettings,
            this.cb.onProgress,
            signal,
          )
        }

        // Persist conversation history (pruned to last N messages)
        const updated: LLMMessage[] = [...history, { role: 'user', content: userContent }, { role: 'assistant', content: response }]
        this.histories.set(agent.id, updated.length > MAX_HISTORY_PER_AGENT ? updated.slice(-MAX_HISTORY_PER_AGENT) : updated)

        const parsed = this.parseResponse(response)

        // Route outgoing messages
        for (const outMsg of parsed.messages) {
          const target = this.resolveAgent(outMsg.to)
          if (!target) {
            this.cb.onLog(`⚠ ${agent.name} tried to message unknown agent "${outMsg.to}" — skipped`)
            continue
          }
          this.emit({ fromAgent: agent.id, toAgent: target.id, content: outMsg.content, type: 'message', timestamp: Date.now(), round })
        }

        const newStatus: AgentStatus = parsed.done ? 'done' : 'waiting'
        coord.updateAgentStatus(agent.id, newStatus)
        this.cb.onStatusUpdate(agent.id, newStatus)

        if (parsed.done && agent.role === 'synthesizer') {
          const output = this.formatSynthesizerOutput(parsed)
          if (output) this.cb.onOutput(output)
        }

        return  // success — exit retry loop
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return  // user stopped the run
        if (this.aborted) return

        const msg = err instanceof Error ? err.message : String(err)

        if (attempt < MAX_RETRIES) {
          const delay = RETRY_BASE_MS * Math.pow(2, attempt)
          this.cb.onLog(`⚠ ${agent.name} failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${msg} — retrying in ${(delay / 1000).toFixed(0)}s`)
          this.cb.onStatusUpdate(agent.id, 'waiting')
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, delay)
            // If aborted while waiting, resolve immediately
            const onAbort = () => { clearTimeout(timer); resolve() }
            this.abortController.signal.addEventListener('abort', onAbort, { once: true })
          })
          if (this.aborted) return
        } else {
          coord.updateAgentStatus(agent.id, 'error')
          this.cb.onStatusUpdate(agent.id, 'error')
          this.emit({ fromAgent: agent.id, toAgent: 'user', content: `Error after ${MAX_RETRIES + 1} attempts: ${msg}`, type: 'error', timestamp: Date.now(), round })
        }
      }
    }
  }

  private buildSystemPrompt(agent: AgentConfig): string {
    const others = Array.from(this.configs.values())
      .filter((a) => a.id !== agent.id)
      .map((a) => `  • ${a.id} (${a.name}) — ${a.role}`)
      .join('\n')

    const toolSection = this.tools.length > 0 ? `
File system tools available to you:
  • write_file(path, content)   — create or overwrite a file (parent dirs auto-created)
  • read_file(path)             — read full file content
  • list_directory(path)        — list files and sub-directories
All paths are relative to the project root. Use tools to implement your tasks directly.
` : ''

    return `${agent.systemPrompt}
${toolSection}
---
You are operating inside GREMLIN, a multi-agent coordination system.
Your agent ID : ${agent.id}
Your name    : ${agent.name}

Other agents you can communicate with:
${others}

IMPORTANT — You MUST reply with valid JSON only (no markdown, no prose outside the JSON):

{
  "analysis": "<your reasoning and work>",
  "messages": [
    { "to": "<agent_id_or_name>", "content": "<message>" }
  ],
  "done": false,
  "result": null
}

Rules:
• "analysis"  — your full reasoning / work output
• "messages"  — messages to send to other agents; use [] if none
• "done"       — set true only when you have fully completed your task
• "result"     — your final conclusion (set when done: true; null otherwise)
• ONLY message agents listed above — use their exact ID. Never invent agent names
${agent.role === 'orchestrator' ? `
ORCHESTRATOR INSTRUCTIONS — You are the team lead. You must NOT do all the work yourself.
• On your FIRST turn, decompose the task and send specific assignments to each worker agent via "messages"
• Set "done": false — you are NOT done until workers have reported back
• Wait for worker responses before drawing conclusions
• After receiving worker outputs, send a synthesis request to the synthesizer agent
• Never set "done": true on your first turn` : ''}
${agent.role === 'synthesizer' ? `
SYNTHESIZER INSTRUCTIONS — Your "result" field is shown directly to a human user.
Write it as clear, well-structured Markdown prose — NOT JSON, NOT bullet-point dumps.
Use headings (##, ###), paragraphs, bold for emphasis, tables, and lists where appropriate.
Write for a human reader: be COMPREHENSIVE and THOROUGH. Include:
• Full analysis and reasoning, not just conclusions
• Specific data points, evidence, and sources referenced by team members
• Actionable recommendations with concrete details
• Trade-offs, caveats, and areas of uncertainty
• A structured breakdown — use multiple sections with headings
Do NOT summarise briefly — the user wants depth. Aim for a complete, detailed report.
Never put raw JSON, code fences around the whole result, or agent IDs in the result.
` : ''}`
  }

  private parseResponse(raw: string): AgentResponse {
    try {
      // Strip <think>...</think> blocks produced by reasoning models (DeepSeek R1, QwQ, etc.)
      const noThink = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
      // Strip optional markdown fences
      const stripped = noThink.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')
      const start = stripped.indexOf('{')
      const end = stripped.lastIndexOf('}')
      if (start !== -1 && end !== -1) {
        const parsed = JSON.parse(stripped.slice(start, end + 1))
        return {
          analysis: typeof parsed.analysis === 'string' ? parsed.analysis : '',
          messages: Array.isArray(parsed.messages) ? parsed.messages : [],
          done: Boolean(parsed.done),
          result: typeof parsed.result === 'string' ? parsed.result
            : parsed.result != null ? this.flattenResult(parsed.result)
            : null,
        }
      }
    } catch {
      // Fallthrough to plain-text fallback
    }
    // Plain-text fallback — treat entire response as final result
    return { analysis: raw, messages: [], done: true, result: raw }
  }

  /** Build the full output JSON string — formatting happens at render time in cleanContent.ts. */
  private formatSynthesizerOutput(parsed: AgentResponse): string {
    // Pass the full parsed response as JSON — store's cleanOutput will format all fields
    return JSON.stringify({
      analysis: parsed.analysis || undefined,
      messages: parsed.messages.length > 0
        ? parsed.messages.map((m) => ({ to: this.configs.get(m.to)?.name ?? m.to, content: m.content }))
        : undefined,
      result: parsed.result || undefined,
    })
  }

  /** Convert a non-string result (object/array) into readable prose. */
  private flattenResult(val: unknown): string {
    if (typeof val === 'string') return val
    if (Array.isArray(val)) {
      return val.map((v) => typeof v === 'string' ? v : this.flattenResult(v)).join('\n\n')
    }
    if (val && typeof val === 'object') {
      const obj = val as Record<string, unknown>
      // Extract known prose fields
      const parts: string[] = []
      for (const [key, v] of Object.entries(obj)) {
        if (typeof v === 'string' && v.trim()) {
          parts.push(v.trim())
        } else if (Array.isArray(v)) {
          parts.push(`**${key}**:\n${v.map((item) => typeof item === 'string' ? `- ${item}` : this.flattenResult(item)).join('\n')}`)
        }
      }
      if (parts.length > 0) return parts.join('\n\n')
    }
    return JSON.stringify(val, null, 2)
  }

  private resolveAgent(nameOrId: string): AgentConfig | undefined {
    const key = nameOrId.toLowerCase().replace(/[\s_-]+/g, '')
    const agents = Array.from(this.configs.values())

    // Exact ID match
    const byId = this.configs.get(nameOrId)
    if (byId) return byId

    // Exact name match (case-insensitive)
    const byName = agents.find((a) => a.name.toLowerCase() === nameOrId.toLowerCase())
    if (byName) return byName

    // Fuzzy: normalized substring match on id or name
    const bySubstring = agents.find((a) => {
      const normId = a.id.toLowerCase().replace(/[\s_-]+/g, '')
      const normName = a.name.toLowerCase().replace(/[\s_-]+/g, '')
      return normId.includes(key) || key.includes(normId) ||
             normName.includes(key) || key.includes(normName)
    })
    return bySubstring
  }
}
