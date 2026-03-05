<script lang="ts">
  import { store } from '../lib/store.svelte'

  interface Props { onclose: () => void }
  const { onclose }: Props = $props()

  const modeHistory = $derived(
    store.sessionHistory.filter((e) => e.mode === store.appMode)
  )

  // Show current task as an in-flight entry when there's an active session
  const hasCurrentSession = $derived(
    store.task.trim() && (store.isRunning || store.messages.length > 0)
  )

  function formatTime(ts: number): string {
    const d = new Date(ts)
    const now = new Date()
    const diff = now.getTime() - ts

    if (diff < 60_000) return 'just now'
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`

    const sameYear = d.getFullYear() === now.getFullYear()
    if (sameYear) {
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    }
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' })
  }

  function restore(id: string) {
    if (store.isRunning) return
    store.restoreSession(id)
    onclose()
  }
</script>

<!-- svelte-ignore a11y_interactive_supports_focus -->
<div class="modal-backdrop" role="dialog" aria-modal="true" onclick={onclose} onkeydown={(e) => e.key === 'Escape' && onclose()}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="modal" onclick={(e) => e.stopPropagation()}>
    <div class="modal-header">
      <h2>{store.currentModeInfo.icon} {store.currentModeInfo.name} History</h2>
      <button class="ghost icon" onclick={onclose}>✕</button>
    </div>
    <div class="modal-body history-body">
      {#if !hasCurrentSession && modeHistory.length === 0}
        <div class="empty">No sessions yet for this mode</div>
      {:else}
        <div class="history-list">
          {#if hasCurrentSession}
            <div
              class="history-item current"
              role="button"
              tabindex="0"
              onclick={onclose}
              onkeydown={(e: KeyboardEvent) => e.key === 'Enter' && onclose()}
              title={store.task}
            >
              <div class="item-main">
                {#if store.isRunning}
                  <span class="item-status-icon spinning">◉</span>
                {:else}
                  <span class="item-status-icon paused">●</span>
                {/if}
                <span class="item-task">{store.task}</span>
              </div>
              <div class="item-meta">
                <span class="item-badge">{store.isRunning ? 'Running' : 'Current'}</span>
                <span class="item-msgs">{store.messages.length} msg{store.messages.length !== 1 ? 's' : ''}</span>
              </div>
            </div>
          {/if}
          {#each modeHistory as entry (entry.id)}
            <div
              class="history-item"
              class:active={store.restoredSessionId === entry.id}
              class:disabled={store.isRunning}
              role="button"
              tabindex="0"
              onclick={() => restore(entry.id)}
              onkeydown={(e: KeyboardEvent) => e.key === 'Enter' && restore(entry.id)}
              title={entry.task || '(no task)'}
            >
              <div class="item-main">
                <span class="item-task">{entry.task || '(no task)'}</span>
                <button
                  class="item-del"
                  onclick={(e: MouseEvent) => { e.stopPropagation(); store.deleteHistoryEntry(entry.id) }}
                  title="Delete"
                >✕</button>
              </div>
              <div class="item-meta">
                <span class="item-time">{formatTime(entry.timestamp)}</span>
                <span class="item-msgs">{entry.messageCount} msg{entry.messageCount !== 1 ? 's' : ''}</span>
                {#if entry.hasOutput}
                  <span class="item-dot" title="Has output"></span>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .history-body {
    max-height: 60vh;
    overflow-y: auto;
    padding: 12px 20px !important;
  }

  .empty {
    text-align: center;
    color: var(--color-text-4);
    font-size: 13px;
    padding: 32px 0;
  }

  .history-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .history-item {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 10px 12px;
    border: 1px solid transparent;
    border-radius: 6px;
    cursor: pointer;
    transition: all var(--t-fast);
  }

  .history-item:hover:not(.disabled) {
    background: var(--glass);
    border-color: var(--glass-border);
  }

  .history-item.active {
    background: var(--glass-tinted);
    border-color: var(--glass-tinted-border);
  }

  .history-item.disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .item-main {
    display: flex;
    align-items: flex-start;
    gap: 8px;
  }

  .item-task {
    font-size: 13px;
    color: var(--color-text-2);
    flex: 1;
    min-width: 0;
    line-height: 1.4;
    /* Allow up to 2 lines then truncate */
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .history-item.active .item-task {
    color: var(--color-accent);
  }

  .item-del {
    background: none;
    border: none;
    padding: 2px 4px;
    font-size: 10px;
    color: var(--color-text-4);
    cursor: pointer;
    line-height: 1;
    opacity: 0;
    border-radius: 3px;
    flex-shrink: 0;
    height: auto;
    transition: opacity var(--t-fast), color var(--t-fast);
  }

  .history-item:hover .item-del {
    opacity: 0.6;
  }

  .item-del:hover {
    opacity: 1 !important;
    color: var(--color-accent-err);
    background: rgba(255,90,90,0.1);
  }

  .item-meta {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .item-time {
    font-size: 10px;
    color: var(--color-text-4);
    font-family: var(--font-mono);
  }

  .item-msgs {
    font-size: 10px;
    color: var(--color-text-4);
  }

  .item-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--color-accent);
    box-shadow: 0 0 6px rgba(63,185,80,0.5);
    flex-shrink: 0;
  }

  /* Current / in-flight session */
  .history-item.current {
    background: rgba(63,185,80,0.06);
    border-color: rgba(63,185,80,0.25);
  }
  .history-item.current:hover {
    background: rgba(63,185,80,0.1);
  }

  .item-status-icon {
    flex-shrink: 0;
    font-size: 10px;
    line-height: 1;
    margin-top: 3px;
  }
  .item-status-icon.spinning {
    color: var(--color-accent);
    animation: pulse-icon 1.5s ease-in-out infinite;
  }
  .item-status-icon.paused {
    color: var(--color-accent-2);
  }

  .item-badge {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 1px 6px;
    border-radius: 3px;
    background: rgba(63,185,80,0.15);
    color: var(--color-accent);
  }

  @keyframes pulse-icon {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }
</style>
