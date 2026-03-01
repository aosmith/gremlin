import { defaultAgents, agentsForMode, BUILTIN_MODES } from './types'
import type { AgentConfig, AgentState, AppMode, CustomMode, Message, ModeInfo, Settings } from './types'
import { DEFAULT_SETTINGS } from './types'
import { AgentRunner } from './agentRunner'
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
  wasmReady    = $state<boolean>(false)
  currentRound = $state<number>(0)

  // ── WebLLM ────────────────────────────────────────────────────────────────
  webllmProgress  = $state<WebLLMProgress | null>(null)
  webllmReady     = $derived(this.settings.apiFormat === 'webllm' && getLoadedModel() === this.settings.model)
  webgpuAvailable = isWebGPUAvailable()

  // ── Filesystem / dev mode ────────────────────────────────────────────────
  projectDirName = $state<string | null>(null)
  writtenFiles   = $state<string[]>([])
  selectedFile   = $state<string | null>(null)

  // ── UI state ────────────────────────────────────────────────────────────
  selectedAgentId = $state<string | null>(null)
  showSettings    = $state<boolean>(false)
  showAgentEdit   = $state<string | null>(null)
  showModeCreate  = $state<boolean>(false)

  private runner: AgentRunner | null = null

  // ── Session save helper ───────────────────────────────────────────────────
  private saveSession() {
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

  // ── Session ───────────────────────────────────────────────────────────────
  clearSession() {
    this.messages    = []
    this.logs        = []
    this.output      = ''
    this.currentRound = 0
    this.agentStates = this.agentConfigs.map((cfg) => ({
      ...cfg,
      status: 'idle',
      messageCount: 0,
      unreadCount: 0,
    }))
    if (this.wasmReady) coord.clearSession()
    clearPersistedSession()
  }

  // ── Private session mutation helpers (each saves to localStorage) ─────────
  private addMessage(msg: Message) {
    this.messages = [...this.messages, msg]
    this.saveSession()
  }

  private addLog(text: string) {
    this.logs = [...this.logs, text]
    this.saveSession()
  }

  private setOutput(output: string) {
    this.output = output
    this.saveSession()
  }

  private updateAgentState(agentId: string, patch: Partial<AgentState>) {
    this.agentStates = this.agentStates.map((a) =>
      a.id === agentId ? { ...a, ...patch } : a,
    )
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
          this.saveSession()
        },
      }, tools)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.addLog(`✖ Fatal: ${msg}`)
      this.isRunning = false
    }
  }

  stopRun() {
    this.runner?.abort()
    this.isRunning = false
    coord.setRunning(false)
    this.saveSession()
  }

  injectHumanMessage(agentId: string, content: string) {
    this.runner?.injectHumanMessage(agentId, content, this.currentRound)
  }

  private syncAgentStates() {
    if (!this.wasmReady) return
    const wasmAgents = coord.getAgents()
    this.agentStates = this.agentStates.map((a) => {
      const w = wasmAgents.find((wa) => wa.id === a.id)
      return w ? { ...a, messageCount: w.messageCount, unreadCount: w.unreadCount } : a
    })
  }
}

export const store = new GremlinStore()
