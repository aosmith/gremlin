<script lang="ts">
  import { BUILTIN_MODES } from '../lib/types'

  interface Props { onclose: () => void; openSettings: () => void }
  const { onclose, openSettings }: Props = $props()

  function goSettings() {
    onclose()
    openSettings()
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="modal-backdrop" role="dialog" aria-modal="true" tabindex="-1" onclick={(e) => { if (e.target === e.currentTarget) onclose() }}>
  <div class="modal wide">
    <div class="modal-header">
      <span>? Help — Getting Started</span>
      <button class="ghost icon" onclick={onclose}>✕</button>
    </div>

    <div class="modal-body">

      <!-- Hero -->
      <div class="hero">
        <span class="hero-icon">⚡</span>
        <div>
          <div class="hero-title">GREMLIN</div>
          <div class="hero-sub">Multi-agent AI coordinator. All local, all in your browser.</div>
        </div>
      </div>

      <!-- Quick Start -->
      <div class="section-divider">Quick Start</div>
      <div class="steps">
        <div class="step glass-card">
          <span class="step-num">1</span>
          <strong>Pick a Provider</strong>
          <span class="step-desc">Choose an LLM: Ollama (local), OpenRouter (free tier), or any of 9 providers</span>
        </div>
        <div class="step glass-card">
          <span class="step-num">2</span>
          <strong>Choose a Model</strong>
          <span class="step-desc">Select or type a model name. Click Discover for local providers.</span>
        </div>
        <div class="step glass-card">
          <span class="step-num">3</span>
          <strong>Run</strong>
          <span class="step-desc">Type a task, hit Enter. Agents collaborate and deliver results.</span>
        </div>
      </div>

      <button class="primary open-settings-btn" onclick={goSettings}>Open Settings</button>

      <!-- Provider Guide -->
      <div class="section-divider">Provider Guide</div>

      <details class="provider-section">
        <summary>🦙 Ollama — local, free</summary>
        <div class="provider-body">
          <div class="hint-steps">
            <div>1. Install: <code>curl -fsSL https://ollama.com/install.sh | sh</code></div>
            <div>2. Pull a model: <code>ollama pull llama3.2</code></div>
            <div>3. Start: <code>ollama serve</code></div>
          </div>
          <div class="local-hint">
            If accessing from a hosted site, set the CORS origin:<br/>
            <code>OLLAMA_ORIGINS=https://your-domain ollama serve</code>
          </div>
        </div>
      </details>

      <details class="provider-section">
        <summary>🌐 OpenRouter — cloud, free tier</summary>
        <div class="provider-body">
          <div class="hint-steps">
            <div>1. Get a free API key at <strong>openrouter.ai</strong></div>
            <div>2. Free models available (e.g. <code>meta-llama/llama-3.2-3b-instruct:free</code>)</div>
            <div>3. Paste your key in Settings and pick a model</div>
          </div>
        </div>
      </details>

      <details class="provider-section">
        <summary>🤖 Anthropic / OpenAI / Gemini</summary>
        <div class="provider-body">
          <div class="hint-steps">
            <div><strong>Anthropic</strong> — get a key at <strong>console.anthropic.com</strong></div>
            <div><strong>OpenAI</strong> — get a key at <strong>platform.openai.com/api-keys</strong></div>
            <div><strong>Gemini</strong> — free tier at <strong>aistudio.google.com</strong></div>
          </div>
        </div>
      </details>

      <!-- Web Search -->
      <div class="section-divider">Web Search</div>
      <p class="info-text">
        Web search works out of the box — DuckDuckGo is the default, no API key needed.
        For better results, configure Brave, Serper, or Tavily in Settings.
      </p>

      <!-- Modes -->
      <div class="section-divider">Modes</div>
      <div class="modes-table">
        {#each BUILTIN_MODES as mode (mode.id)}
          <div class="mode-row">
            <span class="mode-icon">{mode.icon}</span>
            <strong class="mode-name">{mode.name}</strong>
            <span class="mode-desc">{mode.description}</span>
          </div>
        {/each}
      </div>
      <p class="info-text">Create custom modes with <strong>+ New Mode</strong>.</p>

      <!-- Tips -->
      <div class="section-divider">Tips</div>
      <div class="hint-steps tips">
        <div>Click any agent during a run to send them a direct message</div>
        <div>Engineering mode: open a folder to give agents file system access</div>
        <div>WebLLM: run models entirely in-browser with WebGPU (Chrome 113+)</div>
        <div>All data stays in your browser (localStorage). No accounts, no tracking.</div>
      </div>

    </div>
  </div>
</div>

<style>
  .wide { max-width: 680px; }

  /* ── Hero ───────────────────────────────────────────────────────────────── */
  .hero {
    display: flex;
    align-items: center;
    gap: 14px;
  }
  .hero-icon {
    font-size: 32px;
    line-height: 1;
  }
  .hero-title {
    font-size: 20px;
    font-weight: 800;
    letter-spacing: 0.04em;
    color: var(--color-accent);
  }
  .hero-sub {
    font-size: 13px;
    color: var(--color-text-3);
    margin-top: 2px;
  }

  /* ── Quick-start steps ─────────────────────────────────────────────────── */
  .steps {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 10px;
  }
  .step {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    padding: 14px 10px 12px;
    gap: 6px;
    font-size: 12px;
  }
  .step-num {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    background: var(--glass-tinted);
    border: 1px solid var(--glass-tinted-border);
    color: var(--color-accent);
    font-weight: 800;
    font-size: 13px;
    flex-shrink: 0;
  }
  .step strong {
    font-size: 13px;
    color: var(--color-text);
  }
  .step-desc {
    color: var(--color-text-3);
    line-height: 1.5;
  }

  .open-settings-btn {
    width: 100%;
  }

  /* ── Provider sections (details/summary) ───────────────────────────────── */
  .provider-section {
    border: 1px solid var(--glass-border);
    border-radius: var(--radius);
    overflow: hidden;
  }
  .provider-section summary {
    padding: 10px 12px;
    font-size: 13px;
    font-weight: 600;
    color: var(--color-text-2);
    cursor: pointer;
    user-select: none;
    list-style: none;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .provider-section summary::before { content: '›'; font-size: 14px; transition: transform var(--t-fast); }
  .provider-section[open] summary::before { transform: rotate(90deg); }
  .provider-section summary:hover { color: var(--color-text); }
  .provider-body {
    padding: 10px 14px 14px;
    border-top: 1px solid var(--glass-border);
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  /* ── Shared text styles ────────────────────────────────────────────────── */
  .hint-steps {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: var(--color-text-3);
    line-height: 1.6;
  }
  .tips div::before {
    content: '•';
    margin-right: 6px;
    color: var(--color-accent);
  }
  .info-text {
    font-size: 12px;
    color: var(--color-text-3);
    line-height: 1.6;
  }

  .local-hint {
    background: var(--glass);
    border: 1px solid var(--glass-border);
    border-radius: var(--radius);
    padding: 10px 12px;
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

  /* ── Modes table ───────────────────────────────────────────────────────── */
  .modes-table {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .mode-row {
    display: grid;
    grid-template-columns: 28px 90px 1fr;
    align-items: center;
    gap: 4px;
    padding: 5px 8px;
    font-size: 12px;
    border-radius: var(--radius);
  }
  .mode-row:hover {
    background: var(--glass);
  }
  .mode-icon {
    font-size: 15px;
    text-align: center;
  }
  .mode-name {
    color: var(--color-text);
  }
  .mode-desc {
    color: var(--color-text-3);
  }

  /* ── Section divider (inherited from global but scoped for spacing) ──── */
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
</style>
