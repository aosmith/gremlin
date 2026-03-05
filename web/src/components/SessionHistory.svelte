<script lang="ts">
  import { store } from '../lib/store.svelte'

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

  function truncateTask(text: string, max = 60): string {
    if (!text) return '(no task)'
    return text.length > max ? text.slice(0, max) + '…' : text
  }
</script>

{#if store.sessionHistory.length > 0}
  <div class="history-section">
    <div class="history-head">
      <span class="sidebar-label">History</span>
      <span class="count-badge">{store.sessionHistory.length}</span>
    </div>
    <div class="history-list">
      {#each store.sessionHistory as entry (entry.id)}
        <div
          class="history-item"
          class:active={store.restoredSessionId === entry.id}
          class:disabled={store.isRunning}
          role="button"
          tabindex="0"
          onclick={() => !store.isRunning && store.restoreSession(entry.id)}
          onkeydown={(e: KeyboardEvent) => e.key === 'Enter' && !store.isRunning && store.restoreSession(entry.id)}
          title={entry.task || '(no task)'}
        >
          <div class="item-top">
            <span class="item-mode">{entry.modeIcon}</span>
            <span class="item-task">{truncateTask(entry.task)}</span>
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
              <span class="item-output-dot" title="Has output"></span>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  </div>
{/if}

<style>
  .history-section {
    display: flex;
    flex-direction: column;
    border-top: 1px solid var(--glass-border);
    max-height: 35%;
    flex-shrink: 0;
  }

  .history-head {
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

  .count-badge {
    font-size: 9px;
    font-weight: 700;
    padding: 1px 6px;
    border-radius: 8px;
    background: var(--glass);
    border: 1px solid var(--glass-border);
    color: var(--color-text-4);
    font-family: var(--font-mono);
  }

  .history-list {
    overflow-y: auto;
    overflow-x: hidden;
    padding: 4px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .history-item {
    display: flex;
    flex-direction: column;
    gap: 3px;
    width: 100%;
    text-align: left;
    background: none;
    border: 1px solid transparent;
    border-radius: 6px;
    padding: 6px 8px;
    cursor: pointer;
    transition: all var(--t-fast);
    height: auto;
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

  .item-top {
    display: flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
  }

  .item-mode {
    font-size: 11px;
    flex-shrink: 0;
    line-height: 1;
  }

  .item-task {
    font-size: 11px;
    color: var(--color-text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }

  .history-item.active .item-task {
    color: var(--color-accent);
  }

  .item-del {
    background: none;
    border: none;
    padding: 1px 3px;
    font-size: 8px;
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
    gap: 6px;
    padding-left: 16px;
  }

  .item-time {
    font-size: 9px;
    color: var(--color-text-4);
    font-family: var(--font-mono);
  }

  .item-msgs {
    font-size: 9px;
    color: var(--color-text-4);
  }

  .item-output-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--color-accent);
    box-shadow: 0 0 6px rgba(63,185,80,0.5);
    flex-shrink: 0;
  }
</style>
