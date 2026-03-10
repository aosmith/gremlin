<script lang="ts">
  import { AGENT_COLORS, PROVIDERS, SEARCH_PROVIDERS } from '../lib/types'
  import type { AgentConfig, AgentRole } from '../lib/types'
  import { store } from '../lib/store.svelte'

  // Model suggestions from the currently selected provider
  const modelSuggestions = $derived(
    PROVIDERS.find((p) => p.format === store.settings.apiFormat && p.id !== 'custom')?.models ?? []
  )

  interface Props {
    agentId: string | '__new__'
    onclose: () => void
  }
  const { agentId, onclose }: Props = $props()

  // agentId is stable for the lifetime of this modal
  // svelte-ignore state_referenced_locally
  const _agentId = agentId
  const isNew = _agentId === '__new__' || _agentId.startsWith('__new__:')
  const suggestedName = _agentId.startsWith('__new__:') ? _agentId.slice('__new__:'.length) : ''

  function makeId(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
  }

  const existing = isNew ? null : (store.agentConfigs.find((a) => a.id === agentId) ?? null)

  let draft = $state<AgentConfig>(
    existing
      ? { ...existing }
      : {
          id: suggestedName ? makeId(suggestedName) : '',
          name: suggestedName || '',
          role: 'worker',
          systemPrompt: '',
          color: AGENT_COLORS[Math.floor(Math.random() * AGENT_COLORS.length)],
          model: '',
          searchProvider: '',
        },
  )

  $effect(() => {
    if (isNew && draft.name) draft.id = makeId(draft.name)
  })

  function resolveSuggestion(created: boolean) {
    if (store.pendingAgentSuggestion) {
      store.pendingAgentSuggestion.resolve(created)
      store.pendingAgentSuggestion = null
    }
  }

  function save() {
    if (!draft.name.trim() || !draft.id.trim()) return
    store.upsertAgent(draft)
    // If this was a mid-run suggestion, also register the agent in the runner
    if (suggestedName && store.runner) {
      store.runner.addAgent(draft)
    }
    resolveSuggestion(true)
    onclose()
  }

  function cancel() {
    resolveSuggestion(false)
    onclose()
  }

  function remove() {
    if (!isNew) store.removeAgent(agentId as string)
    resolveSuggestion(false)
    onclose()
  }

  const roles: AgentRole[] = ['orchestrator', 'worker', 'synthesizer', 'custom']
</script>

<div class="modal-backdrop" role="dialog" aria-modal="true">
  <div class="modal">
    <div class="modal-header">
      {isNew ? '+ New Agent' : `Edit · ${existing?.name ?? agentId}`}
      <button class="ghost icon" onclick={cancel}>✕</button>
    </div>

    <div class="modal-body">
      <div class="row-two">
        <div class="field">
          <label for="agent-name">Name</label>
          <input id="agent-name" type="text" bind:value={draft.name} placeholder="e.g. Researcher" />
        </div>
        <div class="field">
          <label for="agent-role">Role</label>
          <select id="agent-role" bind:value={draft.role}>
            {#each roles as r}
              <option value={r}>{r}</option>
            {/each}
          </select>
        </div>
      </div>

      <div class="field">
        <label for="agent-id">Agent ID</label>
        <input id="agent-id" type="text" bind:value={draft.id} placeholder="snake_case_id" />
        <small>Unique identifier used in inter-agent messages. Cannot be changed after creation.</small>
      </div>

      <div class="field">
        <div class="field-label">Color</div>
        <div class="color-row">
          {#each AGENT_COLORS as c}
            <button
              class="color-swatch"
              class:active={draft.color === c}
              style="background: {c}"
              onclick={() => (draft.color = c)}
              title={c}
            ></button>
          {/each}
          <input type="color" bind:value={draft.color} title="Custom color" class="color-input" />
        </div>
      </div>

      <div class="field">
        <label for="system-prompt">System Prompt</label>
        <textarea
          id="system-prompt"
          bind:value={draft.systemPrompt}
          rows="7"
          placeholder="Describe what this agent does and how it should behave…"
        ></textarea>
        <small>The GREMLIN communication protocol is appended automatically.</small>
      </div>

      <div class="field">
        <label for="agent-model">Model <span class="optional">(override)</span></label>
        <input
          id="agent-model"
          type="text"
          list="model-suggestions"
          bind:value={draft.model}
          placeholder="Global: {store.settings.model}"
        />
        <datalist id="model-suggestions">
          {#each modelSuggestions as m}
            <option value={m}>{m}</option>
          {/each}
        </datalist>
        <small>Leave blank to use the global model. Type any model name or pick from the list.</small>
      </div>

      <div class="field">
        <label for="agent-search">Search Provider <span class="optional">(override)</span></label>
        <select id="agent-search" bind:value={draft.searchProvider}>
          <option value="">Global: {store.settings.searchProviders?.join(', ') || 'none'}</option>
          {#each SEARCH_PROVIDERS as p (p.id)}
            <option value={p.id}>{p.icon} {p.name}</option>
          {/each}
        </select>
        <small>Leave as global to use the provider from Settings.</small>
      </div>
    </div>

    <div class="modal-footer">
      {#if !isNew}
        <button class="danger btn-remove" onclick={remove}>Remove</button>
      {/if}
      <button class="ghost" onclick={cancel}>Cancel</button>
      <button class="primary" onclick={save} disabled={!draft.name.trim() || !draft.id.trim()}>
        {isNew ? 'Add Agent' : 'Save'}
      </button>
    </div>
  </div>
</div>

<style>
  .row-two {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }

  .field-label {
    font-size: 11px;
    color: var(--color-text-3);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 700;
  }

  .color-row {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    align-items: center;
  }

  .color-swatch {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    border: 2px solid transparent;
    padding: 0;
    cursor: pointer;
    transition: transform 0.1s, border-color 0.1s;
    flex-shrink: 0;
    background-clip: padding-box;
  }
  .color-swatch:hover { transform: scale(1.15); }
  .color-swatch.active { border-color: var(--text); transform: scale(1.1); }

  .color-input {
    width: 28px;
    height: 28px;
    padding: 1px;
    border-radius: 50%;
    border: 2px solid var(--border);
    cursor: pointer;
    background: none;
  }

  .optional {
    font-size: 10px;
    color: var(--color-text-4);
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
  }
  .btn-remove { margin-right: auto; }
</style>
