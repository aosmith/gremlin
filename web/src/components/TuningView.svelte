<script lang="ts">
  import { store } from '../lib/store.svelte'
  import { detectHardware, detectOllamaModels, isOllamaRunning, computeRecommendation, computeAIRecommendation, classifyAgentRole, suggestModelsForHardware } from '../lib/autotune'
  import type { HardwareProfile, InstalledModel, TuneRecommendation, AIRecommendation, SuggestedModel } from '../lib/autotune'
  import { pullOllamaModel } from '../lib/api'
  import { agentsForMode, BUILTIN_MODES, LOCAL_ROUTER_MODEL } from '../lib/types'
  import type { AgentConfig } from '../lib/types'
  import { isWebGPUAvailable } from '../lib/webllm'

  // ── Types ───────────────────────────────────────────────────────────────────
  interface AgentAssignment {
    id: string
    name: string
    role: string
    roleClass: string
    defaultModel: string
    recommendedModel: string
    changed: boolean
  }
  interface ModeAssignment {
    modeId: string
    modeName: string
    agents: AgentAssignment[]
    changeCount: number
  }

  // ── State ──────────────────────────────────────────────────────────────────
  let phase = $state<'detecting' | 'ai-analyzing' | 'ready' | 'applying'>('detecting')
  let hardware = $state<HardwareProfile | null>(null)
  let ollamaUp = $state(false)
  let models = $state<InstalledModel[]>([])
  let recommendation = $state<TuneRecommendation | null>(null)
  let aiRecommendation = $state<AIRecommendation | null>(null)
  let suggested = $state<SuggestedModel[]>([])
  let pullingModel = $state<string | null>(null)
  let pullProgress = $state('')
  let error = $state('')
  let aiStatus = $state('')
  let aiProgress = $state(0)
  let aiProgressText = $state('')
  let useAI = $state(true)
  /** Per-mode assignments computed for display — scored path fills this too */
  let modeAssignments = $state<ModeAssignment[]>([])
  let expandedMode = $state<string | null>(null)

  const usableVRAM = $derived(hardware ? Math.round(hardware.gpuMemoryGB * 0.75 * 10) / 10 : 0)
  const activeRec = $derived(aiRecommendation ?? recommendation)
  const totalChanges = $derived(modeAssignments.reduce((sum, m) => sum + m.changeCount, 0))

  /** Build per-agent assignment table for all modes */
  function buildModeAssignments(
    hw: HardwareProfile,
    installedModels: InstalledModel[],
    aiRec: AIRecommendation | null,
  ): ModeAssignment[] {
    const result: ModeAssignment[] = []
    for (const mode of BUILTIN_MODES) {
      if (mode.id === 'tuning') continue
      const agents = agentsForMode(mode.id)
      if (agents.length === 0) continue

      // Get recommended assignments for this mode
      let recMap: Record<string, string>
      if (aiRec?.modeAssignments?.[mode.id]) {
        recMap = aiRec.modeAssignments[mode.id]
      } else if (installedModels.length > 0) {
        const modeRec = computeRecommendation(hw, installedModels, agents)
        recMap = modeRec.assignments
      } else {
        recMap = {}
      }

      const agentAssigns: AgentAssignment[] = agents.map(a => {
        const defaultModel = a.model || store.settings.model || ''
        const recommended = recMap[a.id] || defaultModel
        return {
          id: a.id,
          name: a.name,
          role: a.role,
          roleClass: classifyAgentRole(a),
          defaultModel,
          recommendedModel: recommended,
          changed: recommended !== defaultModel,
        }
      })

      result.push({
        modeId: mode.id,
        modeName: mode.name,
        agents: agentAssigns,
        changeCount: agentAssigns.filter(a => a.changed).length,
      })
    }
    return result
  }

  // ── Run detection on mount ──────────────────────────────────────────────────
  async function detect() {
    phase = 'detecting'
    error = ''
    aiRecommendation = null
    modeAssignments = []
    try {
      hardware = await detectHardware()
      const endpoint = store.settings.apiEndpoint || 'http://localhost:11434/v1/chat/completions'
      ollamaUp = await isOllamaRunning(endpoint)
      if (ollamaUp) {
        models = await detectOllamaModels(endpoint)
      }
      // Compute scored recommendation as baseline/fallback
      const agents = agentsForMode('general')
      if (models.length > 0 && agents.length > 0) {
        recommendation = computeRecommendation(hardware, models, agents)
      }
      suggested = suggestModelsForHardware(hardware, models)

      // Try AI-powered recommendation if WebGPU available and models/providers exist
      const cloudProviders = store.settings.llmProviders.filter(p => p.model && p.endpoint)
      const hasModelsOrCloud = models.length > 0 || cloudProviders.length > 0
      if (useAI && isWebGPUAvailable() && hasModelsOrCloud) {
        phase = 'ai-analyzing'
        aiStatus = 'Loading AI model...'
        aiProgress = 0
        try {
          const result = await computeAIRecommendation(
            hardware,
            models,
            cloudProviders,
            LOCAL_ROUTER_MODEL,
            (p) => { aiProgress = p.progress; aiProgressText = p.text },
            (status) => { aiStatus = status },
          )
          if (result) {
            aiRecommendation = result
          }
        } catch (e) {
          console.warn('[tuning] AI recommendation failed:', e)
        }
      }

      // Build per-agent assignment table for ALL modes
      if (hardware && (models.length > 0 || aiRecommendation)) {
        modeAssignments = buildModeAssignments(hardware, models, aiRecommendation)
      }

      phase = 'ready'
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
      phase = 'ready'
    }
  }
  detect()

  // ── Pull a model ────────────────────────────────────────────────────────────
  async function pullModel(name: string) {
    pullingModel = name
    pullProgress = 'Starting...'
    try {
      const endpoint = store.settings.apiEndpoint || 'http://localhost:11434/v1/chat/completions'
      await pullOllamaModel(
        endpoint,
        name,
        (status, pct) => { pullProgress = pct != null ? `${status} ${pct}%` : status },
      )
      // Refresh model list
      models = await detectOllamaModels(endpoint)
      suggested = hardware ? suggestModelsForHardware(hardware, models) : []
      // Recompute recommendation
      if (hardware && models.length > 0) {
        recommendation = computeRecommendation(hardware, models, agentsForMode('general'))
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
    pullingModel = null
    pullProgress = ''
  }

  // ── Install all missing suggested models ─────────────────────────────────────
  let installingAll = $state(false)
  let installQueue = $state<string[]>([])
  let installCurrent = $state(0)

  const missingSuggested = $derived(suggested.filter((s) => !s.installed))

  // All unique recommended models and whether they're available
  const recModels = $derived(() => {
    const allModels = new Set<string>()
    for (const ma of modeAssignments) {
      for (const a of ma.agents) {
        if (a.recommendedModel) allModels.add(a.recommendedModel)
      }
    }
    const installedNames = new Set(models.map((m) => m.name))
    const cloudModelNames = new Set(store.settings.llmProviders.map(p => p.model))
    return [...allModels].map((name) => ({
      name,
      installed: installedNames.has(name) || cloudModelNames.has(name),
    }))
  })
  const missingRecModels = $derived(recModels().filter((m) => !m.installed))

  async function installAllModels() {
    const toPull = missingSuggested.map((s) => s.name)
    if (toPull.length === 0) return
    installingAll = true
    installQueue = toPull
    installCurrent = 0
    for (let i = 0; i < toPull.length; i++) {
      installCurrent = i
      await pullModel(toPull[i])
    }
    installingAll = false
    installQueue = []
  }

  // ── Apply recommendation ────────────────────────────────────────────────────
  function applyAndContinue() {
    const rec = activeRec
    if (!rec) {
      store.switchMode('general')
      return
    }
    // Set the global model
    if (rec.globalModel) {
      store.updateSettings({ model: rec.globalModel })
    }
    // Apply per-agent model assignments from the computed modeAssignments
    for (const ma of modeAssignments) {
      const agents = agentsForMode(ma.modeId)
      if (agents.length === 0) continue
      for (const agent of agents) {
        const assign = ma.agents.find(a => a.id === agent.id)
        if (assign) {
          agent.model = assign.recommendedModel
        }
      }
      try {
        localStorage.setItem(`gremlin_agents_${ma.modeId}`, JSON.stringify(agents))
      } catch { /* ignore */ }
    }
    store.switchMode('general')
  }
</script>

<div class="tuning-view">
  <div class="tuning-inner">
    <h1 class="tuning-title">Setup</h1>

    {#if phase === 'detecting'}
      <div class="tuning-section">
        <div class="detecting-spinner">
          <span class="spinner-dot"></span>
          Detecting hardware...
        </div>
      </div>
    {:else if phase === 'ai-analyzing'}
      <!-- Show hardware while AI analyzes -->
      {#if hardware}
        <div class="tuning-section">
          <h2 class="section-title">Hardware</h2>
          <div class="hw-grid">
            <div class="hw-card">
              <span class="hw-label">GPU</span>
              <span class="hw-value">{hardware.gpuName}</span>
            </div>
            <div class="hw-card">
              <span class="hw-label">Memory</span>
              <span class="hw-value">{hardware.totalMemoryGB} GB</span>
            </div>
            <div class="hw-card">
              <span class="hw-label">Usable VRAM</span>
              <span class="hw-value accent">{usableVRAM} GB</span>
            </div>
            <div class="hw-card">
              <span class="hw-label">CPU Cores</span>
              <span class="hw-value">{hardware.cpuCores}</span>
            </div>
          </div>
        </div>
      {/if}
      <div class="tuning-section">
        <div class="ai-analyzing">
          <span class="spinner-dot"></span>
          <div class="ai-status">
            <span class="ai-status-text">{aiStatus}</span>
            {#if aiProgress > 0 && aiProgress < 1}
              <div class="ai-progress-bar">
                <div class="ai-progress-fill" style="width: {Math.round(aiProgress * 100)}%"></div>
              </div>
              <span class="ai-progress-label">{aiProgressText}</span>
            {/if}
          </div>
        </div>
      </div>
      <div class="tuning-actions">
        <button class="ghost" onclick={() => { useAI = false; detect() }}>Skip AI Analysis</button>
      </div>
    {:else}
      <!-- Hardware -->
      <div class="tuning-section">
        <h2 class="section-title">Hardware</h2>
        {#if hardware}
          <div class="hw-grid">
            <div class="hw-card">
              <span class="hw-label">GPU</span>
              <span class="hw-value">{hardware.gpuName}</span>
            </div>
            <div class="hw-card">
              <span class="hw-label">Memory</span>
              <span class="hw-value">{hardware.totalMemoryGB} GB</span>
            </div>
            <div class="hw-card">
              <span class="hw-label">Usable VRAM</span>
              <span class="hw-value accent">{usableVRAM} GB</span>
            </div>
            <div class="hw-card">
              <span class="hw-label">CPU Cores</span>
              <span class="hw-value">{hardware.cpuCores}</span>
            </div>
            <div class="hw-card">
              <span class="hw-label">Platform</span>
              <span class="hw-value">{hardware.platform} / {hardware.arch}</span>
            </div>
            <div class="hw-card">
              <span class="hw-label">Ollama</span>
              <span class="hw-value" class:accent={ollamaUp} class:err={!ollamaUp}>{ollamaUp ? 'Running' : 'Not detected'}</span>
            </div>
          </div>
        {/if}
      </div>

      <!-- Installed Models -->
      <div class="tuning-section">
        <h2 class="section-title">Installed Models</h2>
        {#if models.length === 0}
          <p class="muted">No models found. {ollamaUp ? 'Pull some models below.' : 'Start Ollama first.'}</p>
        {:else}
          <div class="model-list">
            {#each models as m}
              <div class="model-chip">
                <span class="model-name">{m.name}</span>
                <span class="model-size">{m.sizeGB} GB</span>
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <!-- Recommendation -->
      {#if activeRec}
        <div class="tuning-section">
          <div class="section-head">
            <div>
              <h2 class="section-title">
                Recommendation
                {#if aiRecommendation}
                  <span class="ai-badge">AI</span>
                {/if}
              </h2>
            </div>
            {#if missingRecModels.length > 0}
              <button
                class="primary btn-sm"
                onclick={async () => { for (const m of missingRecModels) await pullModel(m.name) }}
                disabled={installingAll || pullingModel !== null}
              >Install Missing ({missingRecModels.length})</button>
            {/if}
          </div>
          <div class="rec-card">
            <div class="rec-strategy">
              <span class="strategy-badge">{activeRec.strategy.replace('-', ' ')}</span>
              {#if activeRec.globalModel}
                <span class="rec-model">{activeRec.globalModel}</span>
              {/if}
            </div>
            <p class="rec-reasoning">{activeRec.reasoning}</p>
            {#if totalChanges > 0}
              <p class="rec-changes">{totalChanges} agent{totalChanges === 1 ? '' : 's'} will change models across {modeAssignments.filter(m => m.changeCount > 0).length} mode{modeAssignments.filter(m => m.changeCount > 0).length === 1 ? '' : 's'}</p>
            {:else if modeAssignments.length > 0}
              <p class="rec-no-changes">Defaults are already optimal for your hardware</p>
            {/if}
          </div>
        </div>
      {/if}

      <!-- Per-mode agent assignments -->
      {#if modeAssignments.length > 0}
        <div class="tuning-section">
          <h2 class="section-title">Model Assignments</h2>
          <div class="mode-list">
            {#each modeAssignments as ma}
              <div class="mode-block">
                <button
                  class="mode-header"
                  onclick={() => expandedMode = expandedMode === ma.modeId ? null : ma.modeId}
                >
                  <span class="mode-header-left">
                    <span class="mode-name">{ma.modeName}</span>
                    <span class="mode-agent-count">{ma.agents.length} agents</span>
                  </span>
                  <span class="mode-header-right">
                    {#if ma.changeCount > 0}
                      <span class="change-badge">{ma.changeCount} change{ma.changeCount === 1 ? '' : 's'}</span>
                    {:else}
                      <span class="no-change-badge">no changes</span>
                    {/if}
                    <span class="expand-arrow" class:expanded={expandedMode === ma.modeId}>&#9662;</span>
                  </span>
                </button>
                {#if expandedMode === ma.modeId}
                  <div class="agent-table">
                    {#each ma.agents as agent}
                      <div class="agent-row" class:changed={agent.changed}>
                        <div class="agent-info">
                          <span class="agent-name">{agent.name}</span>
                          <span class="agent-role">{agent.roleClass}</span>
                        </div>
                        <div class="agent-models">
                          {#if agent.changed}
                            <span class="model-old">{agent.defaultModel || '(none)'}</span>
                            <span class="model-arrow">&#8594;</span>
                            <span class="model-new">{agent.recommendedModel}</span>
                          {:else}
                            <span class="model-same">{agent.recommendedModel || '(none)'}</span>
                          {/if}
                        </div>
                      </div>
                    {/each}
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        </div>
      {/if}

      <!-- Missing models needed -->
      {#if missingRecModels.length > 0}
        <div class="tuning-section">
          <h2 class="section-title">Missing Models</h2>
          <div class="rec-models">
            {#each missingRecModels as m}
              <div class="rec-model-row">
                <span class="rec-model-name">{m.name}</span>
                {#if pullingModel === m.name}
                  <span class="pull-status">{pullProgress}</span>
                {:else}
                  <button
                    class="ghost btn-sm"
                    onclick={() => pullModel(m.name)}
                    disabled={pullingModel !== null}
                  >Pull</button>
                {/if}
              </div>
            {/each}
          </div>
        </div>
      {/if}

      <!-- Warnings -->
      {#if activeRec && activeRec.warnings.length > 0}
        <div class="tuning-section">
          <h2 class="section-title">Warnings</h2>
          <div class="rec-warnings">
            {#each activeRec.warnings as w}
              <div class="rec-warn-row">
                <p class="rec-warn">{w.text}</p>
                {#if w.pullModel}
                  {#if models.some(m => m.name === w.pullModel)}
                    <span class="installed-badge">Installed</span>
                  {:else if pullingModel === w.pullModel}
                    <span class="pull-status">{pullProgress}</span>
                  {:else}
                    <button
                      class="ghost btn-sm"
                      onclick={() => pullModel(w.pullModel!)}
                      disabled={pullingModel !== null}
                    >Pull {w.pullModel}</button>
                  {/if}
                {/if}
              </div>
            {/each}
          </div>
        </div>
      {/if}

      <!-- Suggested Models to Pull -->
      {#if suggested.length > 0}
        <div class="tuning-section">
          <div class="section-head">
            <div>
              <h2 class="section-title">Suggested Models</h2>
              <p class="section-hint">Models recommended for your {hardware?.gpuMemoryGB ?? '?'}GB hardware</p>
            </div>
            {#if missingSuggested.length > 0}
              <button
                class="primary btn-sm"
                onclick={installAllModels}
                disabled={installingAll || pullingModel !== null}
              >
                {#if installingAll}
                  Installing {installCurrent + 1}/{installQueue.length}...
                {:else}
                  Install All ({missingSuggested.length})
                {/if}
              </button>
            {/if}
          </div>
          <div class="suggest-list">
            {#each suggested as s}
              <div class="suggest-row" class:installed={s.installed}>
                <div class="suggest-info">
                  <span class="suggest-name">{s.name}</span>
                  <span class="suggest-size">{s.sizeGB} GB</span>
                  <span class="suggest-reason">{s.reason}</span>
                </div>
                {#if s.installed}
                  <span class="installed-badge">Installed</span>
                {:else if pullingModel === s.name}
                  <span class="pull-status">{pullProgress}</span>
                {:else}
                  <button
                    class="ghost btn-sm"
                    onclick={() => pullModel(s.name)}
                    disabled={pullingModel !== null}
                  >Pull</button>
                {/if}
              </div>
            {/each}
          </div>
        </div>
      {/if}

      {#if error}
        <div class="tuning-error">{error}</div>
      {/if}

      <!-- Actions -->
      <div class="tuning-actions">
        <button class="ghost" onclick={() => { useAI = true; detect() }}>Re-scan</button>
        <button class="ghost" onclick={() => store.switchMode('general')}>Skip Setup</button>
        <button
          class="primary"
          onclick={applyAndContinue}
          disabled={!activeRec && models.length === 0}
        >
          {activeRec ? 'Apply & Continue' : 'Continue'}
        </button>
      </div>
      <div class="bottom-spacer"></div>
    {/if}
  </div>
</div>

<style>
  .tuning-view {
    flex: 1;
    overflow-y: auto;
    display: flex;
    justify-content: center;
    padding: 24px 24px 64px;
  }
  .tuning-inner {
    max-width: 720px;
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 24px;
  }
  .tuning-title {
    font-size: 22px;
    font-weight: 800;
    color: var(--color-accent);
    letter-spacing: 0.02em;
  }

  .tuning-section {
    background: var(--glass);
    border: 1px solid var(--glass-border);
    border-radius: var(--radius-lg);
    padding: 18px 20px;
    backdrop-filter: blur(var(--blur-subtle));
  }
  .section-title {
    font-size: 13px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-text-3);
    margin-bottom: 12px;
  }
  .section-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
  }
  .section-head .section-title { margin-bottom: 2px; }
  .section-head + .suggest-list { margin-top: 0; }
  .section-hint {
    font-size: 11px;
    color: var(--color-text-4);
    margin: -8px 0 12px;
  }
  .section-head .section-hint { margin: 0; }

  /* Hardware grid */
  .hw-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 10px;
  }
  .hw-card {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 10px 14px;
    background: var(--glass-light);
    border: 1px solid var(--glass-border);
    border-radius: var(--radius);
  }
  .hw-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-text-4); }
  .hw-value { font-size: 14px; font-weight: 600; color: var(--color-text); font-family: var(--font-mono); }
  .hw-value.accent { color: var(--color-accent); }
  .hw-value.err { color: var(--color-accent-err); }

  /* Model chips */
  .model-list { display: flex; flex-wrap: wrap; gap: 8px; }
  .model-chip {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: var(--glass-tinted);
    border: 1px solid var(--glass-tinted-border);
    border-radius: var(--radius);
    font-size: 12px;
  }
  .model-name { font-weight: 600; color: var(--color-accent); font-family: var(--font-mono); }
  .model-size { color: var(--color-text-3); font-family: var(--font-mono); font-size: 11px; }

  /* Recommendation */
  .rec-card {
    padding: 14px 16px;
    background: var(--glass-light);
    border: 1px solid var(--glass-border);
    border-radius: var(--radius);
  }
  .rec-strategy {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 8px;
  }
  .strategy-badge {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 3px 8px;
    border-radius: 4px;
    background: rgba(63,185,80,0.12);
    color: var(--color-accent);
  }
  .rec-model { font-family: var(--font-mono); font-size: 13px; font-weight: 600; color: var(--color-text); }
  .rec-reasoning { font-size: 12px; color: var(--color-text-2); line-height: 1.5; margin-bottom: 4px; }
  .rec-models { display: flex; flex-direction: column; gap: 6px; margin: 10px 0; }
  .rec-model-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 6px 10px;
    background: var(--glass);
    border: 1px solid var(--glass-border);
    border-radius: var(--radius);
  }
  .rec-model-name { font-family: var(--font-mono); font-size: 12px; font-weight: 600; color: var(--color-text); }
  .rec-warnings { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }
  .rec-warn-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 6px 10px;
    background: rgba(255,180,50,0.05);
    border: 1px solid rgba(255,180,50,0.15);
    border-radius: var(--radius);
  }
  .rec-warn {
    font-size: 11px;
    color: var(--color-accent-warn);
    line-height: 1.4;
    flex: 1;
  }
  .rec-warn::before { content: '! '; font-weight: 700; }

  /* Suggested models */
  .suggest-list { display: flex; flex-direction: column; gap: 8px; }
  .suggest-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 14px;
    background: var(--glass-light);
    border: 1px solid var(--glass-border);
    border-radius: var(--radius);
  }
  .suggest-info { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 10px; flex: 1; min-width: 0; }
  .suggest-name { font-family: var(--font-mono); font-size: 13px; font-weight: 600; color: var(--color-text); }
  .suggest-size { font-family: var(--font-mono); font-size: 11px; color: var(--color-text-3); }
  .suggest-reason { font-size: 11px; color: var(--color-text-3); width: 100%; }
  .pull-status { font-size: 11px; color: var(--color-accent-2); font-family: var(--font-mono); white-space: nowrap; }
  .suggest-row.installed { opacity: 0.6; }
  .installed-badge {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-accent);
    padding: 3px 8px;
    border-radius: 4px;
    background: rgba(63,185,80,0.1);
    white-space: nowrap;
  }

  /* AI badge */
  .ai-badge {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 2px 6px;
    border-radius: 4px;
    background: rgba(139, 92, 246, 0.15);
    color: #a78bfa;
    margin-left: 6px;
    vertical-align: middle;
  }

  /* Change summary in recommendation card */
  .rec-changes {
    font-size: 12px;
    color: var(--color-accent);
    font-weight: 600;
    margin-top: 8px;
  }
  .rec-no-changes {
    font-size: 12px;
    color: var(--color-text-3);
    margin-top: 8px;
  }

  /* Per-mode assignment list */
  .mode-list { display: flex; flex-direction: column; gap: 4px; }
  .mode-block {
    border: 1px solid var(--glass-border);
    border-radius: var(--radius);
    overflow: hidden;
  }
  .mode-header {
    all: unset;
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 10px 14px;
    cursor: pointer;
    background: var(--glass-light);
    transition: background 0.15s;
    box-sizing: border-box;
  }
  .mode-header:hover { background: var(--glass); }
  .mode-header-left, .mode-header-right { display: flex; align-items: center; gap: 8px; }
  .mode-name { font-size: 13px; font-weight: 600; color: var(--color-text); }
  .mode-agent-count { font-size: 11px; color: var(--color-text-4); }
  .change-badge {
    font-size: 10px;
    font-weight: 600;
    padding: 2px 7px;
    border-radius: 4px;
    background: rgba(63,185,80,0.12);
    color: var(--color-accent);
  }
  .no-change-badge {
    font-size: 10px;
    padding: 2px 7px;
    color: var(--color-text-4);
  }
  .expand-arrow {
    font-size: 10px;
    color: var(--color-text-4);
    transition: transform 0.15s;
  }
  .expand-arrow.expanded { transform: rotate(180deg); }

  /* Agent assignment table */
  .agent-table {
    border-top: 1px solid var(--glass-border);
  }
  .agent-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 7px 14px;
    font-size: 12px;
  }
  .agent-row + .agent-row { border-top: 1px solid var(--glass-border); }
  .agent-row.changed { background: rgba(63,185,80,0.04); }
  .agent-info { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .agent-name { font-weight: 600; color: var(--color-text-2); white-space: nowrap; }
  .agent-role {
    font-size: 10px;
    color: var(--color-text-4);
    padding: 1px 5px;
    border-radius: 3px;
    background: var(--glass);
    white-space: nowrap;
  }
  .agent-models { display: flex; align-items: center; gap: 6px; font-family: var(--font-mono); font-size: 11px; flex-shrink: 0; }
  .model-old { color: var(--color-text-4); text-decoration: line-through; }
  .model-arrow { color: var(--color-accent); font-size: 12px; }
  .model-new { color: var(--color-accent); font-weight: 600; }
  .model-same { color: var(--color-text-3); }

  /* AI analysis phase */
  .ai-analyzing {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 20px;
  }
  .ai-analyzing .spinner-dot { margin-top: 4px; flex-shrink: 0; }
  .ai-status {
    display: flex;
    flex-direction: column;
    gap: 8px;
    flex: 1;
    min-width: 0;
  }
  .ai-status-text { font-size: 13px; color: var(--color-text-2); }
  .ai-progress-bar {
    height: 4px;
    background: var(--glass-border);
    border-radius: 2px;
    overflow: hidden;
    width: 100%;
  }
  .ai-progress-fill {
    height: 100%;
    background: var(--color-accent);
    border-radius: 2px;
    transition: width 0.3s ease;
  }
  .ai-progress-label {
    font-size: 10px;
    color: var(--color-text-4);
    font-family: var(--font-mono);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Spinner */
  .detecting-spinner {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 24px;
    font-size: 14px;
    color: var(--color-text-2);
  }
  .spinner-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--color-accent);
    animation: pulse 1s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 0.3; transform: scale(0.8); }
    50% { opacity: 1; transform: scale(1.2); }
  }

  /* Error */
  .tuning-error {
    padding: 10px 14px;
    background: var(--glass-err);
    border: 1px solid var(--glass-err-border);
    border-radius: var(--radius);
    font-size: 12px;
    color: var(--color-accent-err);
  }

  /* Actions */
  .tuning-actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    padding-top: 16px;
  }

  .bottom-spacer { height: 19px; flex-shrink: 0; }
  .muted { font-size: 12px; color: var(--color-text-3); }
</style>
