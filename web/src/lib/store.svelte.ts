import { defaultAgents, agentsForMode, BUILTIN_MODES } from './types'
import type { AgentConfig, AgentState, AppMode, Attachment, CustomMode, Message, ModeInfo, Settings } from './types'
import { DEFAULT_SETTINGS } from './types'
import { AgentRunner } from './agentRunner'
import type { RunnerCallbacks } from './agentRunner'
import { unloadOllamaModels } from './api'
import { projectFS } from './filesystem'
import { DEV_TOOLS, SEARCH_TOOLS } from './tools'
import { isWebGPUAvailable } from './webllm'
import type { WebLLMProgress } from './webllm'
import * as coord from './coordinator'

// ── Persistence helpers ───────────────────────────────────────────────────────

function ls<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (raw != null) return JSON.parse(raw) as T
  } catch { /* ignore */ }
  return fallback
}

function lsSet(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* ignore */ }
}

function lsDel(key: string) {
  try { localStorage.removeItem(key) } catch { /* ignore */ }
}

function loadSettings(): Settings  {
  const s = { ...DEFAULT_SETTINGS, ...ls('gremlin_settings', DEFAULT_SETTINGS) }
  // Migrate: empty proxyUrl → built-in dev proxy
  if (!s.proxyUrl) s.proxyUrl = DEFAULT_SETTINGS.proxyUrl
  return s
}
function saveSettings(s: Settings) { lsSet('gremlin_settings', s) }

function loadMode(): AppMode  { return ls<AppMode>('gremlin_mode', 'general') }
function saveMode(m: AppMode) { lsSet('gremlin_mode', m) }

// ── Builtin preset versioning ────────────────────────────────────────────────
// Bump this whenever builtin mode agents are updated. On load, new agents that
// don't exist in the user's saved config are merged in — but user edits are preserved.
const BUILTIN_AGENTS_VERSION = 9
const VERSION_KEY = 'gremlin_builtin_agents_version'

function migrateBuiltinAgents() {
  const stored = ls(VERSION_KEY, 0)
  if (stored >= BUILTIN_AGENTS_VERSION) return

  for (const mode of BUILTIN_MODES) {
    const key = `gremlin_agents_${mode.id}`
    const saved: AgentConfig[] | null = ls(key, null as any)
    if (!saved) continue  // no saved config — will use defaults naturally

    const defaults = agentsForMode(mode.id)
    const defaultMap = new Map(defaults.map((a) => [a.id, a]))
    const savedIds = new Set(saved.map((a) => a.id))

    // Update systemPrompt for existing agents from code defaults
    let changed = false
    for (const agent of saved) {
      const def = defaultMap.get(agent.id)
      if (def && agent.systemPrompt !== def.systemPrompt) {
        agent.systemPrompt = def.systemPrompt
        changed = true
      }
    }

    // Add any new agents from defaults that the user doesn't already have
    for (const defaultAgent of defaults) {
      if (!savedIds.has(defaultAgent.id)) {
        saved.push(defaultAgent)
        changed = true
      }
    }
    if (changed) lsSet(key, saved)
  }

  lsSet(VERSION_KEY, BUILTIN_AGENTS_VERSION)
}

// Run migration on module load — before any agent configs are read
migrateBuiltinAgents()

function loadAgentsForMode(mode: AppMode, customModes: CustomMode[]): AgentConfig[] {
  return ls(`gremlin_agents_${mode}`, agentsForMode(mode, customModes))
}
function saveAgentsForMode(mode: AppMode, agents: AgentConfig[]) {
  lsSet(`gremlin_agents_${mode}`, agents)
}

function loadCustomModes(): CustomMode[]       { return ls('gremlin_custom_modes', []) }
function saveCustomModes(modes: CustomMode[])  { lsSet('gremlin_custom_modes', modes) }

// ── Session persistence ───────────────────────────────────────────────────────

// Task is stored separately so clearSession() can never accidentally wipe it
const TASK_KEY    = 'gremlin_task'
const SESSION_KEY = 'gremlin_session'
const HISTORY_KEY = 'gremlin_task_history'

function loadPersistedTask(): string    { return ls(TASK_KEY, '') }
function savePersistedTask(t: string)   { lsSet(TASK_KEY, t) }
function loadTaskHistory(): string[]    { return ls(HISTORY_KEY, []) }
function pushTaskHistory(t: string) {
  const trimmed = t.trim()
  if (!trimmed) return
  const h = loadTaskHistory().filter((x) => x !== trimmed)
  lsSet(HISTORY_KEY, [trimmed, ...h])
}

interface PersistedSession {
  messages: Message[]
  logs: string[]
  output: string
  agentStates: AgentState[]
}

function loadPersistedSession(): PersistedSession | null {
  return ls<PersistedSession | null>(SESSION_KEY, null)
}

function persistSession(s: PersistedSession) {
  lsSet(SESSION_KEY, s)
}

function clearPersistedSession() {
  lsDel(SESSION_KEY)
}

// ── Session history persistence ──────────────────────────────────────────────

const SESSION_HISTORY_KEY  = 'gremlin_session_history'
const MAX_SESSION_HISTORY  = 1_000

export interface SessionHistoryEntry {
  id: string
  task: string
  mode: AppMode
  modeIcon: string
  modeName: string
  timestamp: number
  messageCount: number
  hasOutput: boolean
}

export interface ArchivedSession {
  task: string
  mode: AppMode
  modeName: string
  modeIcon: string
  timestamp: number
  messages: Message[]
  logs: string[]
  output: string
  agentStates: AgentState[]
}

function loadSessionHistory(): SessionHistoryEntry[] {
  return ls(SESSION_HISTORY_KEY, [])
}

function saveSessionHistory(entries: SessionHistoryEntry[]) {
  lsSet(SESSION_HISTORY_KEY, entries)
}

function loadArchivedSession(id: string): ArchivedSession | null {
  return ls<ArchivedSession | null>(`gremlin_session_${id}`, null)
}

function saveArchivedSession(id: string, session: ArchivedSession) {
  lsSet(`gremlin_session_${id}`, session)
}

function deleteArchivedSession(id: string) {
  lsDel(`gremlin_session_${id}`)
}

// ── Store ─────────────────────────────────────────────────────────────────────

class GremlinStore {
  // ── Persistent config ──────────────────────────────────────────────────────
  settings     = $state<Settings>(loadSettings())
  appMode      = $state<AppMode>(loadMode())
  customModes  = $state<CustomMode[]>(loadCustomModes())
  agentConfigs = $state<AgentConfig[]>(loadAgentsForMode(loadMode(), loadCustomModes()))

  // ── Session state (restored from localStorage on load) ────────────────────
  private _session: PersistedSession = loadPersistedSession() ?? {
    messages: [],
    logs: [],
    output: '',
    agentStates: [],
  }

  agentStates  = $state<AgentState[]>(this._session.agentStates)
  messages     = $state<Message[]>(this._session.messages)
  logs         = $state<string[]>(this._session.logs)
  output       = $state<string>(this._session.output)
  task         = $state<string>(loadPersistedTask())
  taskHistory  = $state<string[]>(loadTaskHistory())

  isRunning    = $state<boolean>(false)   // never true after a refresh
  currentRound = $state<number>(0)

  // ── WebLLM ────────────────────────────────────────────────────────────────
  webllmProgress  = $state<WebLLMProgress | null>(null)
  webgpuAvailable = isWebGPUAvailable()

  // ── Filesystem / dev mode ────────────────────────────────────────────────
  projectDirName = $state<string | null>(null)
  writtenFiles   = $state<string[]>([])
  selectedFile   = $state<string | null>(null)

  // ── Session history ──────────────────────────────────────────────────────
  sessionHistory     = $state<SessionHistoryEntry[]>(loadSessionHistory())
  restoredSessionId  = $state<string | null>(null)
  private _archived  = false

  // ── UI state ────────────────────────────────────────────────────────────
  selectedAgentId = $state<string | null>(null)
  showSettings    = $state<boolean>(false)
  showAgentEdit   = $state<string | null>(null)
  showModeCreate  = $state<boolean>(false)

  // ── Attachments (images, etc.) ──────────────────────────────────────────
  attachments = $state<Attachment[]>([])

  // ── Streaming ──────────────────────────────────────────────────────────
  streamingAgentId = $state<string | null>(null)
  streamingText = $state<string>('')

  /** Pending suggestion when an agent hallucinates an unknown agent name. */
  pendingAgentSuggestion = $state<{ name: string, resolve: (created: boolean) => void } | null>(null)

  /** Pending prompt when agent calls web_search but no provider is configured. */
  pendingSearchSetup = $state<{ resolve: (configured: boolean) => void } | null>(null)

  /** Pending prompt when round limit is exhausted. */
  pendingRoundsExhausted = $state<{
    currentRound: number
    maxRounds: number
    resolve: (result: { extraRounds: number; instruction: string } | null) => void
  } | null>(null)

  runner: AgentRunner | null = null
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  // ── Session save helper (debounced — one write per second max) ─────────
  private saveSession() {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      persistSession({
        messages:    this.messages,
        logs:        this.logs,
        output:      this.output,
        agentStates: this.agentStates,
      })
    }, 1_000)
  }

  /** Flush any pending debounced save immediately. */
  private flushSession() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    persistSession({
      messages:    this.messages,
      logs:        this.logs,
      output:      this.output,
      agentStates: this.agentStates,
    })
  }

  // ── Mode helpers ──────────────────────────────────────────────────────────

  get allModes(): ModeInfo[] {
    return [...BUILTIN_MODES, ...this.customModes]
  }

  get currentModeInfo(): ModeInfo {
    return this.allModes.find((m) => m.id === this.appMode) ?? BUILTIN_MODES[0]
  }

  switchMode(mode: AppMode) {
    if (mode === this.appMode || this.isRunning) return
    saveAgentsForMode(this.appMode, this.agentConfigs)
    this.appMode = mode
    saveMode(mode)
    this.agentConfigs = loadAgentsForMode(mode, this.customModes)
    this.clearSession()
  }

  createMode(name: string, icon: string, description: string) {
    const id = `custom_${Date.now()}`
    const newMode: CustomMode = {
      id,
      name,
      icon: icon || '★',
      description: description || 'Custom mode',
      builtin: false,
      agents: [...this.agentConfigs],
    }
    this.customModes = [...this.customModes, newMode]
    saveCustomModes(this.customModes)
    saveAgentsForMode(this.appMode, this.agentConfigs)
    this.appMode = id
    saveMode(id)
    this.agentConfigs = [...newMode.agents]
    this.clearSession()
  }

  createModeWithAgents(name: string, icon: string, description: string, agents: AgentConfig[]) {
    const id = `custom_${Date.now()}`
    const newMode: CustomMode = { id, name, icon: icon || '★', description: description || 'Custom mode', builtin: false, agents: [...agents] }
    this.customModes = [...this.customModes, newMode]
    saveCustomModes(this.customModes)
    saveAgentsForMode(this.appMode, this.agentConfigs)
    this.appMode = id
    saveMode(id)
    this.agentConfigs = [...agents]
    saveAgentsForMode(id, agents)
    this.clearSession()
  }

  deleteCustomMode(id: string) {
    this.customModes = this.customModes.filter((m) => m.id !== id)
    saveCustomModes(this.customModes)
    if (this.appMode === id) {
      this.appMode = 'general'
      saveMode('general')
      this.agentConfigs = loadAgentsForMode('general', this.customModes)
      this.clearSession()
    }
    lsDel(`gremlin_agents_${id}`)
  }

  // ── Settings helpers ──────────────────────────────────────────────────────
  updateSettings(patch: Partial<Settings>) {
    this.settings = { ...this.settings, ...patch }
    saveSettings(this.settings)
  }

  // ── Agent config helpers ──────────────────────────────────────────────────
  upsertAgent(cfg: AgentConfig) {
    const idx = this.agentConfigs.findIndex((a) => a.id === cfg.id)
    this.agentConfigs = idx === -1
      ? [...this.agentConfigs, cfg]
      : this.agentConfigs.map((a) => (a.id === cfg.id ? cfg : a))
    saveAgentsForMode(this.appMode, this.agentConfigs)
  }

  removeAgent(id: string) {
    this.agentConfigs = this.agentConfigs.filter((a) => a.id !== id)
    saveAgentsForMode(this.appMode, this.agentConfigs)
  }

  resetAgents() {
    this.agentConfigs = agentsForMode(this.appMode, this.customModes)
    saveAgentsForMode(this.appMode, this.agentConfigs)
  }

  /** User chose to create the hallucinated agent — open AgentEditModal pre-filled with the first name. */
  acceptAgentSuggestion() {
    if (!this.pendingAgentSuggestion) return
    const firstName = this.pendingAgentSuggestion.name.split(', ')[0]
    this.showAgentEdit = `__new__:${firstName}`
    // resolve is called from AgentEditModal on save/close
  }

  /** User chose to skip — continue the run with orchestrator reroute. */
  dismissAgentSuggestion() {
    if (!this.pendingAgentSuggestion) return
    this.pendingAgentSuggestion.resolve(false)
    this.pendingAgentSuggestion = null
  }

  /** User configured a search provider from the mid-run modal. */
  resolveSearchSetup() {
    if (!this.pendingSearchSetup) return
    this.pendingSearchSetup.resolve(true)
    this.pendingSearchSetup = null
  }

  /** User skipped search setup. */
  cancelSearchSetup() {
    if (!this.pendingSearchSetup) return
    this.pendingSearchSetup.resolve(false)
    this.pendingSearchSetup = null
  }

  /** User chose to continue with more rounds. */
  continueWithRounds(extraRounds: number, instruction: string) {
    if (!this.pendingRoundsExhausted) return
    this.pendingRoundsExhausted.resolve({ extraRounds, instruction })
    this.pendingRoundsExhausted = null
  }

  /** User chose to synthesize immediately. */
  synthesizeNow() {
    if (!this.pendingRoundsExhausted) return
    this.pendingRoundsExhausted.resolve(null)
    this.pendingRoundsExhausted = null
  }

  // ── Filesystem ────────────────────────────────────────────────────────────
  async openProjectFolder() {
    try {
      const name = await projectFS.open()
      this.projectDirName = name
      this.writtenFiles = await projectFS.getAllFilePaths()
      this.selectedFile = null
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return
      this.addLog(`✖ Failed to open folder: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  closeProjectFolder() {
    projectFS.close()
    this.projectDirName = null
    this.writtenFiles = []
    this.selectedFile = null
  }

  async refreshFiles() {
    if (!projectFS.isOpen) return
    this.writtenFiles = await projectFS.getAllFilePaths()
  }

  // ── Session history ──────────────────────────────────────────────────────

  private archiveCurrentSession() {
    if (this._archived) return
    if (this.messages.length === 0 && !this.output) return
    this._archived = true

    const modeInfo = this.currentModeInfo
    const now = Date.now()

    const sessionData: ArchivedSession = {
      task: this.task,
      mode: this.appMode,
      modeName: modeInfo.name,
      modeIcon: modeInfo.icon,
      timestamp: now,
      messages: [...this.messages],
      logs: [...this.logs],
      output: this.output,
      agentStates: this.agentStates.map((a) => ({ ...a, status: 'idle' as const })),
    }

    // If viewing a restored session, update it in-place instead of duplicating
    if (this.restoredSessionId) {
      const idx = this.sessionHistory.findIndex((e) => e.id === this.restoredSessionId)
      if (idx !== -1) {
        this.sessionHistory[idx] = {
          ...this.sessionHistory[idx],
          timestamp: now,
          messageCount: this.messages.length,
          hasOutput: !!this.output,
        }
        // Move to top of list
        const updated = this.sessionHistory.splice(idx, 1)[0]
        this.sessionHistory = [updated, ...this.sessionHistory]
        saveSessionHistory(this.sessionHistory)
        saveArchivedSession(this.restoredSessionId, sessionData)
        return
      }
    }

    // New session — create a fresh entry
    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

    const entry: SessionHistoryEntry = {
      id,
      task: this.task,
      mode: this.appMode,
      modeIcon: modeInfo.icon,
      modeName: modeInfo.name,
      timestamp: now,
      messageCount: this.messages.length,
      hasOutput: !!this.output,
    }

    let history = [entry, ...this.sessionHistory]
    if (history.length > MAX_SESSION_HISTORY) {
      const evicted = history.splice(MAX_SESSION_HISTORY)
      for (const e of evicted) deleteArchivedSession(e.id)
    }

    this.sessionHistory = history
    saveSessionHistory(history)
    saveArchivedSession(id, sessionData)
  }

  restoreSession(id: string) {
    if (this.isRunning) return
    const archived = loadArchivedSession(id)
    if (!archived) return

    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null }

    this.restoredSessionId = id
    this._archived   = false
    this.task        = archived.task
    this.messages    = archived.messages
    this.logs        = archived.logs
    this.output      = archived.output
    // Restore agent states but reset status to idle (no run is active)
    this.agentStates = archived.agentStates.length > 0
      ? archived.agentStates.map((a) => ({ ...a, status: 'idle' as const }))
      : this.agentConfigs.map((cfg) => ({ ...cfg, status: 'idle' as const, messageCount: 0, unreadCount: 0 }))

    // Persist so the session survives page reload
    savePersistedTask(this.task)
    persistSession({
      messages:    this.messages,
      logs:        this.logs,
      output:      this.output,
      agentStates: this.agentStates,
    })

    // Re-init coordinator so follow-ups / re-runs work
    coord.clearSession()
    for (const cfg of this.agentConfigs) coord.addAgent(cfg)
  }

  deleteHistoryEntry(id: string) {
    this.sessionHistory = this.sessionHistory.filter((e) => e.id !== id)
    saveSessionHistory(this.sessionHistory)
    deleteArchivedSession(id)
    if (this.restoredSessionId === id) {
      this.restoredSessionId = null
      this.clearSession()
    }
  }

  // ── Session ───────────────────────────────────────────────────────────────

  /** Initialize coordinator from restored session state (page load / HMR). */
  initSession() {
    // If the coordinator is mid-run (HMR during an active run), don't clear it —
    // the runner is still alive and updating coordinator state.
    // Instead, just sync the store from the coordinator's live state.
    if (coord.getRunning()) {
      this.isRunning = true
      this.syncAgentStates()
      return
    }

    coord.clearSession()
    for (const cfg of this.agentConfigs) coord.addAgent(cfg)
    // Restore from persisted session — clamp stale running/waiting → idle
    if (this.messages.length > 0 || this.output) {
      this.agentStates = this.agentConfigs.map((cfg) => {
        const restored = this._session.agentStates.find((a) => a.id === cfg.id)
        if (!restored) return { ...cfg, status: 'idle' as const, messageCount: 0, unreadCount: 0 }
        const status = restored.status === 'running' || restored.status === 'waiting' ? 'idle' as const : restored.status
        return { ...restored, status }
      })
    } else {
      this.agentStates = this.agentConfigs.map((cfg) => ({
        ...cfg,
        status: 'idle' as const,
        messageCount: 0,
        unreadCount: 0,
      }))
    }
  }

  clearSession() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null }
    this.messages    = []
    this.logs        = []
    this.output      = ''
    this.currentRound = 0
    this.restoredSessionId = null
    this._archived   = false
    this.attachments = []
    this.agentStates = this.agentConfigs.map((cfg) => ({
      ...cfg,
      status: 'idle',
      messageCount: 0,
      unreadCount: 0,
    }))
    coord.clearSession()
    clearPersistedSession()
  }

  // ── Private session mutation helpers (debounced save) ────────────────────
  private addMessage(msg: Message) {
    this.messages.push(msg)
    this.saveSession()
  }

  private addLog(text: string) {
    this.logs.push(text)
    this.saveSession()
  }

  private setOutput(output: string) {
    this.output = output
    this.saveSession()
  }

  /** Called from the UI on every task input change to keep localStorage in sync. */
  saveTask() {
    savePersistedTask(this.task)
  }

  addAttachment(file: File): Promise<void> {
    const MAX_SIZE = 5 * 1024 * 1024  // 5 MB
    const MAX_COUNT = 10
    if (this.attachments.length >= MAX_COUNT) return Promise.resolve()
    if (file.size > MAX_SIZE) return Promise.resolve()
    if (!file.type.startsWith('image/')) return Promise.resolve()

    return new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = reader.result as string
        const base64 = dataUrl.replace(/^data:[^;]+;base64,/, '')
        this.attachments = [...this.attachments, { mimeType: file.type, base64, name: file.name }]
        resolve()
      }
      reader.onerror = () => resolve()
      reader.readAsDataURL(file)
    })
  }

  removeAttachment(index: number) {
    this.attachments = this.attachments.filter((_, i) => i !== index)
  }

  async startRun() {
    if (this.isRunning || !this.task.trim()) return

    this.archiveCurrentSession()
    pushTaskHistory(this.task)
    this.taskHistory = loadTaskHistory()
    this.clearSession()

    this.isRunning       = true
    this.webllmProgress  = null
    this.runner          = new AgentRunner()

    const tools = [
      ...(this.appMode === 'engineering' && projectFS.isOpen ? DEV_TOOLS : []),
      ...(this.settings.searchProvider ? SEARCH_TOOLS : []),
    ]

    try {
      await this.runner.run(this.task, this.agentConfigs, this.settings, this.attachments, this.makeCallbacks(), tools)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.addLog(`✖ Fatal: ${msg}`)
      this.isRunning = false
      this.finalizeAgentStates()
      this.releaseModels()
    }
  }

  stopRun() {
    this.runner?.abort()
    this.runner = null
    this.isRunning = false
    this.streamingAgentId = null
    this.streamingText = ''
    coord.setRunning(false)
    // Sync from coordinator then force remaining active agents to idle
    this.syncAgentStates()
    this.agentStates = this.agentStates.map((a) =>
      a.status !== 'idle' && a.status !== 'done'
        ? { ...a, status: 'idle' as const }
        : a
    )
    this.flushSession()
    this.releaseModels()
  }

  /** Unload all Ollama models (global + per-agent overrides). Logs on failure. */
  private async releaseModels() {
    const err = await unloadOllamaModels(this.settings, this.agentConfigs)
    if (err) this.addLog(`⚠ ${err}`)
  }

  injectHumanMessage(agentId: string, content: string) {
    if (!this.runner) return
    this.isRunning = true
    this.runner.injectHumanMessage(agentId, content)
  }

  /** Start a follow-up run using the existing messages/context. */
  async followUp(text: string) {
    if (this.isRunning || !text.trim()) return

    // Keep existing messages/logs/output but reset agent states for a new run
    this._archived = false
    this.output = ''

    // Inject the follow-up as a user message to the orchestrator
    const orchestrator = this.agentConfigs.find((a) => a.role === 'orchestrator')
    if (!orchestrator) return

    const msg: Message = {
      id: `msg_${Date.now()}_followup`,
      fromAgent: 'user',
      toAgent: orchestrator.id,
      content: text,
      timestamp: Date.now(),
      type: 'human',
    }
    this.addMessage(msg)

    // Update task to reflect follow-up
    this.task = text
    savePersistedTask(this.task)

    // Reset agent states (full array reassign for Svelte 5 reactivity)
    this.agentStates = this.agentStates.map((a) => ({ ...a, status: 'idle' as const }))

    // Start a new run — the runner will see the existing coordinator history
    this.isRunning       = true
    this.webllmProgress  = null
    this.runner          = new AgentRunner()

    const tools = [
      ...(this.appMode === 'engineering' && projectFS.isOpen ? DEV_TOOLS : []),
      ...(this.settings.searchProvider ? SEARCH_TOOLS : []),
    ]

    try {
      await this.runner.run(this.task, this.agentConfigs, this.settings, this.attachments, this.makeCallbacks(), tools)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.addLog(`✖ Fatal: ${msg}`)
      this.isRunning = false
      this.finalizeAgentStates()
      this.releaseModels()
    }
  }

  retryAgent(agentId: string) {
    if (!this.runner) return
    this.isRunning = true
    // retryAgent sets coordinator status to 'waiting' internally, then syncAgentStates pulls it
    this.runner.retryAgent(agentId)
    this.syncAgentStates()
  }

  private makeCallbacks(): RunnerCallbacks {
    return {
      onMessage: (msg) => {
        this.addMessage(msg)
        this.syncAgentStates()
      },
      onStatusUpdate: () => {
        this.syncAgentStates()
        this.saveSession()
      },
      onRound: (round) => {
        this.currentRound = round
      },
      onLog: (text) => {
        this.addLog(text)
      },
      onOutput: (output) => {
        this.setOutput(output)
      },
      onToolCall: (e) => {
        if (e.record.name === 'write_file' && !e.record.isError) {
          const path = e.record.args.path as string
          if (path && !this.writtenFiles.includes(path)) {
            this.writtenFiles = [...this.writtenFiles, path].sort()
          }
        }
      },
      onUnknownAgent: (_fromAgent, name) => {
        return new Promise<boolean>((resolve) => {
          this.pendingAgentSuggestion = { name, resolve }
        })
      },
      onSearchNotConfigured: () => {
        return new Promise<boolean>((resolve) => {
          this.pendingSearchSetup = { resolve }
        })
      },
      onRoundsExhausted: (currentRound, maxRounds) => {
        return new Promise((resolve) => {
          this.pendingRoundsExhausted = { currentRound, maxRounds, resolve }
        })
      },
      onStream: (agentId, _delta, accumulated) => {
        if (agentId === null) {
          this.streamingAgentId = null
          this.streamingText = ''
        } else {
          this.streamingAgentId = agentId
          this.streamingText = accumulated
        }
      },
      onProgress: (p) => {
        this.webllmProgress = p
      },
      onDone: () => {
        this.isRunning      = false
        this.webllmProgress = null
        this.streamingAgentId = null
        this.streamingText    = ''
        this.syncAgentStates()
        this.finalizeAgentStates()
        this.flushSession()
        this.archiveCurrentSession()
        this.releaseModels()
      },
    }
  }

  private syncAgentStates() {
    const coordAgents = coord.getAgents()
    this.agentStates = this.agentStates.map((a) => {
      const ca = coordAgents.find((c) => c.id === a.id)
      if (!ca) return a
      // Coordinator is the single source of truth for status, messageCount, unreadCount.
      // This avoids dual-update races between onStatusUpdate and onMessage callbacks.
      return { ...a, status: ca.status, messageCount: ca.messageCount, unreadCount: ca.unreadCount }
    })
  }

  /** Reset all non-done, non-error agents to 'done' when a run finishes. Reassigns the full array for reactivity. */
  private finalizeAgentStates() {
    this.agentStates = this.agentStates.map((a) => {
      if (a.status === 'running' || a.status === 'waiting' || a.status === 'idle') {
        return { ...a, status: 'done' as const }
      }
      return a
    })
  }
}

export const store = new GremlinStore()
