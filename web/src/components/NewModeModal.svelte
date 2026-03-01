<script lang="ts">
  import { store } from '../lib/store.svelte'
  import { generateTeam } from '../lib/teamGenerator'
  import type { GeneratedTeam } from '../lib/teamGenerator'

  interface Props { onclose: () => void }
  const { onclose }: Props = $props()

  // ── Tab state ──────────────────────────────────────────────────────────────
  type Tab = 'generate' | 'manual'
  let tab = $state<Tab>('generate')

  // ── Manual tab state ───────────────────────────────────────────────────────
  let name        = $state('')
  let icon        = $state('★')
  let description = $state('')

  const EMOJI_PRESETS = ['★', '🚀', '🧠', '🔬', '🎯', '🏗', '⚗', '🌐', '🔐', '💡', '🎲', '🧩']

  function createManual() {
    const n = name.trim()
    if (!n) return
    store.createMode(n, icon, description.trim())
    onclose()
  }

  // ── Generate tab state ─────────────────────────────────────────────────────
  type GenPhase = 'input' | 'generating' | 'preview' | 'error'
  let phase       = $state<GenPhase>('input')
  let prompt      = $state('')
  let team        = $state<GeneratedTeam | null>(null)
  let errorMsg    = $state('')
  let abortCtrl   = $state<AbortController | null>(null)
  let showPrompts = $state(false)

  const hasModel = $derived(!!store.settings.model)

  async function generate() {
    if (!prompt.trim() || !hasModel) return
    phase = 'generating'
    errorMsg = ''
    abortCtrl = new AbortController()
    try {
      team = await generateTeam(prompt.trim(), store.settings, abortCtrl.signal)
      phase = 'preview'
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        phase = 'input'
        return
      }
      errorMsg = err instanceof Error ? err.message : String(err)
      phase = 'error'
    } finally {
      abortCtrl = null
    }
  }

  function cancelGeneration() {
    abortCtrl?.abort()
    abortCtrl = null
    phase = 'input'
  }

  function createTeam() {
    if (!team) return
    store.createModeWithAgents(team.name, team.icon, team.description, team.agents)
    onclose()
  }

  function regenerate() {
    team = null
    showPrompts = false
    generate()
  }

  function roleBadge(role: string): string {
    switch (role) {
      case 'orchestrator': return 'orch'
      case 'synthesizer':  return 'synth'
      default:             return 'worker'
    }
  }
</script>

<div class="modal-backdrop" role="dialog" aria-modal="true">
  <div class="modal modal--wide">
    <div class="modal-header">
      ✦ New Mode
      <button class="ghost icon" onclick={onclose}>✕</button>
    </div>

    <!-- Tab bar -->
    <div class="tab-bar">
      <button
        class="tab-btn" class:active={tab === 'generate'}
        onclick={() => (tab = 'generate')}
      >Generate with AI</button>
      <button
        class="tab-btn" class:active={tab === 'manual'}
        onclick={() => (tab = 'manual')}
      >Manual</button>
    </div>

    <!-- ═══ GENERATE TAB ═══ -->
    {#if tab === 'generate'}
      <div class="modal-body">

        {#if !hasModel}
          <div class="warning-banner">
            No model configured. Open <strong>Settings</strong> to select a provider and model.
          </div>
        {/if}

        <!-- Phase: Input -->
        {#if phase === 'input'}
          <div class="field">
            <label for="gen-prompt">Describe your team</label>
            <textarea
              id="gen-prompt"
              bind:value={prompt}
              placeholder="e.g. I run a marketing agency — I need a team that can research competitors, write copy, design campaigns, and analyse performance metrics."
              rows="4"
              disabled={!hasModel}
            ></textarea>
          </div>

        <!-- Phase: Generating -->
        {:else if phase === 'generating'}
          <div class="generating">
            <div class="spinner"></div>
            <span class="muted">Generating your team...</span>
          </div>

        <!-- Phase: Preview -->
        {:else if phase === 'preview' && team}
          <div class="preview-header">
            <span class="preview-icon">{team.icon}</span>
            <div>
              <div class="preview-name">{team.name}</div>
              <div class="preview-desc muted">{team.description}</div>
            </div>
          </div>

          <div class="agent-list">
            {#each team.agents as agent}
              <div class="agent-row">
                <span class="color-dot" style="background:{agent.color}"></span>
                <span class="agent-name">{agent.name}</span>
                <span class="role-badge role-badge--{agent.role}">{roleBadge(agent.role)}</span>
              </div>
            {/each}
          </div>

          <button class="ghost expand-btn" onclick={() => (showPrompts = !showPrompts)}>
            {showPrompts ? '▾' : '▸'} View system prompts
          </button>

          {#if showPrompts}
            <div class="prompts-panel">
              {#each team.agents as agent}
                <div class="prompt-block">
                  <div class="prompt-agent">{agent.name}</div>
                  <div class="prompt-text">{agent.systemPrompt}</div>
                </div>
              {/each}
            </div>
          {/if}

        <!-- Phase: Error -->
        {:else if phase === 'error'}
          <div class="error-banner">
            <strong>Generation failed:</strong> {errorMsg}
          </div>
        {/if}
      </div>

      <div class="modal-footer">
        {#if phase === 'input'}
          <button class="ghost" onclick={onclose}>Cancel</button>
          <button class="primary" onclick={generate} disabled={!prompt.trim() || !hasModel}>
            Generate Team
          </button>
        {:else if phase === 'generating'}
          <button class="ghost" onclick={cancelGeneration}>Cancel</button>
        {:else if phase === 'preview'}
          <button class="ghost" onclick={regenerate}>Regenerate</button>
          <button class="ghost" onclick={onclose}>Cancel</button>
          <button class="primary" onclick={createTeam}>Create Team</button>
        {:else if phase === 'error'}
          <button class="ghost" onclick={onclose}>Cancel</button>
          <button class="primary" onclick={regenerate}>Retry</button>
        {/if}
      </div>

    <!-- ═══ MANUAL TAB ═══ -->
    {:else}
      <div class="modal-body">
        <div class="field">
          <label for="mode-name">Mode name</label>
          <input
            id="mode-name"
            type="text"
            bind:value={name}
            placeholder="e.g. Legal Research"
            maxlength="32"
            onkeydown={(e) => e.key === 'Enter' && createManual()}
          />
        </div>

        <div class="field">
          <div class="field-label">Icon</div>
          <div class="emoji-grid">
            {#each EMOJI_PRESETS as e}
              <button
                class="emoji-btn"
                class:active={icon === e}
                onclick={() => (icon = e)}
              >{e}</button>
            {/each}
          </div>
        </div>

        <div class="field">
          <label for="mode-desc">Description <span class="optional">(optional)</span></label>
          <input
            id="mode-desc"
            type="text"
            bind:value={description}
            placeholder="Short description of this mode…"
            maxlength="80"
          />
        </div>

        <p class="hint muted">
          The new mode starts with your <strong>current agent configuration</strong>.
          You can customise the agents after creating it.
        </p>
      </div>

      <div class="modal-footer">
        <button class="ghost" onclick={onclose}>Cancel</button>
        <button class="primary" onclick={createManual} disabled={!name.trim()}>Create Mode</button>
      </div>
    {/if}
  </div>
</div>

<style>
  .modal--wide {
    max-width: 520px;
  }

  /* ── Tab bar ───────────────────────────────────────────────────────────── */
  .tab-bar {
    display: flex;
    gap: 0;
    border-bottom: 1px solid var(--glass-border);
    padding: 0 20px;
  }
  .tab-btn {
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--color-text-3);
    font: inherit;
    font-size: 12px;
    letter-spacing: 0.4px;
    text-transform: uppercase;
    padding: 10px 16px;
    cursor: pointer;
    transition: all var(--t-fast);
  }
  .tab-btn:hover { color: var(--color-text-2); }
  .tab-btn.active {
    color: var(--color-accent);
    border-bottom-color: var(--color-accent);
  }

  /* ── Generate tab ──────────────────────────────────────────────────────── */
  textarea {
    width: 100%;
    background: var(--glass);
    border: 1px solid var(--glass-border);
    border-radius: var(--radius);
    color: var(--color-text);
    font: inherit;
    font-size: 13px;
    padding: 10px 12px;
    resize: vertical;
    line-height: 1.5;
  }
  textarea:focus {
    outline: none;
    border-color: var(--color-accent);
    box-shadow: 0 0 0 1px var(--color-accent);
  }
  textarea:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .warning-banner {
    font-size: 12px;
    color: var(--color-accent-warn);
    background: rgba(210, 153, 34, 0.08);
    border: 1px solid rgba(210, 153, 34, 0.24);
    border-radius: var(--radius);
    padding: 10px 14px;
    margin-bottom: 12px;
    line-height: 1.5;
  }

  .error-banner {
    font-size: 12px;
    color: var(--color-accent-err);
    background: var(--glass-err);
    border: 1px solid var(--glass-err-border);
    border-radius: var(--radius);
    padding: 10px 14px;
    line-height: 1.5;
    word-break: break-word;
  }

  .generating {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 32px 0;
  }

  .spinner {
    width: 20px;
    height: 20px;
    border: 2px solid var(--glass-border);
    border-top-color: var(--color-accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* ── Preview ───────────────────────────────────────────────────────────── */
  .preview-header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 16px;
  }
  .preview-icon {
    font-size: 28px;
    line-height: 1;
  }
  .preview-name {
    font-size: 15px;
    font-weight: 600;
    color: var(--color-text);
  }
  .preview-desc {
    font-size: 12px;
    margin-top: 2px;
  }

  .agent-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 12px;
  }
  .agent-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 10px;
    background: var(--glass);
    border: 1px solid var(--glass-border);
    border-radius: var(--radius);
    font-size: 13px;
  }
  .color-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .agent-name {
    flex: 1;
    color: var(--color-text);
  }
  .role-badge {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 2px 8px;
    border-radius: 99px;
    font-weight: 600;
  }
  .role-badge--orchestrator {
    color: var(--color-accent);
    background: var(--glass-tinted);
    border: 1px solid var(--glass-tinted-border);
  }
  .role-badge--synthesizer {
    color: var(--color-accent-3);
    background: rgba(188, 140, 255, 0.06);
    border: 1px solid rgba(188, 140, 255, 0.18);
  }
  .role-badge--worker {
    color: var(--color-accent-2);
    background: var(--glass-blue);
    border: 1px solid var(--glass-blue-border);
  }

  .expand-btn {
    font-size: 12px;
    padding: 4px 8px;
    color: var(--color-text-3);
  }
  .expand-btn:hover { color: var(--color-text-2); }

  .prompts-panel {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 8px;
    max-height: 240px;
    overflow-y: auto;
  }
  .prompt-block {
    background: var(--glass);
    border: 1px solid var(--glass-border);
    border-radius: var(--radius);
    padding: 10px 12px;
  }
  .prompt-agent {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--color-text-3);
    margin-bottom: 4px;
  }
  .prompt-text {
    font-size: 12px;
    line-height: 1.6;
    color: var(--color-text-2);
    white-space: pre-wrap;
  }

  /* ── Manual tab (unchanged styles) ─────────────────────────────────────── */
  .emoji-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .emoji-btn {
    width: 36px;
    height: 36px;
    font-size: 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--glass);
    border: 1px solid var(--glass-border);
    border-radius: var(--radius);
    cursor: pointer;
    transition: all var(--t-fast);
    padding: 0;
  }
  .emoji-btn:hover  { background: var(--glass-light); border-color: var(--glass-light-border); transform: translateY(-1px); }
  .emoji-btn.active { background: var(--glass-tinted); border-color: var(--glass-tinted-border); }

  .optional {
    font-size: 10px;
    color: var(--color-text-4);
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
  }

  .hint {
    font-size: 11.5px;
    line-height: 1.7;
    margin: 4px 0 0;
  }
</style>
