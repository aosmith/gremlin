/**
 * AgentRunner — the multi-agent orchestration engine.
 *
 * Execution model:
 *   Round 1 : Orchestrator receives the user task, decomposes it, assigns subtasks to workers.
 *   Round 2+ : Workers execute, can message each other or the synthesizer.
 *   Final   : Synthesizer receives all worker outputs and produces the final answer.
 *
 * All messages are routed through the Coordinator so the UI can monitor everything.
 * In engineering mode (tools provided) agents can call write_file / read_file / list_directory.
 */

import { callLLMWithTools } from './api'
import type { ToolCallEvent, StreamCallback } from './api'
import type { OAITool, ToolExecutor, ToolCallRecord } from './tools'
import { PROTOCOL_TOOLS, PROTOCOL_TOOL_NAMES, executeTool } from './tools'
import type { ProgressCallback } from './webllm'
import * as coord from './coordinator'
import type { AgentConfig, AgentResponse, AgentStatus, Attachment, LLMMessage, Message, Settings } from './types'

/** State collected from protocol tool calls during a single agent turn. */
interface CollectedState {
  messages: Array<{ to: string; content: string }>
  done: boolean
  result: string | null
  hadProtocolCalls: boolean
}

export interface RunnerCallbacks {
  onMessage: (msg: Message) => void
  onStatusUpdate: (agentId: string, status: AgentStatus) => void
  onLog: (text: string) => void
  onOutput: (output: string) => void
  onRound?: (round: number) => void
  onToolCall?: (e: ToolCallEvent) => void
  onProgress?: ProgressCallback   // WebLLM model-load progress
  /** Called with streaming text as the LLM generates it token-by-token. agentId=null signals end. */
  onStream?: (agentId: string | null, delta: string, accumulated: string) => void
  /** Called when an agent tries to message a hallucinated agent name. Returns true if user created the agent. */
  onUnknownAgent?: (fromAgent: string, name: string) => Promise<boolean>
  /** Called when round limit is hit. Returns extra rounds + instruction, or null to force-synthesize immediately. */
  onRoundsExhausted?: (currentRound: number, maxRounds: number) => Promise<{ extraRounds: number; instruction: string } | null>
  /** Called when an agent uses web_search but no provider is configured. Returns true if user set one up. */
  onSearchNotConfigured?: () => Promise<boolean>
  onDone: () => void
}

/** Max LLM messages kept per agent (20 = 10 user/assistant turn pairs). */
const MAX_HISTORY_PER_AGENT = 20

/** Retry config for transient LLM errors (network failures, 429/5xx). */
const MAX_RETRIES = 3
const RETRY_BASE_MS = 2_000

/** Max agents hitting the LLM simultaneously (prevents overwhelming providers). */
const MAX_CONCURRENT = 3

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
  /** Names already skipped or created — don't prompt again. */
  private seenUnknownAgents = new Set<string>()
  /** Whether we've already shown the suggestion modal this run. */
  private promptedForAgents = false
  /** Outgoing message content per agent — used to build detailed output. */
  private sentContent = new Map<string, string[]>()
  /** Attachments from the user (images, etc.) — injected into each agent's first turn. */
  private taskAttachments: Attachment[] = []
  /** Cumulative LLM latency per agent (ms). */
  private agentLatency = new Map<string, number>()
  /** LLM turn count per agent. */
  private agentTurns = new Map<string, number>()

  abort() {
    this.aborted = true
    this.abortController.abort()
    this.histories.clear()
  }

  /** Get per-agent performance metrics. */
  getMetrics(): Map<string, { latencyMs: number; turns: number }> {
    const result = new Map<string, { latencyMs: number; turns: number }>()
    for (const [id, ms] of this.agentLatency) {
      result.set(id, { latencyMs: Math.round(ms), turns: this.agentTurns.get(id) ?? 0 })
    }
    return result
  }

  /** Register a new agent mid-run (e.g. created from a hallucinated name). */
  addAgent(agent: AgentConfig): void {
    this.configs.set(agent.id, agent)
    this.agents.push(agent)
    this.histories.set(agent.id, [])
    this.processedCounts.set(agent.id, 0)
    this.sentContent.set(agent.id, [])
    coord.addAgent(agent)
  }

  /** Combine protocol tools with any dev tools (file ops in engineering mode). */
  private buildAllTools(): OAITool[] {
    return [...PROTOCOL_TOOLS, ...this.tools]
  }

  /** Create a ToolExecutor that captures protocol tool calls into mutable state. */
  private createExecutor(collected: CollectedState, agentSettings: Settings): ToolExecutor {
    return async (id: string, name: string, args: Record<string, unknown>): Promise<ToolCallRecord> => {
      if (name === 'send_message') {
        const to = String(args.to ?? '')
        const content = String(args.content ?? '')
        collected.messages.push({ to, content })
        collected.hadProtocolCalls = true
        return { id, name, args, result: `Message queued for ${to}`, isError: false }
      }
      if (name === 'mark_done') {
        collected.done = true
        collected.result = typeof args.result === 'string' ? args.result : null
        collected.hadProtocolCalls = true
        return { id, name, args, result: 'Marked as done', isError: false }
      }
      // Delegate to real tool executor (file ops + web search)
      return executeTool(id, name, args, agentSettings, this.cb.onSearchNotConfigured, this.abortController.signal)
    }
  }

  async run(
    task: string,
    agents: AgentConfig[],
    settings: Settings,
    attachments: Attachment[],
    callbacks: RunnerCallbacks,
    tools: OAITool[] = [],
  ): Promise<void> {
    this.aborted = false
    this.abortController = new AbortController()
    this.settings = settings
    this.cb = callbacks
    this.tools = tools
    this.agents = agents
    this.taskAttachments = attachments
    this.round = 0
    this.configs = new Map(agents.map((a) => [a.id, a]))
    this.histories = new Map(agents.map((a) => [a.id, []]))
    this.processedCounts = new Map(agents.map((a) => [a.id, 0]))
    this.seenUnknownAgents = new Set()
    this.promptedForAgents = false
    this.sentContent = new Map(agents.map((a) => [a.id, []]))
    this.agentLatency = new Map(agents.map((a) => [a.id, 0]))
    this.agentTurns = new Map(agents.map((a) => [a.id, 0]))

    // Reset coordinator state and register all agents
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
          // Deadlock guard: if no pending messages but synthesizer hasn't run,
          // force all waiting workers to "done" and trigger synthesis.
          const synthesizer = agents.find((a) => a.role === 'synthesizer')
          const synthStatus = synthesizer ? coord.getAgentStatus(synthesizer.id) : null
          if (synthesizer && synthStatus !== 'done') {
            const workers = agents.filter((a) => a.role === 'worker' || a.role === 'custom')
            const waitingWorkers = workers.filter((w) => coord.getAgentStatus(w.id) !== 'done' && coord.getAgentStatus(w.id) !== 'error')
            if (waitingWorkers.length > 0) {
              this.cb.onLog(`Deadlock detected — ${waitingWorkers.map((w) => w.name).join(', ')} waiting with no messages. Forcing synthesis.`)
              for (const w of waitingWorkers) {
                coord.updateAgentStatus(w.id, 'done')
                this.cb.onStatusUpdate(w.id, 'done')
              }
            }
            // Feed all worker output to synthesizer and continue the loop
            this.forceSynthesis(synthesizer, agents)
            continue  // re-enter the loop — synthesizer will now be pending
          }
          this.cb.onLog('No pending messages — session complete')
          break
        }

        this.cb.onLog(`Round ${this.round}: running ${pending.map((a) => a.name).join(', ')}`)
        this.cb.onRound?.(this.round)

        // Mark all pending agents as 'waiting' so the UI shows them queued
        // (runWithConcurrency will set them to 'running' one by one)
        for (const a of pending) {
          coord.updateAgentStatus(a.id, 'waiting')
          this.cb.onStatusUpdate(a.id, 'waiting')
        }

        // Run agents with concurrency limit to avoid overwhelming LLM providers
        await this.runWithConcurrency(pending, MAX_CONCURRENT, (a) => this.runAgentTurn(a, this.round))

        if (this.aborted) break

        // Check if all workers are done so we can prompt the synthesizer
        const workers = agents.filter((a) => a.role === 'worker' || a.role === 'custom')
        const synthesizer = agents.find((a) => a.role === 'synthesizer')

        if (workers.length > 0 && synthesizer) {
          let allWorkersDone = workers.every(
            (w) => coord.getAgentStatus(w.id) === 'done' || coord.getAgentStatus(w.id) === 'error',
          )
          const synthStatus = coord.getAgentStatus(synthesizer.id)

          // Peer-message wake-up: if all workers report "done" but some have
          // unprocessed messages (from peers who sent messages in the same round),
          // reset those workers to "waiting" so they process peer messages first.
          if (allWorkersDone) {
            const workersWithPending = workers.filter((w) => {
              const total = coord.getMessageCountFor(w.id)
              const processed = this.processedCounts.get(w.id) ?? 0
              return total > processed && coord.getAgentStatus(w.id) !== 'error'
            })
            if (workersWithPending.length > 0) {
              for (const w of workersWithPending) {
                coord.updateAgentStatus(w.id, 'waiting')
                this.cb.onStatusUpdate(w.id, 'waiting')
              }
              this.cb.onLog(`Peer messages pending for ${workersWithPending.map((w) => w.name).join(', ')} — deferring synthesis`)
              allWorkersDone = false
            }
          }

          if (allWorkersDone && synthStatus !== 'done') {
            const workerSummaries = workers.map((w) => {
              // Skip if synthesizer already received messages from this worker
              const msgs = coord.getMessagesFor(synthesizer.id).filter((m) => m.fromAgent === w.id)
              if (msgs.length > 0) return null
              // Prefer sent messages (detailed work) over last response summary
              const sent = this.sentContent.get(w.id) ?? []
              if (sent.length > 0) {
                const unique = [...new Set(sent)].filter((s) => s.trim().length > 20)
                if (unique.length > 0) return `[${w.name}]:\n${unique.join('\n\n')}`
              }
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

      // If we exited because rounds were exhausted, ask the user what to do
      if (this.round > this.settings.maxRounds && !this.aborted) {
        const synthesizer = agents.find((a) => a.role === 'synthesizer')
        let synthStatus = synthesizer ? coord.getAgentStatus(synthesizer.id) : null

        // The synthesizer may have pending messages queued in the last round
        // but never got a chance to run because the round limit broke the loop.
        // Let it run one final turn before deciding whether to show the modal.
        if (synthesizer && synthStatus !== 'done') {
          const synthPending = coord.getMessageCountFor(synthesizer.id) > (this.processedCounts.get(synthesizer.id) ?? 0)
          if (synthPending) {
            this.cb.onLog('Round limit reached — running final synthesis turn')
            await this.runAgentTurn(synthesizer, this.round)
            synthStatus = coord.getAgentStatus(synthesizer.id)
          }
        }

        if (synthesizer && synthStatus !== 'done') {
          // Ask user: continue with more rounds, or synthesize now?
          let continuation: { extraRounds: number; instruction: string } | null = null
          if (this.cb.onRoundsExhausted) {
            continuation = await this.cb.onRoundsExhausted(this.round, this.settings.maxRounds)
          }

          if (continuation && !this.aborted) {
            // User wants to continue — bump the limit, inject their instruction, resume
            this.settings = { ...this.settings, maxRounds: this.settings.maxRounds + continuation.extraRounds }
            this.round-- // offset the increment at the top of the loop

            const orchestrator = agents.find((a) => a.role === 'orchestrator')
            const target = orchestrator ?? synthesizer
            if (continuation.instruction.trim()) {
              this.emit({ fromAgent: 'user', toAgent: target.id, content: continuation.instruction, type: 'human', timestamp: Date.now(), round: this.round })
            }

            // Reset done status on non-done agents so they can continue
            for (const a of agents) {
              const status = coord.getAgentStatus(a.id)
              if (status === 'done' && a.role !== 'synthesizer') continue // leave finished workers alone
              if (status !== 'done' && status !== 'error') {
                coord.updateAgentStatus(a.id, 'waiting')
                this.cb.onStatusUpdate(a.id, 'waiting')
              }
            }

            this.cb.onLog(`Adding ${continuation.extraRounds} rounds (new limit: ${this.settings.maxRounds})`)
            await this.runLoop() // resume the loop with new budget
          } else if (!this.aborted) {
            // User chose to synthesize now (or no callback)
            this.cb.onLog(`⚠ Round limit (${this.settings.maxRounds}) reached — forcing synthesis with available work`)
            this.forceSynthesis(synthesizer, agents)
            await this.runAgentTurn(synthesizer, this.round)
          }
        } else if (!synthesizer) {
          this.cb.onLog(`⚠ Round limit (${this.settings.maxRounds}) reached — no synthesizer to produce final output`)
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
      // Reset for a new cycle: give round budget, wake up agents, clear output tracking
      this.round = 0
      this.sentContent = new Map(this.agents.map((a) => [a.id, []]))
      for (const a of this.agents) {
        const status = coord.getAgentStatus(a.id)
        if (status === 'done' || status === 'error') {
          coord.updateAgentStatus(a.id, 'waiting')
          this.cb.onStatusUpdate(a.id, 'waiting')
        }
      }
      coord.setRunning(true)
      this.cb.onLog('Follow-up received — starting new cycle')
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

  /** Run tasks with a concurrency limit — at most `limit` run simultaneously. */
  private async runWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
    const queue = [...items]
    const running: Promise<void>[] = []

    while ((queue.length > 0 || running.length > 0) && !this.aborted) {
      while (running.length < limit && queue.length > 0 && !this.aborted) {
        const item = queue.shift()!
        const p = fn(item).then(() => { running.splice(running.indexOf(p), 1) })
        running.push(p)
      }
      if (running.length > 0) await Promise.race(running)
    }
  }

  /** Route a message through the coordinator and emit it to the UI in one call. */
  private emit(msg: Omit<Message, 'id'>): void {
    const id = coord.routeMessage(msg)
    this.cb.onMessage({ ...msg, id })
  }

  /** Collect all worker outputs and feed them to the synthesizer for a final forced run. */
  private forceSynthesis(synthesizer: AgentConfig, agents: AgentConfig[]): void {
    const workers = agents.filter((a) => a.role === 'worker' || a.role === 'custom')
    const summaries = workers.map((w) => {
      // Prefer sent messages (detailed work product) over last response summary
      const sent = this.sentContent.get(w.id) ?? []
      if (sent.length > 0) {
        const unique = [...new Set(sent)].filter((s) => s.trim().length > 20)
        if (unique.length > 0) return `[${w.name}]:\n${unique.join('\n\n')}`
      }
      const hist = this.histories.get(w.id) ?? []
      const lastReply = [...hist].reverse().find((m) => m.role === 'assistant')
      return lastReply ? `[${w.name}]: ${lastReply.content}` : null
    }).filter(Boolean)

    if (summaries.length > 0) {
      this.emit({
        fromAgent: 'system',
        toAgent: synthesizer.id,
        content: 'Round limit reached. Synthesize all available findings NOW:\n\n' + summaries.join('\n\n'),
        type: 'system',
        timestamp: Date.now(),
        round: this.round,
      })
    }
  }

  private rerouteToOrchestrator(agent: AgentConfig, outMsg: { to: string; content: string }, round: number): void {
    const orchestrator = this.agents.find((a) => a.role === 'orchestrator')
    if (orchestrator && orchestrator.id !== agent.id) {
      this.cb.onLog(`↪ ${agent.name} → "${outMsg.to}" not found — rerouted to ${orchestrator.name}`)
      this.emit({ fromAgent: agent.id, toAgent: orchestrator.id, content: `[intended for "${outMsg.to}"] ${outMsg.content}`, type: 'message', timestamp: Date.now(), round })
    } else {
      this.cb.onLog(`⚠ ${agent.name} tried to message unknown agent "${outMsg.to}" — skipped`)
    }
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

    // Per-agent overrides: merge model and search provider into a local settings copy
    let agentSettings = this.settings
    if (agent.model?.trim()) agentSettings = { ...agentSettings, model: agent.model.trim() }
    if (agent.searchProvider?.trim()) agentSettings = { ...agentSettings, searchProvider: agent.searchProvider.trim() }

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const signal = this.abortController.signal
        const collected: CollectedState = { messages: [], done: false, result: null, hadProtocolCalls: false }
        const executor = this.createExecutor(collected, agentSettings)

        // Attach task images/files on the agent's first turn
        const userMsg: LLMMessage = { role: 'user', content: userContent }
        if (this.taskAttachments.length > 0 && history.length === 0) {
          userMsg.attachments = this.taskAttachments
        }

        // Build stream callback that tags with agent ID
        const streamCb: StreamCallback | undefined = this.cb.onStream
          ? (delta, accumulated) => this.cb.onStream!(agent.id, delta, accumulated)
          : undefined

        const t0 = performance.now()
        const response = await callLLMWithTools(
          systemPrompt,
          [...history, userMsg],
          agentSettings,
          this.buildAllTools(),
          agent.id,
          (e) => {
            // Only fire UI callback + log for non-protocol tools (dev tools)
            if (!PROTOCOL_TOOL_NAMES.has(e.record.name)) {
              this.cb.onToolCall?.(e)
              const summary = e.record.isError
                ? `✖ ${e.record.name} failed: ${e.record.result}`
                : `🔧 ${e.record.name}(${JSON.stringify(e.record.args)}) → ${e.record.result.slice(0, 120)}`
              this.emit({ fromAgent: agent.id, toAgent: 'system', content: summary, type: 'system', timestamp: Date.now(), round })
            }
          },
          signal,
          executor,
          this.cb.onProgress,
          streamCb,
        )
        const elapsed = performance.now() - t0
        this.agentLatency.set(agent.id, (this.agentLatency.get(agent.id) ?? 0) + elapsed)
        this.agentTurns.set(agent.id, (this.agentTurns.get(agent.id) ?? 0) + 1)

        // Clear streaming state now that the LLM call is complete
        this.cb.onStream?.(null, '', '')

        // Persist conversation history (pruned to last N messages)
        const updated: LLMMessage[] = [...history, userMsg, { role: 'assistant', content: response }]
        this.histories.set(agent.id, updated.length > MAX_HISTORY_PER_AGENT ? updated.slice(-MAX_HISTORY_PER_AGENT) : updated)

        // Prefer tool-collected state; fall back to JSON parsing for Gemini / non-compliant models
        const parsed: AgentResponse = collected.hadProtocolCalls
          ? { analysis: response, messages: collected.messages, done: collected.done, result: collected.result }
          : this.parseResponse(response)

        // Guard: if orchestrator claims done on round 1 with no messages, it failed to
        // delegate (common with fine-tuned / small models that ignore the JSON protocol).
        // Force it to stay active and auto-distribute the task to all workers.
        if (agent.role === 'orchestrator' && this.round <= 1 && parsed.messages.length === 0) {
          parsed.done = false
          const workers = this.agents.filter((a) => a.role === 'worker' || a.role === 'custom')
          if (workers.length > 0) {
            // Use the orchestrator's raw analysis (or the original task) as the assignment
            const taskContent = parsed.analysis || parsed.result || userContent
            for (const w of workers) {
              parsed.messages.push({ to: w.id, content: taskContent })
            }
            this.cb.onLog(`↪ ${agent.name} didn't delegate — auto-distributing task to ${workers.map((w) => w.name).join(', ')}`)
          }
        }

        // Route outgoing messages — collect unresolved names first, then prompt once
        const unresolved: Array<{ outMsg: { to: string; content: string }; cleanedName: string }> = []

        for (const outMsg of parsed.messages) {
          // Track all outgoing content for the final output
          const bucket = this.sentContent.get(agent.id)
          if (bucket) bucket.push(outMsg.content)

          const target = this.resolveAgent(outMsg.to)
          if (target) {
            this.emit({ fromAgent: agent.id, toAgent: target.id, content: outMsg.content, type: 'message', timestamp: Date.now(), round })
          } else {
            const cleaned = outMsg.to.trim().replace(/^["']+|["']+$/g, '').trim()
            if (!this.seenUnknownAgents.has(cleaned.toLowerCase())) {
              unresolved.push({ outMsg, cleanedName: cleaned })
            } else {
              // Already seen — silently reroute to orchestrator
              this.rerouteToOrchestrator(agent, outMsg, round)
            }
          }
        }

        // Prompt the user once per run with the first batch of unknown names.
        // Mark names as seen BEFORE the async await to prevent concurrent agents
        // from triggering duplicate modals (race condition fix).
        const trulyNew = unresolved.filter(({ cleanedName }) => !this.seenUnknownAgents.has(cleanedName.toLowerCase()))
        for (const { cleanedName } of trulyNew) this.seenUnknownAgents.add(cleanedName.toLowerCase())

        if (trulyNew.length > 0 && !this.promptedForAgents && this.cb.onUnknownAgent) {
          const names = trulyNew.map((u) => u.cleanedName)
          this.promptedForAgents = true
          const created = await this.cb.onUnknownAgent(agent.id, names.join(', '))
          if (created) {
            for (const { outMsg } of trulyNew) {
              const target = this.resolveAgent(outMsg.to)
              if (target) {
                this.emit({ fromAgent: agent.id, toAgent: target.id, content: outMsg.content, type: 'message', timestamp: Date.now(), round })
              } else {
                this.rerouteToOrchestrator(agent, outMsg, round)
              }
            }
          } else {
            for (const { outMsg } of trulyNew) {
              this.rerouteToOrchestrator(agent, outMsg, round)
            }
          }
        } else {
          for (const { outMsg } of unresolved) {
            this.rerouteToOrchestrator(agent, outMsg, round)
          }
        }

        const newStatus: AgentStatus = parsed.done ? 'done' : 'waiting'
        coord.updateAgentStatus(agent.id, newStatus)
        this.cb.onStatusUpdate(agent.id, newStatus)

        if (parsed.done && agent.role === 'synthesizer') {
          const output = this.formatSynthesizerOutput(parsed, agent)
          if (output) this.cb.onOutput(output)
        }

        return  // success — exit retry loop
      } catch (err) {
        if ((err instanceof Error && err.name === 'AbortError') || this.aborted) {
          // User stopped the run — make sure agent isn't stuck on 'running'
          if (coord.getAgentStatus(agent.id) === 'running') {
            coord.updateAgentStatus(agent.id, 'waiting')
            this.cb.onStatusUpdate(agent.id, 'waiting')
          }
          return
        }

        const msg = err instanceof Error ? err.message : String(err)

        // Don't retry errors that will just repeat (CORS is structural; "Failed to fetch" is often transient — rate limiting, connection pool)
        const noRetry = msg.includes('loop exceeded') || msg.includes('CORS')
        if (attempt < MAX_RETRIES && !noRetry) {
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
      .map((a) => `  • "${a.name}" [id=${a.id}] — ${a.role}`)
      .join('\n')

    const hasDevTools = this.tools.some((t) => t.function.name === 'write_file')
    const hasSearchTools = this.tools.some((t) => t.function.name === 'web_search')

    const devToolSection = hasDevTools ? `
File system tools also available:
  • write_file(path, content)   — create or overwrite a file (parent dirs auto-created)
  • read_file(path)             — read full file content
  • list_directory(path)        — list files and sub-directories
All paths are relative to the project root.
` : ''

    const searchToolSection = hasSearchTools ? `
Web tools available:
  • web_search(query) — search the internet for current data
  • web_fetch(url)    — fetch and read a web page

MANDATORY: Search before stating facts. But be EFFICIENT:
  1. Make 1-2 targeted web_search() calls for the key data you need
  2. Optionally web_fetch() one page if you need details from a specific URL
  3. Then write your analysis using the data you found
Do NOT make more than 3 tool calls per turn — search smart, not exhaustive.
Never state a fact you did not verify via search this session.
If web_search returns no results, say so — do not fill gaps with training data.
` : ''

    const remaining = this.settings.maxRounds - this.round
    const roundBudget = `\n\nROUND BUDGET: This is round ${this.round} of ${this.settings.maxRounds}. ${remaining <= 2 ? 'TIME IS ALMOST UP — wrap up and call mark_done() NOW.' : `You have ${remaining} rounds remaining. Be efficient.`}`

    const now = new Date()
    const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })

    return `${agent.systemPrompt}
${devToolSection}${searchToolSection}
---
TODAY'S DATE: ${dateStr}
All analysis must be FORWARD-LOOKING. NEVER state facts, figures, or data from memory — only use data you found via web search this session. If web search fails or returns no results, explicitly say the data is unavailable. Do NOT fill gaps with training data.

You are operating inside GREMLIN, a multi-agent coordination system.
Your agent ID : ${agent.id}
Your name     : ${agent.name}

Other agents you can communicate with:
${others}

COMMUNICATION — Use the provided tool functions:
  • send_message(to, content) — send a message to another agent (use their ID or name)
  • mark_done(result?)        — signal you have completed your task; optionally include a final result string

Your text/prose output is your analysis — it is displayed to humans with full Markdown rendering.
Use rich Markdown: ## headers, **bold**, tables, bullet points. Make it scannable and professional.
Actions (messaging, finishing) are done via tool calls.

Rules:
• Call send_message() for each agent you want to contact — you may call it multiple times
• Call mark_done() when you have fully completed your task
• Do NOT call mark_done() if you are still waiting for a response from another agent
• ONLY message agents listed above — use their name or ID. Never invent agent names.
• If tools are unavailable, respond with JSON: {"analysis": "...", "messages": [{"to": "Name or ID", "content": "..."}], "done": false, "result": null}
${agent.role === 'orchestrator' ? `
ORCHESTRATOR INSTRUCTIONS — You are the team lead. You must NOT do all the work yourself.
• On your FIRST turn, decompose the task and call send_message() for each worker with their assignment
• Do NOT call mark_done() — you are NOT done until workers have reported back
• Wait for worker responses before drawing conclusions
• After receiving worker outputs, send a synthesis request to the synthesizer agent
• Never call mark_done() on your first turn` : ''}
${agent.role === 'synthesizer' ? `
SYNTHESIZER INSTRUCTIONS — When you call mark_done(result), the "result" is shown directly to a human user.
Follow the output format specified in YOUR system prompt above. If your prompt says to output JSON, output JSON. If not, use rich Markdown.
Be COMPREHENSIVE and THOROUGH. Include:
• ALL specific data from workers — names, numbers, tickers, percentages, dollar amounts, rankings, scores, etc.
• Full analysis and reasoning, not just conclusions
• Actionable recommendations with concrete details
• Trade-offs, caveats, and areas of uncertainty
CRITICAL: You MUST include every concrete data point the workers provided. If workers listed tickers, include ALL tickers.
If workers provided numbers, include ALL numbers. Never replace specific data with vague summaries.
Do NOT say "based on the analysis" or "as discussed" — include the ACTUAL data inline.
Do NOT summarise briefly — the user wants depth. Aim for a complete, detailed report.

QUALITY GATE — If worker data is INSUFFICIENT for a high-quality report:
• Send messages back to specific workers requesting the missing data (e.g. "Need current P/E and price for $AAPL — please web_fetch Finviz")
• Do NOT call mark_done() yet — wait for the additional data
• Only produce your final report when you have enough concrete data to fill every field
• It is BETTER to request another round of data than to produce a weak report with gaps
` : ''}
${agent.role === 'worker' || agent.role === 'custom' ? `
WORKER INSTRUCTIONS — You can collaborate directly with other workers listed above.
• If your task overlaps with or depends on another worker's area, call send_message() to share findings, request input, or flag contradictions.
• If you sent a message to a peer and are waiting for their reply, do NOT call mark_done() so you stay active for the next round.
• Only call mark_done() when YOUR work is fully complete and you are NOT waiting on any peer response.
• Keep peer exchanges focused — one or two rounds of back-and-forth at most.
• Do NOT message peers just to be polite — only when it adds concrete value (shared data, dependency, contradiction).

OUTPUT FORMAT:
Your "analysis" text is displayed to humans in the Activity Monitor with full Markdown rendering.
Format it as RICH MARKDOWN — use headers (##), bold, tables, and bullet points for readability.
Structure every response with clear sections. Example:

## Key Findings
| Metric | Value |
|--------|-------|
| P/E    | 22.5  |
...

## Analysis
...

When sending data to OTHER AGENTS via send_message(), include structured data so they can parse it easily.
For financial data, include a JSON block in your message:
\`\`\`json
{"tickers": [{"symbol": "$AAPL", "price": 185.23, "pe": 29.1, ...}]}
\`\`\`

CRITICAL OUTPUT RULE: Always produce CONCRETE, SPECIFIC output — real data, names, numbers, lists, calculations.
Never describe what you "would do" or outline steps. Actually DO the work and report the results.
Bad: "Set up a scan with criteria and select top tickers"
Good: "Top 10 by market cap: $AAPL ($3.1T, 8.2%), $MSFT ($2.9T, 7.8%), ..."` : ''}
${roundBudget}${agent.systemPrompt.includes('$ prefix') ? `

OUTPUT FORMAT REMINDER — MANDATORY:
Every stock or company ticker MUST have a $ prefix: $AAPL, $MSFT, $NVDA, $GOOG.
First mention: "Company Name ($TICKER)". After that: $TICKER alone.
NEVER write a bare ticker without $. This is required for rendering.` : ''}`
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

  /** Build human-readable output from the synthesizer's parsed response. */
  private formatSynthesizerOutput(parsed: AgentResponse, synthAgent: AgentConfig): string {
    const sections: string[] = []

    // Result is the primary output — prefer it over analysis
    if (parsed.result?.trim()) {
      sections.push(parsed.result.trim())
    } else if (parsed.analysis?.trim()) {
      sections.push(parsed.analysis.trim())
    }

    // Show inter-agent directives if present
    if (parsed.messages.length > 0) {
      const items = parsed.messages
        .filter((m) => m.to && m.content)
        .map((m) => {
          const name = this.configs.get(m.to)?.name ?? m.to
          return `- **${name}** — ${m.content}`
        })
      if (items.length > 0) {
        sections.push(`### Directives\n\n${items.join('\n')}`)
      }
    }

    // Always append worker analyses so the user sees detailed work.
    // Prefer the actual messages workers sent (these contain the real analysis
    // with tickers, allocations, etc.) over the generic last-response summary.
    const workers = this.agents.filter((a) => a.role === 'worker' || a.role === 'custom')
    const agentNames = new Set([...this.agents.map((a) => a.name.toLowerCase()), 'user', 'system'])
    const workerSections: string[] = []
    for (const w of workers) {
      const sent = this.sentContent.get(w.id) ?? []
      // Use sent messages — they contain the detailed work product
      if (sent.length > 0) {
        const unique = [...new Set(sent)]
          .map((s) => this.stripAgentPrefixes(s, agentNames))
          .filter((s) => s.length > 20)
        if (unique.length > 0) {
          workerSections.push(`### ${w.name}\n\n${unique.join('\n\n')}`)
          continue
        }
      }
      // Fallback: parse last assistant response
      const hist = this.histories.get(w.id) ?? []
      const lastReply = [...hist].reverse().find((m) => m.role === 'assistant')
      if (!lastReply) continue
      const workerParsed = this.parseResponse(lastReply.content)
      const content = workerParsed.result?.trim() || workerParsed.analysis?.trim()
      if (content && content.length > 20) {
        workerSections.push(`### ${w.name}\n\n${this.stripAgentPrefixes(content, agentNames)}`)
      }
    }
    if (workerSections.length > 0) {
      sections.push(`## Detailed Analysis\n\n${workerSections.join('\n\n---\n\n')}`)
    }

    return sections.join('\n\n---\n\n')
  }

  /** Strip redundant [Agent Name]: prefixes that models echo back in their output. */
  private stripAgentPrefixes(text: string, agentNames: Set<string>): string {
    // Remove all "[Agent Name]:" or "[From Agent Name]:" prefixes throughout the text
    return text.replace(/\[(?:From\s+)?([^\]]+)\]\s*:\s*/gi, (match, name) => {
      return agentNames.has(name.toLowerCase().trim()) ? '' : match
    }).trim()
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
    // Normalize input: trim whitespace, control chars, quotes models sometimes add
    const cleaned = nameOrId.trim().replace(/^["']+|["']+$/g, '').trim()
    const key = cleaned.toLowerCase().replace(/[\s_-]+/g, '')
    const agents = Array.from(this.configs.values())

    // Exact ID match (try both raw and cleaned)
    const byId = this.configs.get(nameOrId) ?? this.configs.get(cleaned)
    if (byId) return byId

    // Exact name match (case-insensitive, trimmed)
    const byName = agents.find((a) => a.name.toLowerCase().trim() === cleaned.toLowerCase())
    if (byName) return byName

    // Fuzzy: normalized substring match on id or name
    const bySubstring = agents.find((a) => {
      const normId = a.id.toLowerCase().replace(/[\s_-]+/g, '')
      const normName = a.name.toLowerCase().replace(/[\s_-]+/g, '')
      return normId.includes(key) || key.includes(normId) ||
             normName.includes(key) || key.includes(normName)
    })
    if (bySubstring) return bySubstring

    // Word-overlap scoring — handles hallucinated names like "social_work" matching "social_worker"
    const inputWords = new Set(nameOrId.toLowerCase().split(/[\s_-]+/).filter(Boolean))
    let bestMatch: AgentConfig | undefined
    let bestScore = 0
    for (const a of agents) {
      const idWords = a.id.toLowerCase().split(/[\s_-]+/)
      const nameWords = a.name.toLowerCase().split(/[\s_-]+/)
      const candidateWords = new Set([...idWords, ...nameWords])
      let overlap = 0
      for (const w of inputWords) {
        for (const cw of candidateWords) {
          if (cw.includes(w) || w.includes(cw)) { overlap++; break }
        }
      }
      const score = overlap / Math.max(inputWords.size, 1)
      if (score > bestScore && score >= 0.5) {
        bestScore = score
        bestMatch = a
      }
    }
    return bestMatch
  }
}
