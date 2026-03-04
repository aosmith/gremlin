<script lang="ts">
  import { PROVIDERS, SEARCH_PROVIDERS } from '../lib/types'
  import type { Settings, ProviderPreset, SearchProvider } from '../lib/types'
  import { store } from '../lib/store.svelte'
  import { fetchOllamaModels, fetchOpenAIModels } from '../lib/api'
  import { isWebGPUAvailable, getLoadedModel } from '../lib/webllm'

  interface Props { onclose: () => void }
  const { onclose }: Props = $props()

  let draft = $state<Settings>({ ...store.settings })

  // ── Provider selection ─────────────────────────────────────────────────────
  function detectProvider(): string {
    if (draft.apiFormat === 'webllm') return 'webllm'
    for (const p of PROVIDERS) {
      if (p.id === 'custom' || p.id === 'webllm') continue
      if (p.endpoint && draft.apiEndpoint.startsWith(p.endpoint.split('/v1')[0].split('/api')[0])) return p.id
    }
    return 'custom'
  }

  let selectedProviderId = $state(detectProvider())
  const selectedProvider = $derived(PROVIDERS.find((p) => p.id === selectedProviderId)!)
  const isWebLLM = $derived(selectedProviderId === 'webllm')
  const webgpuOk = isWebGPUAvailable()
  const loadedModel = $derived(getLoadedModel())

  function pickProvider(p: ProviderPreset) {
    selectedProviderId = p.id
    if (p.endpoint) draft.apiEndpoint = p.endpoint
    draft.apiFormat = p.format
    draft.model = p.defaultModel
    if (!p.requiresKey) draft.apiKey = draft.apiKey  // keep existing key if already set
    dynamicModels = []
    fetchStatus = 'idle'
  }

  // ── Dynamic model fetching ─────────────────────────────────────────────────
  let dynamicModels = $state<string[]>([])
  let fetchStatus = $state<'idle' | 'loading' | 'ok' | 'error'>('idle')
  let fetchError = $state('')

  async function discoverModels() {
    fetchStatus = 'loading'
    fetchError = ''
    try {
      if (selectedProviderId === 'ollama') {
        dynamicModels = await fetchOllamaModels(draft.apiEndpoint)
      } else {
        dynamicModels = await fetchOpenAIModels(draft.apiEndpoint, draft.apiKey)
      }
      if (dynamicModels.length > 0 && !dynamicModels.includes(draft.model)) {
        draft.model = dynamicModels[0]
      }
      fetchStatus = 'ok'
    } catch (e) {
      fetchError = e instanceof Error ? e.message : String(e)
      fetchStatus = 'error'
    }
  }

  const modelList = $derived(
    dynamicModels.length > 0 ? dynamicModels : selectedProvider?.models ?? []
  )

  const needsKey = $derived(selectedProvider?.requiresKey ?? true)
  const isLocal  = $derived(selectedProvider?.kind === 'local')

  // ── Search provider selection ─────────────────────────────────────────────
  let searchProviderId = $state(draft.searchProvider || '')
  const selectedSearch = $derived(SEARCH_PROVIDERS.find((p) => p.id === searchProviderId))

  function pickSearchProvider(p: SearchProvider | null) {
    if (!p) {
      searchProviderId = ''
      draft.searchProvider = ''
      return
    }
    searchProviderId = p.id
    draft.searchProvider = p.id
    if (p.endpoint) draft.searchEndpoint = p.endpoint
  }

  let confirmingClear = $state(false)

  function clearLocalStorage() {
    localStorage.clear()
    location.reload()
  }

  function save() {
    store.updateSettings(draft)
    onclose()
  }
</script>

<div class="modal-backdrop" role="dialog" aria-modal="true">
  <div class="modal wide">
    <div class="modal-header">
      ⚙ Settings — LLM Provider
      <button class="ghost icon" onclick={onclose}>✕</button>
    </div>

    <div class="modal-body">

      <!-- Provider grid -->
      <div class="field">
        <!-- svelte-ignore a11y_label_has_associated_control -->
        <label>Provider</label>
        <div class="provider-grid">
          {#each PROVIDERS as p (p.id)}
            <button
              class="provider-btn"
              class:active={selectedProviderId === p.id}
              onclick={() => pickProvider(p)}
              title={p.description}
            >
              <span class="p-icon">{p.icon}</span>
              <span class="p-name">{p.name}</span>
              <span class="p-kind {p.kind}">{p.kind}</span>
            </button>
          {/each}
        </div>
      </div>

      {#if selectedProvider}
        <div class="provider-desc">{selectedProvider.description}</div>
      {/if}

      <!-- Model selection -->
      <div class="field">
        <!-- svelte-ignore a11y_label_has_associated_control -->
        <label>Model</label>
        <div class="model-row">
          {#if modelList.length > 0}
            <select bind:value={draft.model} style="flex:1">
              {#each modelList as m}
                <option value={m}>{m}</option>
              {/each}
            </select>
          {:else}
            <input
              type="text"
              bind:value={draft.model}
              placeholder={selectedProvider?.defaultModel || 'model-name'}
              style="flex:1"
            />
          {/if}
          {#if isLocal || selectedProviderId === 'lmstudio' || selectedProviderId === 'openrouter'}
            <button
              class="ghost"
              onclick={discoverModels}
              disabled={fetchStatus === 'loading'}
              title="Fetch available models from the endpoint"
            >
              {fetchStatus === 'loading' ? '⟳' : '↺ Discover'}
            </button>
          {/if}
        </div>
        {#if fetchStatus === 'ok'}
          <small style="color:var(--color-accent)">✓ Found {modelList.length} model{modelList.length !== 1 ? 's' : ''}</small>
        {:else if fetchStatus === 'error'}
          <small style="color:var(--color-accent-err)">✖ {fetchError} — is the server running?</small>
        {:else if isLocal}
          <small>
            {selectedProviderId === 'ollama'
              ? 'Click ↺ Discover to list installed models, or run: ollama pull <model>'
              : 'Start LM Studio server, then click ↺ Discover'}
          </small>
        {/if}
      </div>

      <!-- WebLLM info / status -->
      {#if isWebLLM}
        <div class="webllm-info" class:gpu-ok={webgpuOk} class:gpu-err={!webgpuOk}>
          {#if webgpuOk}
            <div class="hint-title">🌐 WebLLM — in-browser inference via WebGPU</div>
            <div class="hint-steps">
              <div>• No server or API key required — models run fully on your GPU</div>
              <div>• First run downloads the model to your browser cache (~500 MB – 4 GB)</div>
              <div>• Subsequent runs load instantly from cache</div>
              {#if loadedModel}
                <div class="loaded-badge">✓ Loaded: <strong>{loadedModel}</strong></div>
              {/if}
            </div>
          {:else}
            <div class="hint-title">⚠ WebGPU not available</div>
            <div class="hint-steps">
              <div>Your browser does not support WebGPU. Try <strong>Chrome 113+</strong> or <strong>Edge 113+</strong>.</div>
              <div>Safari and Firefox do not yet support WebGPU by default.</div>
            </div>
          {/if}
        </div>
      {/if}

      <!-- API Key (not shown for WebLLM) -->
      {#if !isWebLLM && (needsKey || draft.apiKey)}
        <div class="field">
          <label for="api-key">
            API Key
            {#if !needsKey}<span class="optional">(optional)</span>{/if}
          </label>
          <input
            id="api-key"
            type="password"
            bind:value={draft.apiKey}
            placeholder={needsKey ? 'Paste your API key…' : 'Leave blank for local/no-auth'}
            autocomplete="off"
          />
          {#if selectedProviderId === 'openrouter'}
            <small>Free tier available at <strong>openrouter.ai</strong> — access 50+ free models with no billing</small>
          {:else if selectedProviderId === 'groq'}
            <small>Free tier at <strong>console.groq.com</strong></small>
          {:else if selectedProviderId === 'gemini'}
            <small>Free tier at <strong>aistudio.google.com</strong></small>
          {:else}
            <small>Stored only in localStorage — never logged or sent anywhere except your chosen endpoint.</small>
          {/if}
        </div>
      {/if}

      <!-- Search provider -->
      <div class="section-divider">Web Search (agents)</div>
      <div class="field">
        <!-- svelte-ignore a11y_label_has_associated_control -->
        <label>Search Provider</label>
        <div class="provider-grid search-grid">
          <button
            class="provider-btn"
            class:active={!searchProviderId}
            onclick={() => pickSearchProvider(null)}
            title="Disabled"
          >
            <span class="p-icon">—</span>
            <span class="p-name">None</span>
          </button>
          {#each SEARCH_PROVIDERS as p (p.id)}
            <button
              class="provider-btn"
              class:active={searchProviderId === p.id}
              onclick={() => pickSearchProvider(p)}
              title={p.description}
            >
              <span class="p-icon">{p.icon}</span>
              <span class="p-name">{p.name}</span>
            </button>
          {/each}
        </div>
      </div>

      {#if selectedSearch}
        <div class="provider-desc">{selectedSearch.description}</div>
      {/if}

      {#if selectedSearch?.requiresKey}
        <div class="field">
          <label for="search-key">Search API Key</label>
          <input
            id="search-key"
            type="password"
            bind:value={draft.searchApiKey}
            placeholder="Paste your API key…"
            autocomplete="off"
          />
          {#if searchProviderId === 'brave'}
            <small>Get a free key at <strong>api.search.brave.com</strong></small>
          {:else if searchProviderId === 'serper'}
            <small>Get a free key at <strong>serper.dev</strong></small>
          {:else if searchProviderId === 'tavily'}
            <small>Get a free key at <strong>tavily.com</strong></small>
          {/if}
        </div>
      {/if}

      {#if selectedSearch?.requiresEndpoint}
        <div class="field">
          <label for="search-endpoint">Instance URL</label>
          <input
            id="search-endpoint"
            type="text"
            bind:value={draft.searchEndpoint}
            placeholder="https://your-searxng.example.com"
          />
          <small>Your self-hosted SearXNG instance URL</small>
        </div>
      {/if}

      <!-- Endpoint (advanced) — not shown for WebLLM -->
      {#if !isWebLLM}
        <details class="advanced">
          <summary>Advanced</summary>
          <div class="advanced-body">
            <div class="field">
              <label for="endpoint">Endpoint URL</label>
              <input id="endpoint" type="text" bind:value={draft.apiEndpoint} />
            </div>
            <div class="field">
              <label for="format">API Format</label>
              <select id="format" bind:value={draft.apiFormat}>
                <option value="openai">OpenAI-compatible</option>
                <option value="anthropic">Anthropic</option>
                <option value="gemini">Google Gemini</option>
              </select>
            </div>
            <div class="field">
              <label for="max-rounds">Max Rounds</label>
              <input id="max-rounds" type="number" bind:value={draft.maxRounds} min="1" max="20" />
              <small>Max conversation rounds per session (default 8).</small>
            </div>
            <div class="field">
              <label for="proxy-url">CORS Proxy</label>
              <input id="proxy-url" type="text" bind:value={draft.proxyUrl} placeholder="https://your-proxy.workers.dev" />
              <small>Optional — only needed if you get CORS errors. Deploy your own with the included Cloudflare Worker.</small>
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
      {/if}

      <!-- Local setup hint (Ollama / LM Studio only) -->
      {#if isLocal && !isWebLLM && fetchStatus !== 'ok'}
        <div class="local-hint">
          {#if selectedProviderId === 'ollama'}
            <div class="hint-title">🦙 Getting started with Ollama</div>
            <div class="hint-steps">
              <div>1. Install from <strong>ollama.com</strong></div>
              <div>2. <code>ollama pull llama3.2</code> <span class="muted">(or any model)</span></div>
              <div>3. Click <strong>↺ Discover</strong> above to list installed models</div>
            </div>
          {:else}
            <div class="hint-title">🖥 Getting started with LM Studio</div>
            <div class="hint-steps">
              <div>1. Install from <strong>lmstudio.ai</strong> and download a model</div>
              <div>2. Go to <strong>Local Server</strong> tab and click Start Server</div>
              <div>3. Click <strong>↺ Discover</strong> above to list loaded models</div>
            </div>
          {/if}
        </div>
      {/if}

    </div>

    <div class="modal-footer">
      <button class="ghost" onclick={onclose}>Cancel</button>
      <button class="primary" onclick={save} disabled={!isWebLLM && !draft.model.trim()}>Save</button>
    </div>
  </div>
</div>

<style>
  .wide { max-width: 680px; }

  /* ── Provider grid ──────────────────────────────────────────────────────── */
  .provider-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 7px;
  }

  .provider-btn {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 10px 6px 8px;
    background: var(--glass);
    border: 1px solid var(--glass-border);
    border-radius: var(--radius);
    cursor: pointer;
    transition: all var(--t-fast);
    height: auto;
    text-align: center;
  }
  .provider-btn:hover {
    background: var(--glass-light);
    border-color: var(--glass-light-border);
    transform: translateY(-1px);
  }
  .provider-btn.active {
    background: var(--glass-tinted);
    border-color: var(--glass-tinted-border);
    box-shadow: 0 0 0 1px rgba(63,185,80,0.25);
  }

  .p-icon { font-size: 20px; line-height: 1; }
  .p-name { font-size: 12px; font-weight: 700; color: var(--color-text); }
  .p-kind {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 1px 5px;
    border-radius: 3px;
  }
  .p-kind.local { background: rgba(63,185,80,0.15);   color: var(--color-accent); }
  .p-kind.cloud { background: rgba(88,166,255,0.12); color: var(--color-accent-2); }

  .provider-desc {
    font-size: 12px;
    color: var(--color-text-3);
    margin-top: -8px;
    text-align: center;
  }

  /* ── Model row ──────────────────────────────────────────────────────────── */
  .model-row {
    display: flex;
    gap: 8px;
    align-items: stretch;
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
    padding: 12px 14px;
  }
  .webllm-info.gpu-ok  { background: var(--glass-tinted); border: 1px solid var(--glass-tinted-border); }
  .webllm-info.gpu-err { background: rgba(255,90,90,0.06); border: 1px solid rgba(255,90,90,0.2); }
  .loaded-badge {
    font-size: 11px;
    margin-top: 6px;
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

  /* ── Clear storage ─────────────────────────────────────────────────────── */
  /* ── Search provider section ──────────────────────────────────────────── */
  .section-divider {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-text-3);
    border-top: 1px solid var(--glass-border);
    padding-top: 14px;
    margin-top: 4px;
  }
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
</style>
