<script lang="ts">
  import { store } from '../lib/store.svelte'
  import { detectHardware, detectOllamaModels, isOllamaRunning, computeRecommendation, suggestModelsForHardware } from '../lib/autotune'
  import type { HardwareProfile, InstalledModel, TuneRecommendation, SuggestedModel } from '../lib/autotune'
  import { pullOllamaModel } from '../lib/api'
  import { agentsForMode, BUILTIN_MODES } from '../lib/types'
  import type { AgentConfig } from '../lib/types'

  // ── State ──────────────────────────────────────────────────────────────────
  let phase = $state<'detecting' | 'ready' | 'applying'>('detecting')
  let hardware = $state<HardwareProfile | null>(null)
  let ollamaUp = $state(false)
  let models = $state<InstalledModel[]>([])
  let recommendation = $state<TuneRecommendation | null>(null)
  let suggested = $state<SuggestedModel[]>([])
  let pullingModel = $state<string | null>(null)
  let pullProgress = $state('')
  let error = $state('')

  const usableVRAM = $derived(hardware ? Math.round(hardware.gpuMemoryGB * 0.75 * 10) / 10 : 0)

  // ── Run detection on mount ──────────────────────────────────────────────────
  async function detect() {
    phase = 'detecting'
    error = ''
    try {
      hardware = await detectHardware()
      const endpoint = store.settings.apiEndpoint || 'http://localhost:11434/v1/chat/completions'
      ollamaUp = await isOllamaRunning(endpoint)
      if (ollamaUp) {
        models = await detectOllamaModels(endpoint)
      }
      // Compute recommendation using general mode agents as baseline
      const agents = agentsForMode('general')
      if (models.length > 0 && agents.length > 0) {
        recommendation = computeRecommendation(hardware, models, agents)
      }
      suggested = suggestModelsForHardware(hardware, models)
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

  // Models referenced in the recommendation that aren't installed
  const recModels = $derived(() => {
    if (!recommendation) return [] as { name: string, installed: boolean }[]
    const unique = [...new Set(Object.values(recommendation.assignments))]
    const installedNames = new Set(models.map((m) => m.name))
    return unique.filter(Boolean).map((name) => ({ name, installed: installedNames.has(name) }))
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
    if (!recommendation) {
      store.switchMode('general')
      return
    }
    // Set the global model
    if (recommendation.globalModel) {
      store.updateSettings({ model: recommendation.globalModel })
    }
    // Apply per-agent model assignments to ALL builtin modes
    for (const mode of BUILTIN_MODES) {
      if (mode.id === 'tuning') continue
      const agents = agentsForMode(mode.id)
      if (agents.length === 0) continue
      const modeRec = computeRecommendation(hardware!, models, agents)
      for (const agent of agents) {
        agent.model = modeRec.assignments[agent.id] || recommendation.globalModel || ''
      }
      // Save via localStorage directly
      try {
        localStorage.setItem(`gremlin_agents_${mode.id}`, JSON.stringify(agents))
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
      {#if recommendation}
        <div class="tuning-section">
          <div class="section-head">
            <h2 class="section-title">Recommendation</h2>
            {#if missingRecModels.length > 0}
              <button
                class="primary btn-sm"
                onclick={async () => { for (const m of missingRecModels) await pullModel(m.name) }}
                disabled={installingAll || pullingModel !== null}
              >Install Recommended ({missingRecModels.length})</button>
            {/if}
          </div>
          <div class="rec-card">
            <div class="rec-strategy">
              <span class="strategy-badge">{recommendation.strategy.replace('-', ' ')}</span>
              {#if recommendation.globalModel}
                <span class="rec-model">{recommendation.globalModel}</span>
              {/if}
            </div>
            <p class="rec-reasoning">{recommendation.reasoning}</p>

            <!-- Model assignment list -->
            {#if recModels().length > 0}
              <div class="rec-models">
                {#each recModels() as m}
                  <div class="rec-model-row" class:installed={m.installed}>
                    <span class="rec-model-name">{m.name}</span>
                    {#if m.installed}
                      <span class="installed-badge">Installed</span>
                    {:else if pullingModel === m.name}
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
            {/if}

            {#if recommendation.warnings.length > 0}
              <div class="rec-warnings">
                {#each recommendation.warnings as w}
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
            {/if}
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
        <button class="ghost" onclick={() => detect()}>Re-scan</button>
        <button class="ghost" onclick={() => store.switchMode('general')}>Skip Setup</button>
        <button
          class="primary"
          onclick={applyAndContinue}
          disabled={!recommendation && models.length === 0}
        >
          {recommendation ? 'Apply & Continue' : 'Continue'}
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
  .rec-model-row.installed { opacity: 0.6; }
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
