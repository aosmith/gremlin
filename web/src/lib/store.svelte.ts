import { defaultAgents, agentsForMode, BUILTIN_MODES } from './types'
import type { AgentConfig, AgentState, AppMode, CustomMode, Message, ModeInfo, Settings } from './types'
import { DEFAULT_SETTINGS } from './types'
import { AgentRunner } from './agentRunner'
import { unloadOllamaModels } from './api'
import { projectFS } from './filesystem'
import { DEV_TOOLS } from './tools'
import { isWebGPUAvailable, getLoadedModel } from './webllm'
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

function loadSettings(): Settings  { return ls('gremlin_settings', DEFAULT_SETTINGS) }
function saveSettings(s: Settings) { lsSet('gremlin_settings', s) }

function loadMode(): AppMode  { return ls<AppMode>('gremlin_mode', 'general') }
function saveMode(m: AppMode) { lsSet('gremlin_mode', m) }

// ── Builtin preset versioning ────────────────────────────────────────────────
// Bump this whenever builtin mode agents are updated. On load, any builtin mode
// whose cached agents are from an older version gets reset to the new preset.
const BUILTIN_AGENTS_VERSION = 2
const VERSION_KEY = 'gremlin_builtin_agents_version'

function migrateBuiltinAgents() {
  const stored = ls(VERSION_KEY, 0)
  if (stored >= BUILTIN_AGENTS_VERSION) return
  for (const mode of BUILTIN_MODES) {
    lsDel(`gremlin_agents_${mode.id}`)
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
const MAX_HISTORY = 50

function loadPersistedTask(): string    { return ls(TASK_KEY, '') }
function savePersistedTask(t: string)   { lsSet(TASK_KEY, t) }
function loadTaskHistory(): string[]    { return ls(HISTORY_KEY, []) }
function pushTaskHistory(t: string) {
  const trimmed = t.trim()
  if (!trimmed) return
  const h = loadTaskHistory().filter((x) => x !== trimmed)
  lsSet(HISTORY_KEY, [trimmed, ...h].slice(0, MAX_HISTORY))
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
const MAX_SESSION_HISTORY  = 25
const ARCHIVED_MSG_LIMIT   = 200
const ARCHIVED_LOG_LIMIT   = 100

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

// ── Output cleaning ──────────────────────────────────────────────────────────
// LLMs return JSON with literal newlines in strings — fix them so JSON.parse works
function fixJsonNewlines(text: string): string {
  let out = ''
  let inStr = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (ch === '\\') { out += ch + (text[i + 1] ?? ''); i++; continue }
      if (ch === '"') { inStr = false; out += ch; continue }
      if (ch === '\n') { out += '\\n'; continue }
      if (ch === '\r') { out += '\\r'; continue }
      out += ch
    } else {
      if (ch === '"') inStr = true
      out += ch
    }
  }
  return out
}

/** If text looks like agent JSON, extract the human-readable result/analysis. */
function cleanOutput(raw: string): string {
  if (!raw) return raw
  const trimmed = raw.trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start === -1 || end <= start) return raw
  try {
    const obj = JSON.parse(fixJsonNewlines(trimmed.slice(start, end + 1)))
    if (typeof obj.result === 'string' && obj.result.trim()) return obj.result.trim()
    if (typeof obj.analysis === 'string' && obj.analysis.trim()) return obj.analysis.trim()
    const strings = Object.values(obj).filter((v): v is string => typeof v === 'string' && v.length > 20)
    if (strings.length > 0) return strings.join('\n\n')
  } catch { /* not parseable, return as-is */ }
  return raw
}

// ── Limits ───────────────────────────────────────────────────────────────────

const MAX_MESSAGES = 2000
const MAX_LOGS     = 500

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
  output       = $state<string>(cleanOutput(this._session.output))
  task         = $state<string>(loadPersistedTask())
  taskHistory  = $state<string[]>(loadTaskHistory())

  isRunning    = $state<boolean>(false)   // never true after a refresh
  wasmReady    = $state<boolean>(false)
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

  private runner: AgentRunner | null = null
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
      messages: this.messages.slice(-ARCHIVED_MSG_LIMIT),
      logs: this.logs.slice(-ARCHIVED_LOG_LIMIT),
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

    // Re-init WASM coordinator so follow-ups / re-runs work
    if (this.wasmReady) {
      coord.clearSession()
      for (const cfg of this.agentConfigs) coord.addAgent(cfg)
    }
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

  /** Initialize WASM coordinator from restored session state (page load). */
  initSession() {
    coord.clearSession()
    for (const cfg of this.agentConfigs) coord.addAgent(cfg)
    // If we have a restored session, sync agent states but keep messages/logs/output intact
    if (this.messages.length > 0 || this.output) {
      this.agentStates = this.agentConfigs.map((cfg) => {
        const restored = this._session.agentStates.find((a) => a.id === cfg.id)
        return restored ?? { ...cfg, status: 'idle' as const, messageCount: 0, unreadCount: 0 }
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
    this.agentStates = this.agentConfigs.map((cfg) => ({
      ...cfg,
      status: 'idle',
      messageCount: 0,
      unreadCount: 0,
    }))
    if (this.wasmReady) coord.clearSession()
    clearPersistedSession()
  }

  // ── Private session mutation helpers (debounced save) ────────────────────
  private addMessage(msg: Message) {
    this.messages.push(msg)
    if (this.messages.length > MAX_MESSAGES) {
      this.messages = this.messages.slice(-MAX_MESSAGES)
    }
    this.saveSession()
  }

  private addLog(text: string) {
    this.logs.push(text)
    if (this.logs.length > MAX_LOGS) {
      this.logs = this.logs.slice(-MAX_LOGS)
    }
    this.saveSession()
  }

  private setOutput(output: string) {
    this.output = cleanOutput(output)
    this.saveSession()
  }

  private updateAgentState(agentId: string, patch: Partial<AgentState>) {
    const idx = this.agentStates.findIndex((a) => a.id === agentId)
    if (idx !== -1) {
      this.agentStates[idx] = { ...this.agentStates[idx], ...patch }
    }
    this.saveSession()
  }

  /** Called from the UI on every task input change to keep localStorage in sync. */
  saveTask() {
    savePersistedTask(this.task)
  }

  async startRun() {
    if (this.isRunning || !this.task.trim()) return
    if (!this.wasmReady) {
      this.addLog('⚠ WASM coordinator not ready yet')
      return
    }

    this.archiveCurrentSession()
    pushTaskHistory(this.task)
    this.taskHistory = loadTaskHistory()
    this.clearSession()

    this.isRunning       = true
    this.webllmProgress  = null
    this.runner          = new AgentRunner()

    const tools = (this.appMode === 'engineering' && projectFS.isOpen) ? DEV_TOOLS : []

    try {
      await this.runner.run(this.task, this.agentConfigs, this.settings, {
        onMessage: (msg) => {
          this.addMessage(msg)
          this.syncAgentStates()
        },
        onStatusUpdate: (agentId, status) => {
          this.updateAgentState(agentId, { status })
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
        onProgress: (p) => {
          this.webllmProgress = p
        },
        onDone: () => {
          this.isRunning      = false
          this.webllmProgress = null
          this.syncAgentStates()
          this.flushSession()
          this.archiveCurrentSession()
          this.releaseModels()
        },
      }, tools)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.addLog(`✖ Fatal: ${msg}`)
      this.isRunning = false
      this.releaseModels()
    }
  }

  stopRun() {
    this.runner?.abort()
    this.runner = null
    this.isRunning = false
    coord.setRunning(false)
    // Reset all non-idle agents to idle
    for (let i = 0; i < this.agentStates.length; i++) {
      if (this.agentStates[i].status !== 'idle' && this.agentStates[i].status !== 'done') {
        this.agentStates[i] = { ...this.agentStates[i], status: 'idle' }
      }
    }
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

  retryAgent(agentId: string) {
    if (!this.runner) return
    this.isRunning = true
    this.updateAgentState(agentId, { status: 'waiting' })
    this.runner.retryAgent(agentId)
  }

  private syncAgentStates() {
    if (!this.wasmReady) return
    const wasmAgents = coord.getAgents()
    for (let i = 0; i < this.agentStates.length; i++) {
      const w = wasmAgents.find((wa) => wa.id === this.agentStates[i].id)
      if (w) {
        this.agentStates[i] = { ...this.agentStates[i], messageCount: w.messageCount, unreadCount: w.unreadCount }
      }
    }
  }
}

export const store = new GremlinStore()
