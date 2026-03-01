<script lang="ts">
  import { onMount } from 'svelte'
  import { store } from './lib/store.svelte'
  import { initCoordinator } from './lib/coordinator'
  import AgentCard from './components/AgentCard.svelte'
  import AgentPanel from './components/AgentPanel.svelte'
  import ActivityMonitor from './components/ActivityMonitor.svelte'
  import SettingsModal from './components/SettingsModal.svelte'
  import AgentEditModal from './components/AgentEditModal.svelte'
  import FileTree from './components/FileTree.svelte'
  import CodeViewer from './components/CodeViewer.svelte'
  import NewModeModal from './components/NewModeModal.svelte'

  onMount(async () => {
    try {
      await initCoordinator()
      store.wasmReady = true
      store.clearSession()
    } catch (err) {
      console.error('WASM init failed:', err)
      store.logs = ['✖ WASM coordinator failed to load — run: npm run build:wasm']
    }
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
</script>

<!-- ── Modals ── -->
{#if store.showSettings}
  <SettingsModal onclose={() => (store.showSettings = false)} />
{/if}
{#if store.showAgentEdit !== null}
  <AgentEditModal
    agentId={store.showAgentEdit}
    onclose={() => { store.showAgentEdit = null; store.clearSession() }}
  />
{/if}
{#if store.showModeCreate}
  <NewModeModal onclose={() => (store.showModeCreate = false)} />
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
        <div class="wasm-badge" class:ready={store.wasmReady} title={store.wasmReady ? 'WASM ready' : 'Loading WASM…'}>
          <span class="dot {store.wasmReady ? 'done' : 'running'}"></span>
          <span class="wasm-label">WASM</span>
        </div>
      </div>

      <!-- Task input -->
      <div class="nav-task">
        <input
          class="task-input"
          type="text"
          placeholder="Enter a task for the agent swarm…  (Enter to run)"
          value={store.task}
          disabled={store.isRunning}
          oninput={(e) => {
            store.task = (e.target as HTMLInputElement).value
            store.saveTask()
          }}
          onkeydown={(e) => e.key === 'Enter' && !store.isRunning && store.startRun()}
        />
      </div>

      <!-- Controls -->
      <div class="nav-controls">
        {#if isEngineering}
          {#if store.projectDirName}
            <div class="folder-badge" title="Project folder: {store.projectDirName}">
              <span>📁</span>
              <span class="folder-name">{store.projectDirName}</span>
              <button class="ghost icon" style="padding:0 2px;height:auto;font-size:10px" onclick={() => store.closeProjectFolder()} title="Close folder">✕</button>
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
        <button
          class="ghost icon"
          onclick={() => (store.showSettings = true)}
          title="Settings"
          style="font-size:16px"
        >⚙</button>
        {#if store.isRunning}
          <button class="danger" onclick={() => store.stopRun()}>⏹ Stop</button>
        {:else}
          <button
            class="primary run-btn"
            onclick={() => store.startRun()}
            disabled={!store.wasmReady || !store.task.trim()}
            title="Run (Enter)"
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
          />
        {/each}

        {#if store.agentStates.length === 0}
          <div class="empty-agents muted">
            No agents yet.
            <button class="ghost" style="margin-top:6px;width:100%;justify-content:center"
              onclick={() => (store.showAgentEdit = '__new__')}>
              + Add agent
            </button>
          </div>
        {/if}
      </div>

      <div class="sidebar-foot">
        <button
          class="ghost"
          style="width:100%;justify-content:center;font-size:11px"
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
                class="ghost icon"
                style="font-size:11px;padding:2px 4px"
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

  <!-- Output panel -->
  {#if store.output}
    <div class="output-panel">
      <div class="output-head">
        <span class="output-dot"></span>
        Final Output
        <button
          class="ghost icon"
          onclick={() => (store.output = '')}
          style="margin-left:auto"
          title="Dismiss"
        >✕</button>
      </div>
      <div class="output-body">{store.output}</div>
    </div>
  {/if}
</div>

<style>
  /* ── App shell ─────────────────────────────────────────────────────────── */
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
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

  .wasm-badge {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 7px;
    background: var(--glass);
    border: 1px solid var(--glass-border);
    border-radius: 20px;
    font-size: 10px;
    font-family: var(--font-mono);
    font-weight: 700;
    letter-spacing: 0.06em;
    opacity: 0.45;
    transition: opacity var(--t-fast);
  }
  .wasm-badge.ready { opacity: 1; }
  .wasm-label { color: var(--color-text-3); }

  .nav-task { flex: 1; min-width: 0; }
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

  .nav-controls { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
  .run-btn { min-width: 80px; }

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

  /* ── Output panel ──────────────────────────────────────────────────────── */
  .output-panel {
    flex-shrink: 0;
    max-height: 240px;
    overflow-y: auto;
    border-top: 1px solid var(--glass-tinted-border);
    background: rgba(9, 12, 18, 0.9);
    backdrop-filter: blur(var(--blur));
    animation: slide-up var(--t-smooth);
  }
  @keyframes slide-up {
    from { opacity: 0; transform: translateY(10px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  .output-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 16px;
    border-bottom: 1px solid var(--glass-border);
    font-size: 11px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--color-accent);
    position: sticky;
    top: 0;
    background: inherit;
    z-index: 1;
  }
  .output-dot {
    width: 7px; height: 7px;
    border-radius: 50%;
    background: var(--color-accent);
    box-shadow: 0 0 8px rgba(63,185,80,0.6);
    flex-shrink: 0;
  }
  .output-body {
    padding: 12px 16px 16px;
    font-size: 13.5px;
    line-height: 1.75;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--color-text);
  }
</style>
