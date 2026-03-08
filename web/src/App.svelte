<script lang="ts">
  import { onMount } from 'svelte'
  import { marked } from 'marked'
  import { store } from './lib/store.svelte'
  import { SEARCH_PROVIDERS } from './lib/types'
  import type { SearchProvider } from './lib/types'
  import AgentCard from './components/AgentCard.svelte'
  import AgentPanel from './components/AgentPanel.svelte'
  import ActivityMonitor from './components/ActivityMonitor.svelte'
  import SettingsModal from './components/SettingsModal.svelte'
  import AgentEditModal from './components/AgentEditModal.svelte'
  import FileTree from './components/FileTree.svelte'
  import CodeViewer from './components/CodeViewer.svelte'
  import NewModeModal from './components/NewModeModal.svelte'
  import SessionHistory from './components/SessionHistory.svelte'
  import HelpModal from './components/HelpModal.svelte'
  import { formatOutputAsMarkdown, cleanOutputForCopy } from './lib/cleanContent'
  import { enhanceProse } from './lib/tableCards'
  import { sanitizeHtml } from './lib/sanitize'

  // Configure marked for safe output
  marked.setOptions({ breaks: true, gfm: true })

  onMount(() => {
    store.initSession()
  })

  const selectedAgent = $derived(
    store.selectedAgentId
      ? store.agentStates.find((a) => a.id === store.selectedAgentId) ?? null
      : null,
  )

  const isEngineering = $derived(store.appMode === 'engineering')

  // Right panel: prefer code viewer in engineering mode when a file is selected
  const showCodeViewer = $derived(isEngineering && store.selectedFile !== null)
  const showAgentPanel = $derived(selectedAgent !== null && !showCodeViewer)

  // Help modal — auto-show on first visit
  let showHelp = $state(!localStorage.getItem('gremlin_help_seen'))
  function closeHelp() {
    showHelp = false
    localStorage.setItem('gremlin_help_seen', '1')
  }

  // History modal
  let showHistory = $state(false)

  // Final output rendering (shown inline in Activity Monitor)
  const outputHtml = $derived(store.output
    ? sanitizeHtml(enhanceProse(marked.parse(formatOutputAsMarkdown(store.output)) as string))
    : ''
  )

  function copyOutput() {
    if (store.output) navigator.clipboard.writeText(cleanOutputForCopy(store.output))
  }

  function handleReply(text: string) {
    store.followUp(text)
  }

  // Run or follow-up: if there's an existing session, continue it; otherwise start fresh
  function runOrFollowUp() {
    if (store.messages.length > 0) {
      store.followUp(store.task)
    } else {
      store.startRun()
    }
  }

  // Session import
  let importInput: HTMLInputElement | undefined = $state()

  // Image attach
  let fileInput: HTMLInputElement | undefined = $state()
  let isDraggingFile = $state(false)

  // Live input during runs
  let liveInput = $state('')

  function sendLiveMessage() {
    const text = liveInput.trim()
    if (!text || !store.isRunning) return
    const orchestrator = store.agentConfigs.find((a) => a.role === 'orchestrator')
    if (!orchestrator) return
    store.injectHumanMessage(orchestrator.id, text)
    liveInput = ''
  }
</script>

<!-- ── Modals ── -->
{#if showHistory}
  <SessionHistory onclose={() => (showHistory = false)} />
{/if}
{#if showHelp}
  <HelpModal onclose={closeHelp} openSettings={() => (store.showSettings = true)} />
{/if}
{#if store.showSettings}
  <SettingsModal onclose={() => (store.showSettings = false)} />
{/if}
{#if store.showAgentEdit !== null}
  <AgentEditModal
    agentId={store.showAgentEdit}
    onclose={() => {
      const wasSuggestion = store.showAgentEdit?.startsWith('__new__:')
      store.showAgentEdit = null
      if (!wasSuggestion) store.clearSession()
    }}
  />
{/if}
{#if store.showModeCreate}
  <NewModeModal onclose={() => (store.showModeCreate = false)} />
{/if}

{#if store.pendingAgentSuggestion && store.showAgentEdit === null}
  {@const names = store.pendingAgentSuggestion.name.split(', ')}
  <div class="modal-backdrop" role="dialog" aria-modal="true">
    <div class="modal suggest-modal">
      <div class="modal-header">
        {names.length === 1 ? 'Agent Not Found' : `${names.length} Agents Not Found`}
      </div>
      <div class="modal-body">
        <p>
          {#if names.length === 1}
            An agent tried to message <strong>"{names[0]}"</strong>, which doesn't exist.
          {:else}
            Agents tried to message these names which don't exist:
          {/if}
        </p>
        {#if names.length > 1}
          <ul class="suggest-names">
            {#each names as n}
              <li><strong>{n}</strong></li>
            {/each}
          </ul>
        {/if}
        <p class="suggest-hint">Create the first one now, or skip all to continue. Subsequent unknown names this session will be auto-skipped.</p>
      </div>
      <div class="modal-footer">
        <button class="ghost" onclick={() => store.dismissAgentSuggestion()}>Skip All</button>
        <button class="primary" onclick={() => store.acceptAgentSuggestion()}>Create "{names[0]}"</button>
      </div>
    </div>
  </div>
{/if}

{#if store.pendingSearchSetup}
  <div class="modal-backdrop" role="dialog" aria-modal="true">
    <div class="modal search-setup-modal">
      <div class="modal-header">
        Web Search Not Configured
      </div>
      <div class="modal-body">
        <p>An agent wants to search the web but no search provider is set up. Pick one to continue:</p>
        <div class="search-provider-grid">
          {#each SEARCH_PROVIDERS as p (p.id)}
            <button
              class="search-provider-btn"
              class:active={store.settings.searchProvider === p.id}
              onclick={() => {
                store.updateSettings({ searchProvider: p.id, searchEndpoint: p.endpoint || store.settings.searchEndpoint })
              }}
            >
              <span class="sp-icon">{p.icon}</span>
              <span class="sp-name">{p.name}</span>
              <span class="sp-desc">{p.description}</span>
            </button>
          {/each}
        </div>
        {#if store.settings.searchProvider}
          {@const sp = SEARCH_PROVIDERS.find((p) => p.id === store.settings.searchProvider)}
          {#if sp?.requiresKey}
            <div class="field" style="margin-top:12px">
              <label for="search-key-modal">API Key</label>
              <input
                id="search-key-modal"
                type="password"
                value={store.settings.searchApiKey}
                oninput={(e) => store.updateSettings({ searchApiKey: (e.target as HTMLInputElement).value })}
                placeholder="Paste your API key…"
                autocomplete="off"
              />
            </div>
          {/if}
          {#if sp?.requiresEndpoint}
            <div class="field" style="margin-top:12px">
              <label for="search-endpoint-modal">Instance URL</label>
              <input
                id="search-endpoint-modal"
                type="text"
                value={store.settings.searchEndpoint}
                oninput={(e) => store.updateSettings({ searchEndpoint: (e.target as HTMLInputElement).value })}
                placeholder="https://your-searxng.example.com"
              />
            </div>
          {/if}
        {/if}
      </div>
      <div class="modal-footer">
        <button class="ghost" onclick={() => store.cancelSearchSetup()}>Skip</button>
        <button
          class="primary"
          disabled={!store.settings.searchProvider}
          onclick={() => store.resolveSearchSetup()}
        >Save & Search</button>
      </div>
    </div>
  </div>
{/if}

{#if store.pendingRoundsExhausted}
  {@const exhausted = store.pendingRoundsExhausted}
  {@const extraRoundsDefault = 5}
  <div class="modal-backdrop" role="dialog" aria-modal="true">
    <div class="modal rounds-modal">
      <div class="modal-header">
        Round Limit Reached
        <span class="rounds-badge">{exhausted.currentRound} / {exhausted.maxRounds}</span>
      </div>
      <div class="modal-body">
        <p>Agents have used all {exhausted.maxRounds} rounds but the synthesizer hasn't produced a final result yet.</p>
        <div class="field">
          <label for="extra-instruction">Additional instructions <span class="optional">(optional)</span></label>
          <input
            id="extra-instruction"
            type="text"
            placeholder="e.g. Focus on risk analysis, wrap up…"
            onkeydown={(e) => {
              if (e.key === 'Enter') store.continueWithRounds(extraRoundsDefault, (e.target as HTMLInputElement).value)
            }}
          />
        </div>
      </div>
      <div class="modal-footer">
        <button class="ghost" onclick={() => store.synthesizeNow()}>Synthesize Now</button>
        <button class="primary" onclick={() => {
          const input = document.getElementById('extra-instruction') as HTMLInputElement
          store.continueWithRounds(extraRoundsDefault, input?.value ?? '')
        }}>+ {extraRoundsDefault} Rounds</button>
      </div>
    </div>
  </div>
{/if}

<!-- ── App shell ── -->
<div class="app">

  <!-- ── Navbar ── -->
  <nav class="navbar">
    <div class="nav-inner">
      <!-- Brand -->
      <div class="nav-brand">
        <span class="brand-icon">⚡</span>
        <span class="brand-name">GREMLIN</span>
      </div>

      <!-- Task input / Live input -->
      <div class="nav-task">
        {#if store.isRunning}
          <div class="live-input-wrap">
            <input
              class="task-input live"
              type="text"
              placeholder="Send a message to the running swarm… (Enter to send)"
              bind:value={liveInput}
              onkeydown={(e) => e.key === 'Enter' && sendLiveMessage()}
            />
            <button
              class="primary btn-xs"
              onclick={sendLiveMessage}
              disabled={!liveInput.trim()}
            >Send</button>
          </div>
        {:else}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="task-input-wrap"
            class:dragover={isDraggingFile}
            ondragover={(e) => { e.preventDefault(); isDraggingFile = true }}
            ondragleave={() => { isDraggingFile = false }}
            ondrop={async (e) => {
              e.preventDefault()
              isDraggingFile = false
              const files = e.dataTransfer?.files
              if (files) for (const f of files) await store.addAttachment(f)
            }}
          >
            <input
              class="task-input"
              type="text"
              list="task-history"
              placeholder="Enter a task for the agent swarm…  (Enter to run)"
              value={store.task}
              oninput={(e) => {
                store.task = (e.target as HTMLInputElement).value
                store.saveTask()
              }}
              onkeydown={(e) => e.key === 'Enter' && store.settings.model.trim() && runOrFollowUp()}
              onpaste={async (e) => {
                const items = e.clipboardData?.items
                if (!items) return
                for (const item of items) {
                  if (item.kind === 'file' && item.type.startsWith('image/')) {
                    const file = item.getAsFile()
                    if (file) await store.addAttachment(file)
                  }
                }
              }}
            />
            <button
              class="ghost icon btn-attach"
              onclick={() => fileInput?.click()}
              title="Attach images (or drag & drop / paste)"
              aria-label="Attach images"
            >📎</button>
            <input
              bind:this={fileInput}
              type="file"
              accept="image/*"
              multiple
              style="display:none"
              onchange={async (e) => {
                const files = (e.target as HTMLInputElement).files
                if (files) for (const f of files) await store.addAttachment(f)
                ;(e.target as HTMLInputElement).value = ''
              }}
            />
          </div>
          <datalist id="task-history">
            {#each store.taskHistory as t}
              <option value={t}>{t}</option>
            {/each}
          </datalist>
          {#if store.attachments.length > 0}
            <div class="attachment-strip">
              {#each store.attachments as att, i}
                <div class="attachment-thumb">
                  <img src="data:{att.mimeType};base64,{att.base64}" alt={att.name ?? 'attachment'} />
                  <button class="ghost icon thumb-remove" onclick={() => store.removeAttachment(i)} aria-label="Remove attachment">✕</button>
                </div>
              {/each}
            </div>
          {/if}
        {/if}
      </div>

      <!-- Controls -->
      <div class="nav-controls">
        {#if !store.settings.model.trim()}
          <button
            class="warn btn-sm"
            onclick={() => (store.showSettings = true)}
            title="No model configured — click to open Settings"
          >Set Model</button>
        {/if}
        {#if isEngineering}
          {#if store.projectDirName}
            <div class="folder-badge" title="Project folder: {store.projectDirName}">
              <span>📁</span>
              <span class="folder-name">{store.projectDirName}</span>
              <button class="ghost icon btn-folder-close" onclick={() => store.closeProjectFolder()} title="Close folder">✕</button>
            </div>
          {:else}
            <button class="ghost" onclick={() => store.openProjectFolder()} title="Select project directory for file access">
              📁 Open Folder
            </button>
          {/if}
        {/if}
        <button
          class="ghost"
          onclick={() => { store.clearSession() }}
          disabled={store.isRunning}
          title="Clear session"
        >↺ Clear</button>
        {#if store.messages.length > 0 && !store.isRunning}
          <button
            class="ghost btn-sm"
            onclick={() => store.exportSession()}
            title="Export session as JSON"
            aria-label="Export session"
          >Export</button>
        {/if}
        <button
          class="ghost btn-sm"
          onclick={() => importInput?.click()}
          title="Import a saved session"
          aria-label="Import session"
        >Import</button>
        <input
          bind:this={importInput}
          type="file"
          accept=".json"
          style="display:none"
          onchange={async (e) => {
            const file = (e.target as HTMLInputElement).files?.[0]
            if (file) await store.importSession(file)
            ;(e.target as HTMLInputElement).value = ''
          }}
        />
        <button
          class="ghost icon btn-settings"
          onclick={() => (showHistory = true)}
          title="Session history"
          aria-label="Session history"
        >🕐</button>
        <button
          class="ghost icon btn-settings"
          onclick={() => (showHelp = true)}
          title="Help"
          aria-label="Help"
        >?</button>
        <button
          class="ghost icon btn-settings"
          onclick={() => (store.showSettings = true)}
          title="Settings"
          aria-label="Settings"
        >⚙</button>
        {#if store.isRunning}
          <button class="danger" onclick={() => store.stopRun()} aria-label="Stop run">⏹ Stop</button>
        {:else}
          <button
            class="primary run-btn"
            onclick={() => runOrFollowUp()}
            disabled={!store.task.trim() || !store.settings.model.trim()}
            title={!store.settings.model.trim() ? 'No model selected — open Settings' : 'Run (Enter)'}
          >▶ Run</button>
        {/if}
      </div>
    </div>

    <!-- shimmer line under nav -->
    <div class="nav-shimmer"></div>
  </nav>

  <!-- ── WebLLM progress bar (shown while downloading/initialising a model) ── -->
  {#if store.webllmProgress}
    <div class="webllm-progress">
      <div class="webllm-track">
        <div class="webllm-fill" style="width:{Math.round(store.webllmProgress.progress * 100)}%"></div>
      </div>
      <span class="webllm-text">{store.webllmProgress.text}</span>
    </div>
  {/if}

  <!-- ── Mode bar ── -->
  <div class="mode-bar">
    <div class="mode-tabs">
      {#each store.allModes as mode (mode.id)}
        <div class="mode-tab-wrap">
          <button
            class="mode-tab"
            class:active={store.appMode === mode.id}
            onclick={() => store.switchMode(mode.id)}
            disabled={store.isRunning}
            title={mode.description}
          >
            <span class="mode-icon">{mode.icon}</span>
            <span class="mode-name">{mode.name}</span>
          </button>
          {#if !mode.builtin}
            <button
              class="mode-del"
              onclick={() => store.deleteCustomMode(mode.id)}
              title="Delete mode"
              tabindex="-1"
            >✕</button>
          {/if}
        </div>
      {/each}
      <button
        class="mode-tab add-mode"
        onclick={() => (store.showModeCreate = true)}
        disabled={store.isRunning}
        title="Create a new mode"
      >
        <span class="mode-icon">＋</span>
        <span class="mode-name">New Mode</span>
      </button>
    </div>
    {#if store.currentModeInfo.description}
      <span class="mode-desc muted">{store.currentModeInfo.description}</span>
    {/if}
  </div>

  <!-- ── Restored session banner ── -->
  {#if store.restoredSessionId}
    <div class="restored-banner">
      <span class="restored-text">Viewing past session</span>
      <button class="ghost btn-sm" onclick={() => store.clearSession()}>Close</button>
    </div>
  {/if}

  <!-- ── Main workspace ── -->
  <div class="workspace">

    <!-- Left sidebar: agents + (in engineering mode) file tree -->
    <aside class="sidebar">
      <div class="sidebar-head">
        <span class="sidebar-label">Agents</span>
        <button
          class="ghost icon"
          onclick={() => (store.showAgentEdit = '__new__')}
          disabled={store.isRunning}
          title="Add agent"
          aria-label="Add agent"
        >＋</button>
      </div>

      <div class="agent-list">
        {#each store.agentStates as agent (agent.id)}
          <AgentCard
            {agent}
            selected={store.selectedAgentId === agent.id}
            onclick={() => {
              store.selectedAgentId = store.selectedAgentId === agent.id ? null : agent.id
              if (store.selectedAgentId) store.selectedFile = null
            }}
            onedit={() => (store.showAgentEdit = agent.id)}
            onretry={() => store.retryAgent(agent.id)}
          />
        {/each}

        {#if store.agentStates.length === 0}
          <div class="empty-agents muted">
            No agents yet.
            <button class="ghost btn-full" onclick={() => (store.showAgentEdit = '__new__')}>
              + Add agent
            </button>
          </div>
        {/if}
      </div>

      <div class="sidebar-foot">
        <button
          class="ghost btn-full btn-sm"
          onclick={() => { store.resetAgents(); store.clearSession() }}
          disabled={store.isRunning}
          title="Restore default agents for this mode"
        >↺ Reset agents</button>
      </div>


      <!-- File tree section (engineering mode only) -->
      {#if isEngineering && (store.projectDirName || store.writtenFiles.length > 0)}
        <div class="files-section">
          <div class="files-head">
            <span class="sidebar-label">Files</span>
            {#if store.projectDirName}
              <button
                class="ghost icon btn-refresh"
                onclick={() => store.refreshFiles()}
                title="Refresh file list"
              >↺</button>
            {/if}
          </div>
          <div class="files-tree">
            <FileTree
              files={store.writtenFiles}
              selectedFile={store.selectedFile}
              onselect={(p) => {
                store.selectedFile = p
                store.selectedAgentId = null
              }}
            />
          </div>
        </div>
      {/if}
    </aside>

    <!-- Center: activity monitor -->
    <div class="monitor-col">
      <ActivityMonitor
        messages={store.messages}
        agents={store.agentConfigs}
        logs={store.logs}
        streamingAgentId={store.streamingAgentId}
        streamingText={store.streamingText}
        outputHtml={outputHtml}
        isRunning={store.isRunning}
        onCopy={copyOutput}
        onReply={handleReply}
        onRetry={(agentId) => store.retryAgent(agentId)}
      />
    </div>

    <!-- Right: code viewer (engineering) OR agent panel -->
    {#if showCodeViewer}
      <div class="right-col">
        <CodeViewer
          path={store.selectedFile}
          onclose={() => (store.selectedFile = null)}
        />
      </div>
    {:else if showAgentPanel}
      <div class="right-col agent-panel-col">
        <AgentPanel
          agent={selectedAgent!}
          messages={store.messages}
          onclose={() => (store.selectedAgentId = null)}
        />
      </div>
    {/if}
  </div>


</div>

<style>
  /* ── App shell ─────────────────────────────────────────────────────────── */
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
    position: relative;
  }

  /* ── Navbar ────────────────────────────────────────────────────────────── */
  .navbar {
    position: relative;
    flex-shrink: 0;
    z-index: 20;
    background: rgba(9, 12, 18, 0.85);
    backdrop-filter: blur(var(--blur-strong)) saturate(180%);
    border-bottom: 1px solid var(--glass-border);
    box-shadow: var(--shadow-sm);
    overflow: hidden;
  }

  .navbar::before {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(
      145deg,
      var(--glass) 0%,
      transparent 25%,
      var(--glass-tinted) 50%,
      transparent 75%,
      var(--glass) 100%
    );
    pointer-events: none;
    animation: liquid-shimmer 5s ease-in-out infinite;
  }
  @keyframes liquid-shimmer {
    0%, 100% { opacity: 0.5; transform: translateX(-2px); }
    25%  { opacity: 0.8; transform: translateX(1px); }
    50%  { opacity: 0.6; }
    75%  { opacity: 0.9; transform: translateX(-1px); }
  }

  .nav-shimmer {
    position: absolute;
    bottom: 0; left: 0; right: 0;
    height: 1px;
    background: linear-gradient(90deg, transparent 0%, var(--color-accent) 30%, var(--color-accent-2) 60%, transparent 100%);
    opacity: 0.4;
    animation: shimmer-line 4s ease-in-out infinite;
  }
  @keyframes shimmer-line {
    0%, 100% { opacity: 0.2; transform: scaleX(0.7); }
    50% { opacity: 0.5; transform: scaleX(1); }
  }

  .nav-inner {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 9px 16px;
    min-height: 52px;
  }

  .nav-brand {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }
  .brand-icon { font-size: 18px; filter: drop-shadow(0 0 8px rgba(63,185,80,0.6)); }
  .brand-name {
    font-size: 15px;
    font-weight: 900;
    letter-spacing: 0.08em;
    color: var(--color-accent);
    text-shadow: 0 0 20px rgba(63,185,80,0.4);
    text-transform: uppercase;
  }

  .nav-task { flex: 1; min-width: 0; }
  .task-input-wrap {
    display: flex;
    align-items: center;
    gap: 0;
    position: relative;
  }
  .task-input-wrap.dragover {
    outline: 2px dashed var(--color-accent);
    outline-offset: -2px;
    border-radius: var(--radius);
  }
  .task-input-wrap .task-input {
    flex: 1;
    padding-right: 36px;
  }
  .btn-attach {
    position: absolute;
    right: 4px;
    top: 50%;
    transform: translateY(-50%);
    font-size: 16px;
    padding: 2px 4px;
    opacity: 0.5;
    z-index: 1;
  }
  .btn-attach:hover { opacity: 1; }
  .attachment-strip {
    display: flex;
    gap: 6px;
    padding: 6px 0 0;
    flex-wrap: wrap;
  }
  .attachment-thumb {
    position: relative;
    width: 48px;
    height: 48px;
    border-radius: 6px;
    overflow: hidden;
    border: 1px solid var(--glass-border);
    flex-shrink: 0;
  }
  .attachment-thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .thumb-remove {
    position: absolute;
    top: 0;
    right: 0;
    font-size: 10px;
    padding: 0 3px;
    background: rgba(0,0,0,0.7);
    color: var(--color-text);
    border-radius: 0 0 0 4px;
    line-height: 1.4;
  }
  .task-input {
    width: 100%;
    background: var(--glass);
    backdrop-filter: blur(var(--blur-subtle));
    border: 1px solid var(--glass-border);
    border-radius: var(--radius);
    color: var(--color-text);
    font-size: 14px;
    padding: 8px 14px;
    outline: none;
    transition: all var(--t-fast);
  }
  .task-input:hover  { background: var(--glass-light); border-color: var(--glass-light-border); }
  .task-input:focus  { background: var(--glass-tinted); border-color: var(--glass-tinted-border); box-shadow: 0 0 0 3px rgba(63,185,80,0.12); }
  .task-input:disabled { opacity: 0.5; }
  .task-input.live {
    border-color: rgba(88,166,255,0.4);
    background: rgba(88,166,255,0.06);
  }
  .task-input.live:focus {
    border-color: rgba(88,166,255,0.6);
    box-shadow: 0 0 0 3px rgba(88,166,255,0.12);
  }

  .live-input-wrap {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .live-input-wrap .task-input { flex: 1; }

  .nav-controls { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
  .run-btn { min-width: 80px; }

  .btn-xs { font-size: 11px; padding: 4px 10px; }
  .btn-sm { font-size: 11px; }
  .btn-full { margin-top: 6px; width: 100%; justify-content: center; }
  .btn-settings { font-size: 16px; }
  .btn-folder-close { padding: 0 2px; height: auto; font-size: 10px; }
  .btn-refresh { font-size: 11px; padding: 2px 4px; }

  .folder-badge {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 3px 8px;
    background: var(--glass-tinted);
    border: 1px solid var(--glass-tinted-border);
    border-radius: var(--radius);
    font-size: 11px;
    color: var(--color-accent);
    max-width: 160px;
  }
  .folder-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }

  /* ── WebLLM progress ──────────────────────────────────────────────────── */
  .webllm-progress {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 5px 16px;
    background: rgba(9, 12, 18, 0.7);
    border-bottom: 1px solid var(--glass-border);
    flex-shrink: 0;
  }
  .webllm-track {
    flex: 1;
    height: 4px;
    background: var(--glass);
    border-radius: 2px;
    overflow: hidden;
  }
  .webllm-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--color-accent), var(--color-accent-2));
    border-radius: 2px;
    transition: width 0.3s ease;
  }
  .webllm-text {
    font-size: 10.5px;
    color: var(--color-text-3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 360px;
    font-family: var(--font-mono);
  }

  /* ── Mode bar ──────────────────────────────────────────────────────────── */
  .mode-bar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 4px 16px;
    border-bottom: 1px solid var(--glass-border);
    background: rgba(9, 12, 18, 0.6);
    flex-shrink: 0;
    min-height: 36px;
  }

  .mode-tabs {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }

  .mode-tab-wrap {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .mode-tab {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 3px 10px;
    background: none;
    border: 1px solid transparent;
    border-radius: 6px;
    font-size: 12px;
    color: var(--color-text-3);
    cursor: pointer;
    transition: all var(--t-fast);
    height: auto;
  }
  .mode-tab:hover:not(:disabled) { color: var(--color-text); background: var(--glass); border-color: var(--glass-border); }
  .mode-tab.active {
    color: var(--color-accent);
    background: var(--glass-tinted);
    border-color: var(--glass-tinted-border);
  }
  .mode-tab:disabled { opacity: 0.4; cursor: not-allowed; }

  .mode-icon { font-size: 13px; line-height: 1; }
  .mode-name { font-weight: 600; }

  .mode-del {
    background: none;
    border: none;
    padding: 2px 4px;
    font-size: 9px;
    color: var(--color-text-4);
    cursor: pointer;
    line-height: 1;
    opacity: 0.5;
    height: auto;
    border-radius: 3px;
  }
  .mode-del:hover { opacity: 1; color: var(--color-accent-err); background: rgba(255,90,90,0.1); }

  .add-mode { border-style: dashed; }
  .add-mode:hover:not(:disabled) { border-style: solid; }

  .mode-desc {
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ── Restored session banner ────────────────────────────────────────────── */
  .restored-banner {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 4px 16px;
    background: var(--glass-tinted);
    border-bottom: 1px solid var(--glass-tinted-border);
    flex-shrink: 0;
  }
  .restored-text {
    font-size: 11px;
    font-weight: 600;
    color: var(--color-accent);
    letter-spacing: 0.03em;
  }

  /* ── Workspace ─────────────────────────────────────────────────────────── */
  .workspace { display: flex; flex: 1; overflow: hidden; }

  /* ── Sidebar ───────────────────────────────────────────────────────────── */
  .sidebar {
    width: 216px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--glass-border);
    background: rgba(9,12,18,0.5);
    backdrop-filter: blur(var(--blur-subtle));
    overflow: hidden;
  }

  .sidebar-head, .files-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    border-bottom: 1px solid var(--glass-border);
    flex-shrink: 0;
  }
  .sidebar-label {
    font-size: 10px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--color-text-4);
  }

  .agent-list {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 5px;
    min-height: 0;
  }

  .empty-agents { font-size: 12px; text-align: center; padding: 20px 8px; line-height: 1.9; }

  .sidebar-foot {
    padding: 8px;
    border-top: 1px solid var(--glass-border);
    flex-shrink: 0;
  }

  /* ── Files section (sidebar) ──────────────────────────────────────────── */
  .files-section {
    display: flex;
    flex-direction: column;
    border-top: 1px solid var(--glass-border);
    max-height: 40%;
    flex-shrink: 0;
  }
  .files-head { border-bottom: 1px solid var(--glass-border); }
  .files-tree { overflow-y: auto; flex: 1; }

  /* ── Monitor column ────────────────────────────────────────────────────── */
  .monitor-col { flex: 1; padding: 10px; overflow: hidden; min-width: 0; }

  /* ── Right column ──────────────────────────────────────────────────────── */
  .right-col {
    width: 380px;
    flex-shrink: 0;
    padding: 10px 10px 10px 0;
    overflow: hidden;
    animation: slide-in var(--t-smooth);
  }
  .agent-panel-col { width: 340px; }

  @keyframes slide-in {
    from { opacity: 0; transform: translateX(20px); }
    to   { opacity: 1; transform: translateX(0); }
  }

  /* ── Agent suggestion modal ──────────────────────────────────────────── */
  /* ── Search setup modal ─────────────────────────────────────────────── */
  .search-setup-modal { max-width: 500px; }
  .search-setup-modal p { margin: 0 0 12px; font-size: 13px; color: var(--color-text-2); line-height: 1.5; }
  .search-provider-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 7px;
  }
  .search-provider-btn {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
    padding: 10px 6px 8px;
    background: var(--glass);
    border: 1px solid var(--glass-border);
    border-radius: var(--radius);
    cursor: pointer;
    transition: all var(--t-fast);
    text-align: center;
  }
  .search-provider-btn:hover {
    background: var(--glass-light);
    border-color: var(--glass-light-border);
    transform: translateY(-1px);
  }
  .search-provider-btn.active {
    background: var(--glass-tinted);
    border-color: var(--glass-tinted-border);
    box-shadow: 0 0 0 1px rgba(63,185,80,0.25);
  }
  .sp-icon { font-size: 20px; line-height: 1; }
  .sp-name { font-size: 12px; font-weight: 700; color: var(--color-text); }
  .sp-desc { font-size: 10px; color: var(--color-text-3); }

  .suggest-modal {
    max-width: 420px;
  }
  .suggest-modal p {
    margin: 0 0 8px;
    font-size: 13px;
    color: var(--color-text-2);
    line-height: 1.5;
  }
  .suggest-hint {
    font-size: 12px !important;
    color: var(--color-text-3) !important;
  }
  .suggest-names {
    margin: 4px 0 8px;
    padding-left: 20px;
    font-size: 13px;
    color: var(--color-text-2);
    line-height: 1.6;
  }

  /* ── Rounds exhausted modal ────────────────────────────────────────── */
  .rounds-modal {
    max-width: 440px;
  }
  .rounds-modal p {
    margin: 0 0 12px;
    font-size: 13px;
    color: var(--color-text-2);
    line-height: 1.5;
  }
  .rounds-badge {
    font-size: 11px;
    font-weight: 700;
    font-family: var(--font-mono);
    padding: 2px 8px;
    border-radius: 4px;
    background: rgba(255,90,90,0.12);
    color: var(--color-accent-err);
    margin-left: 8px;
  }
  .optional {
    font-size: 10px;
    color: var(--color-text-4);
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
  }
</style>
