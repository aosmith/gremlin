<script lang="ts">
  import { store } from '../lib/store.svelte'

  interface Props { onclose: () => void }
  const { onclose }: Props = $props()

  let name        = $state('')
  let icon        = $state('★')
  let description = $state('')

  const EMOJI_PRESETS = ['★', '🚀', '🧠', '🔬', '🎯', '🏗', '⚗', '🌐', '🔐', '💡', '🎲', '🧩']

  function create() {
    const n = name.trim()
    if (!n) return
    store.createMode(n, icon, description.trim())
    onclose()
  }
</script>

<div class="modal-backdrop" role="dialog" aria-modal="true">
  <div class="modal">
    <div class="modal-header">
      ✦ New Mode
      <button class="ghost icon" onclick={onclose}>✕</button>
    </div>

    <div class="modal-body">
      <div class="field">
        <label for="mode-name">Mode name</label>
        <input
          id="mode-name"
          type="text"
          bind:value={name}
          placeholder="e.g. Legal Research"
          maxlength="32"
          onkeydown={(e) => e.key === 'Enter' && create()}
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
      <button class="primary" onclick={create} disabled={!name.trim()}>Create Mode</button>
    </div>
  </div>
</div>

<style>
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
