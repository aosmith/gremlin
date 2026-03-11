<script lang="ts">
  import { PROVIDERS, SEARCH_PROVIDERS } from '../lib/types'
  import type { Settings, ProviderPreset, SearchProvider, LLMProviderConfig } from '../lib/types'
  import { store } from '../lib/store.svelte'
  import { fetchOllamaModels, fetchOpenAIModels } from '../lib/api'
  import { isWebGPUAvailable, getLoadedModel } from '../lib/webllm'

  interface Props { onclose: () => void }
  const { onclose }: Props = $props()

  let draft = $state<Settings>({ ...store.settings })

  // ── LLM provider selection (multi-select, round-robin) ──────────────────

  /** Seed llmProviders from legacy single-provider fields if empty. */
  function initProviders(): LLMProviderConfig[] {
    if (draft.llmProviders.length > 0) return [...draft.llmProviders]
    // Migrate: detect which preset matches the legacy endpoint
    for (const p of PROVIDERS) {
      if (p.id === 'custom' || p.id === 'webllm') continue
      if (p.endpoint && draft.apiEndpoint.startsWith(p.endpoint.split('/v1')[0].split('/api')[0])) {
        return [{ id: p.id, endpoint: p.endpoint, apiKey: draft.apiKey, model: draft.model, format: p.format }]
      }
    }
    if (draft.apiFormat === 'webllm') {
      return [{ id: 'webllm', endpoint: '', apiKey: '', model: draft.model, format: 'webllm' }]
    }
    // Custom endpoint
    if (draft.apiEndpoint) {
      return [{ id: 'custom', endpoint: draft.apiEndpoint, apiKey: draft.apiKey, model: draft.model, format: draft.apiFormat }]
    }
    return []
  }

  let activeLLM = $state<LLMProviderConfig[]>(initProviders())

  function toggleLLMProvider(p: ProviderPreset) {
    const idx = activeLLM.findIndex((lp) => lp.id === p.id)
    if (idx >= 0) {
      activeLLM = activeLLM.filter((_, i) => i !== idx)
    } else {
      activeLLM = [...activeLLM, {
        id: p.id,
        endpoint: p.endpoint,
        apiKey: '',
        model: p.defaultModel,
        format: p.format,
      }]
    }
    syncDraft()
  }

  function updateProvider(index: number, patch: Partial<LLMProviderConfig>) {
    activeLLM[index] = { ...activeLLM[index], ...patch }
    activeLLM = [...activeLLM]
    syncDraft()
  }

  function removeProvider(index: number) {
    activeLLM = activeLLM.filter((_, i) => i !== index)
    syncDraft()
  }

  /** Keep draft.llmProviders + legacy fields in sync. */
  function syncDraft() {
    draft.llmProviders = [...activeLLM]
    // Sync legacy fields from first provider for backwards compat
    if (activeLLM.length > 0) {
      const first = activeLLM[0]
      draft.apiEndpoint = first.endpoint
      draft.apiKey = first.apiKey
      draft.model = first.model
      draft.apiFormat = first.format
    }
  }

  const isWebLLM = $derived(activeLLM.length === 1 && activeLLM[0].id === 'webllm')
  const webgpuOk = isWebGPUAvailable()
  const loadedModel = $derived(getLoadedModel())

  // ── Dynamic model fetching (per-provider) ───────────────────────────────
  let discoveredModels = $state<Record<string, string[]>>({})
  let fetchStatuses = $state<Record<string, 'idle' | 'loading' | 'ok' | 'error'>>({})
  let fetchErrors = $state<Record<string, string>>({})

  async function discoverModels(lp: LLMProviderConfig) {
    fetchStatuses[lp.id] = 'loading'
    fetchErrors[lp.id] = ''
    try {
      let models: string[]
      if (lp.id === 'ollama') {
        models = await fetchOllamaModels(lp.endpoint)
      } else {
        models = await fetchOpenAIModels(lp.endpoint, lp.apiKey)
      }
      discoveredModels[lp.id] = models
      fetchStatuses[lp.id] = 'ok'
      // Default to first model if current selection is blank
      if (models.length > 0 && !lp.model.trim()) {
        const idx = activeLLM.findIndex(p => p.id === lp.id)
        if (idx >= 0) updateProvider(idx, { model: models[0] })
      }
    } catch (e) {
      fetchErrors[lp.id] = e instanceof Error ? e.message : String(e)
      fetchStatuses[lp.id] = 'error'
    }
  }

  function modelsFor(lp: LLMProviderConfig): string[] {
    if (discoveredModels[lp.id]?.length) return discoveredModels[lp.id]
    const preset = PROVIDERS.find((p) => p.id === lp.id)
    return preset?.models ?? []
  }

  function canDiscover(id: string): boolean {
    return ['ollama', 'lmstudio', 'openrouter'].includes(id)
  }

  // ── Search provider selection (multi-select, tried in order) ────────────
  let activeSearchIds = $state<string[]>([...(draft.searchProviders ?? [])])
  const activeSearchProviders = $derived(
    activeSearchIds.map((id) => SEARCH_PROVIDERS.find((p) => p.id === id)).filter(Boolean) as SearchProvider[]
  )
  const needsSearchKey = $derived(activeSearchProviders.some((p) => p.requiresKey))
  const needsSearchEndpoint = $derived(activeSearchIds.includes('searxng'))

  function toggleSearchProvider(p: SearchProvider) {
    const idx = activeSearchIds.indexOf(p.id)
    if (idx >= 0) {
      activeSearchIds = activeSearchIds.filter((id) => id !== p.id)
    } else {
      activeSearchIds = [...activeSearchIds, p.id]
      if (p.id === 'searxng' && !draft.searchEndpoint) draft.searchEndpoint = 'https://searx.be'
    }
    draft.searchProviders = activeSearchIds
  }

  // ── Browser sidecar health check ───────────────────────────────────────
  let sidecarHealth = $state<'idle' | 'checking' | 'ok' | 'error'>('idle')

  async function checkSidecar() {
    sidecarHealth = 'checking'
    try {
      const resp = await fetch('http://127.0.0.1:3131/status', { signal: AbortSignal.timeout(2000) })
      sidecarHealth = resp.ok ? 'ok' : 'error'
    } catch {
      sidecarHealth = 'error'
    }
  }

  $effect(() => {
    if (draft.browserTools) checkSidecar()
    else sidecarHealth = 'idle'
  })

  let confirmingClear = $state(false)

  function clearLocalStorage() {
    localStorage.clear()
    location.reload()
  }

  function save() {
    syncDraft()
    store.updateSettings(draft)
    onclose()
  }

  const canSave = $derived(
    isWebLLM || activeLLM.some((lp) => lp.model.trim())
  )
</script>

<div class="modal-backdrop" role="dialog" aria-modal="true">
  <div class="modal wide">
    <div class="modal-header">
      ⚙ Settings
      <button class="ghost icon" onclick={onclose}>✕</button>
    </div>

    <div class="modal-body">

      <!-- LLM Provider grid (multi-select) -->
      <div class="field">
        <!-- svelte-ignore a11y_label_has_associated_control -->
        <label>LLM Providers <small class="muted">(select multiple for round-robin)</small></label>
        <div class="select-grid">
          {#each PROVIDERS as p (p.id)}
            <button
              class="select-grid-btn"
              class:active={activeLLM.some((lp) => lp.id === p.id)}
              onclick={() => toggleLLMProvider(p)}
              title={p.description}
            >
              <span class="select-grid-icon">{p.icon}</span>
              <span class="select-grid-name">{p.name}</span>
              <span class="badge badge-{p.kind}">{p.kind}</span>
              {#if activeLLM.some((lp) => lp.id === p.id)}
                <span class="p-order">{activeLLM.findIndex((lp) => lp.id === p.id) + 1}</span>
              {/if}
            </button>
          {/each}
        </div>
      </div>

      {#if activeLLM.length > 1}
        <div class="provider-desc">
          Round-robin: {activeLLM.map((lp) => {
            const preset = PROVIDERS.find((p) => p.id === lp.id)
            return `${preset?.icon ?? ''} ${lp.model || preset?.defaultModel || preset?.name}`
          }).join(' → ')}
        </div>
      {/if}

      <!-- Per-provider config cards -->
      {#each activeLLM as lp, i (lp.id)}
        {@const preset = PROVIDERS.find((p) => p.id === lp.id)}
        {@const models = modelsFor(lp)}
        <div class="multi-provider-config">
          <div class="mpc-header">
            <span>{preset?.icon} {preset?.name}</span>
            <button class="ghost icon" onclick={() => removeProvider(i)} title="Remove">✕</button>
          </div>

          {#if lp.id === 'webllm'}
            <!-- WebLLM special section -->
            <div class="webllm-info" class:gpu-ok={webgpuOk} class:gpu-err={!webgpuOk}>
              {#if webgpuOk}
                <div class="hint-steps">
                  <div>Models run fully on your GPU — no server or API key needed</div>
                  {#if loadedModel}
                    <div class="loaded-badge">✓ Loaded: <strong>{loadedModel}</strong></div>
                  {/if}
                </div>
              {:else}
                <div class="hint-steps" style="color:var(--color-accent-err)">
                  WebGPU not available. Try <strong>Chrome 113+</strong> or <strong>Edge 113+</strong>.
                </div>
              {/if}
            </div>
          {/if}

          <div class="mpc-fields">
            {#if models.length > 0}
              <select
                value={lp.model}
                onchange={(e) => updateProvider(i, { model: (e.target as HTMLSelectElement).value })}
                style="flex:1"
              >
                {#each models as m}
                  <option value={m}>{m}</option>
                {/each}
              </select>
            {:else}
              <input
                type="text"
                value={lp.model}
                placeholder={preset?.defaultModel || 'model name'}
                oninput={(e) => updateProvider(i, { model: (e.target as HTMLInputElement).value })}
                style="flex:1"
              />
            {/if}
            {#if canDiscover(lp.id)}
              <button
                class="ghost"
                onclick={() => discoverModels(lp)}
                disabled={fetchStatuses[lp.id] === 'loading'}
                title="Fetch available models"
              >
                {fetchStatuses[lp.id] === 'loading' ? '⟳' : '↺'}
              </button>
            {/if}
            {#if preset?.requiresKey}
              <input
                type="password"
                value={lp.apiKey}
                placeholder="API key"
                autocomplete="off"
                oninput={(e) => updateProvider(i, { apiKey: (e.target as HTMLInputElement).value })}
                style="flex:1"
              />
            {/if}
          </div>
          {#if fetchStatuses[lp.id] === 'ok'}
            <small style="color:var(--color-accent)">✓ {discoveredModels[lp.id]?.length} model{(discoveredModels[lp.id]?.length ?? 0) !== 1 ? 's' : ''}</small>
          {:else if fetchStatuses[lp.id] === 'error'}
            <small style="color:var(--color-accent-err)">✖ {fetchErrors[lp.id]}</small>
          {/if}
        </div>
      {/each}

      {#if activeLLM.length === 0}
        <small class="muted" style="padding: 0 4px">No providers selected. Toggle at least one provider above.</small>
      {/if}

      <!-- Search providers (multi-select, tried in order with fallback) -->
      <div class="section-divider">Web Search</div>
      <div class="field">
        <!-- svelte-ignore a11y_label_has_associated_control -->
        <label>Search Providers <small class="muted">(select multiple — tried in order, falls back on failure)</small></label>
        <div class="select-grid search-grid">
          {#each SEARCH_PROVIDERS as p (p.id)}
            <button
              class="select-grid-btn"
              class:active={activeSearchIds.includes(p.id)}
              onclick={() => toggleSearchProvider(p)}
              title={p.description}
            >
              <span class="select-grid-icon">{p.icon}</span>
              <span class="select-grid-name">{p.name}</span>
              {#if activeSearchIds.includes(p.id)}
                <span class="p-order">{activeSearchIds.indexOf(p.id) + 1}</span>
              {/if}
            </button>
          {/each}
        </div>
      </div>

      {#if activeSearchProviders.length > 0}
        <div class="provider-desc">
          Order: {activeSearchProviders.map((p) => p.name).join(' → ')}
        </div>
      {/if}

      {#if needsSearchKey}
        <div class="field">
          <label for="search-key">Search API Key</label>
          <input
            id="search-key"
            type="password"
            bind:value={draft.searchApiKey}
            placeholder="Paste your API key…"
            autocomplete="off"
          />
          {#if activeSearchIds.includes('brave')}
            <small>Get a free key at <strong>api.search.brave.com</strong></small>
          {:else if activeSearchIds.includes('serper')}
            <small>Get a free key at <strong>serper.dev</strong></small>
          {:else if activeSearchIds.includes('tavily')}
            <small>Get a free key at <strong>tavily.com</strong></small>
          {/if}
        </div>
      {/if}

      {#if needsSearchEndpoint && !draft.searchEndpoint}
        <div class="field">
          <label for="search-endpoint">SearXNG Instance URL</label>
          <input
            id="search-endpoint"
            type="text"
            bind:value={draft.searchEndpoint}
            placeholder="https://searx.be"
          />
        </div>
      {/if}

      <!-- Browser Tools -->
      <div class="section-divider">Browser Tools</div>
      <label class="toggle-row">
        <span class="toggle-switch" class:on={draft.browserTools}>
          <input type="checkbox" bind:checked={draft.browserTools} />
          <span class="toggle-track"><span class="toggle-knob"></span></span>
        </span>
        <span>Enable browser tools</span>
      </label>
      {#if draft.browserTools}
        <div class="browser-hint" class:sidecar-ok={sidecarHealth === 'ok'} class:sidecar-err={sidecarHealth === 'error'} class:sidecar-checking={sidecarHealth === 'checking'}>
          {#if sidecarHealth === 'checking'}
            Checking sidecar...
          {:else if sidecarHealth === 'ok'}
            Sidecar connected at 127.0.0.1:3131
          {:else}
            Sidecar not reachable — start with: <code>node server/browser-server.mjs</code>
          {/if}
        </div>
      {/if}

      <!-- Hardware Setup (hidden during onboarding) -->
      {#if store.appMode !== 'tuning'}
        <div class="section-divider">Hardware</div>
        <button
          class="ghost setup-btn"
          onclick={() => { onclose(); store.switchMode('tuning') }}
        >Re-run setup</button>
      {/if}

      <!-- Advanced -->
      <details class="advanced">
        <summary>Advanced</summary>
        <div class="advanced-body">
          <div class="field">
            <label for="max-rounds">Max Rounds</label>
            <input id="max-rounds" type="number" bind:value={draft.maxRounds} min="1" max="20" />
            <small>Max conversation rounds per session (default 8).</small>
          </div>
          <div class="field">
            <label for="proxy-url">CORS Proxy</label>
            <input id="proxy-url" type="text" bind:value={draft.proxyUrl} placeholder="https://your-proxy.workers.dev" />
            <small>Optional — only needed if you get CORS errors.</small>
          </div>
          <div class="field">
            <!-- svelte-ignore a11y_label_has_associated_control -->
            <label>Reset</label>
            {#if confirmingClear}
              <div class="confirm-row">
                <span class="confirm-msg">This will erase all settings, agents, and session history.</span>
                <button class="danger" onclick={clearLocalStorage}>Yes, clear everything</button>
                <button class="ghost" onclick={() => confirmingClear = false}>Cancel</button>
              </div>
            {:else}
              <button class="ghost danger-text" onclick={() => confirmingClear = true}>Clear local storage…</button>
            {/if}
          </div>
        </div>
      </details>

      <!-- Local setup hints -->
      {#if activeLLM.length === 1 && activeLLM[0].id === 'ollama' && fetchStatuses['ollama'] !== 'ok'}
        <div class="local-hint">
          <div class="hint-title">🦙 Getting started with Ollama</div>
          <div class="hint-steps">
            <div>1. Install from <strong>ollama.com</strong></div>
            <div>2. <code>ollama pull llama3.2</code> <span class="muted">(or any model)</span></div>
            <div>3. Click <strong>↺</strong> on the provider card to list installed models</div>
          </div>
        </div>
      {/if}
      {#if activeLLM.length === 1 && activeLLM[0].id === 'lmstudio' && fetchStatuses['lmstudio'] !== 'ok'}
        <div class="local-hint">
          <div class="hint-title">🖥 Getting started with LM Studio</div>
          <div class="hint-steps">
            <div>1. Install from <strong>lmstudio.ai</strong> and download a model</div>
            <div>2. Go to <strong>Local Server</strong> tab and click Start Server</div>
            <div>3. Click <strong>↺</strong> on the provider card to list loaded models</div>
          </div>
        </div>
      {/if}

    </div>

    <div class="modal-footer">
      <button class="ghost" onclick={onclose}>Cancel</button>
      <button class="primary" onclick={save} disabled={!canSave}>Save</button>
    </div>
  </div>
</div>

<style>
  .wide { max-width: 680px; }

  /* ── Provider grid ──────────────────────────────────────────────────────── */
  .p-order {
    position: absolute;
    top: 4px;
    right: 6px;
    font-size: 9px;
    font-weight: 700;
    font-family: var(--font-mono);
    color: var(--color-accent);
    background: rgba(63,185,80,0.15);
    width: 16px;
    height: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
  }

  .provider-desc {
    font-size: 12px;
    color: var(--color-text-3);
    margin-top: -8px;
    text-align: center;
  }

  /* ── Multi-provider config cards ─────────────────────────────────────── */
  .multi-provider-config {
    background: var(--glass);
    border: 1px solid var(--glass-border);
    border-radius: var(--radius);
    padding: 8px 10px;
    margin: 2px 0;
  }
  .mpc-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 12px;
    font-weight: 700;
    margin-bottom: 6px;
  }
  .mpc-fields {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .mpc-fields input, .mpc-fields select {
    flex: 1;
    font-size: 12px;
    padding: 4px 8px;
    height: auto;
    min-width: 0;
  }

  .optional {
    font-size: 10px;
    color: var(--color-text-4);
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
  }

  /* ── Advanced collapsible ───────────────────────────────────────────────── */
  .advanced {
    border: 1px solid var(--glass-border);
    border-radius: var(--radius);
    overflow: hidden;
  }
  summary {
    padding: 8px 12px;
    font-size: 12px;
    color: var(--color-text-3);
    cursor: pointer;
    user-select: none;
    list-style: none;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  summary::before { content: '›'; font-size: 14px; transition: transform var(--t-fast); }
  details[open] summary::before { transform: rotate(90deg); }
  summary:hover { color: var(--color-text); }
  .advanced-body {
    padding: 12px;
    border-top: 1px solid var(--glass-border);
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  /* ── WebLLM info ────────────────────────────────────────────────────────── */
  .webllm-info {
    border-radius: var(--radius);
    padding: 8px 10px;
    margin-bottom: 6px;
    font-size: 12px;
  }
  .webllm-info.gpu-ok  { background: var(--glass-tinted); border: 1px solid var(--glass-tinted-border); }
  .webllm-info.gpu-err { background: rgba(255,90,90,0.06); border: 1px solid rgba(255,90,90,0.2); }
  .loaded-badge {
    font-size: 11px;
    margin-top: 4px;
    color: var(--color-accent);
    padding: 2px 6px;
    background: rgba(63,185,80,0.1);
    border: 1px solid rgba(63,185,80,0.2);
    border-radius: 4px;
    display: inline-block;
  }

  /* ── Local hint ─────────────────────────────────────────────────────────── */
  .local-hint {
    background: var(--glass);
    border: 1px solid var(--glass-border);
    border-radius: var(--radius);
    padding: 12px 14px;
  }
  .hint-title {
    font-size: 12px;
    font-weight: 700;
    color: var(--color-text-2);
    margin-bottom: 8px;
  }
  .hint-steps {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: var(--color-text-3);
    line-height: 1.6;
  }
  code {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--color-accent-2);
    background: var(--glass-blue);
    border: 1px solid var(--glass-blue-border);
    padding: 1px 5px;
    border-radius: 3px;
  }

  /* ── Browser tools toggle ─────────────────────────────────────────────── */
  .toggle-row {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 13px;
    cursor: pointer;
  }
  .toggle-switch {
    position: relative;
    display: inline-flex;
    flex-shrink: 0;
  }
  .toggle-switch input {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
  }
  .toggle-track {
    width: 34px;
    height: 18px;
    border-radius: 9px;
    background: var(--glass-border);
    border: 1px solid var(--glass-border);
    transition: background var(--t-fast), border-color var(--t-fast);
    display: flex;
    align-items: center;
    padding: 2px;
  }
  .toggle-knob {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--color-text-3);
    transition: transform var(--t-fast), background var(--t-fast);
    transform: translateX(0);
  }
  .toggle-switch.on .toggle-track {
    background: rgba(63,185,80,0.2);
    border-color: rgba(63,185,80,0.35);
  }
  .toggle-switch.on .toggle-knob {
    background: var(--color-accent);
    transform: translateX(14px);
  }
  .browser-hint {
    font-size: 12px;
    padding: 8px 10px;
    border-radius: var(--radius);
  }
  .browser-hint.sidecar-ok {
    background: var(--glass-tinted);
    border: 1px solid var(--glass-tinted-border);
    color: var(--color-accent);
  }
  .browser-hint.sidecar-err {
    background: rgba(255,90,90,0.06);
    border: 1px solid rgba(255,90,90,0.2);
    color: #f85149;
  }
  .browser-hint.sidecar-checking {
    background: var(--glass);
    border: 1px solid var(--glass-border);
    color: var(--color-text-3);
  }

  /* ── Search grid column override ─────────────────────────────────────── */
  .search-grid {
    grid-template-columns: repeat(3, 1fr);
  }

  .confirm-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .confirm-msg {
    font-size: 12px;
    color: var(--color-accent-err, #f85149);
    width: 100%;
  }
  .danger {
    background: rgba(248,81,73,0.15);
    border: 1px solid rgba(248,81,73,0.4);
    color: #f85149;
    padding: 6px 14px;
    border-radius: var(--radius);
    cursor: pointer;
    font-size: 12px;
    font-weight: 600;
  }
  .danger:hover { background: rgba(248,81,73,0.25); }
  .danger-text { color: #f85149; }
  .setup-btn {
    font-size: 12px;
    width: 100%;
    text-align: left;
    padding: 8px 12px;
    border: 1px solid var(--glass-border);
    border-radius: var(--radius);
    background: var(--glass);
    color: var(--color-text-2);
    cursor: pointer;
  }
  .setup-btn:hover { color: var(--color-accent); border-color: rgba(63,185,80,0.3); }
</style>
