<script lang="ts">
  import type { AgentState } from '../lib/types'

  interface Props {
    agent: AgentState
    selected: boolean
    onclick: () => void
    onedit: () => void
  }
  const { agent, selected, onclick, onedit }: Props = $props()

  const statusLabel: Record<string, string> = {
    idle: 'Idle', running: 'Running', waiting: 'Waiting', done: 'Done', error: 'Error',
  }
</script>

<div
  class="card"
  class:selected
  role="button"
  tabindex="0"
  style="--ac: {agent.color}"
  onclick={onclick}
  onkeydown={(e) => e.key === 'Enter' && onclick()}
>
  <div class="accent-bar"></div>
  <div class="body">
    <div class="top">
      <span class="dot {agent.status}"></span>
      <span class="name truncate">{agent.name}</span>
      <button
        class="ghost icon edit-btn"
        onclick={(e) => { e.stopPropagation(); onedit() }}
        title="Edit"
      >✎</button>
    </div>
    <div class="meta">
      <span class="role">{agent.role}</span>
      <span class="status {agent.status}">{statusLabel[agent.status] ?? agent.status}</span>
    </div>
    {#if agent.messageCount > 0}
      <div class="stats mono">{agent.messageCount} msg{agent.messageCount !== 1 ? 's' : ''}</div>
    {/if}
  </div>
</div>

<style>
  .card {
    position: relative;
    display: flex;
    background: var(--glass);
    backdrop-filter: blur(var(--blur-subtle));
    border: 1px solid var(--glass-border);
    border-radius: var(--radius);
    cursor: pointer;
    transition: all var(--t-fast);
    overflow: hidden;
    user-select: none;
  }
  .card:hover {
    background: var(--glass-light);
    border-color: var(--glass-light-border);
    transform: translateX(2px);
    box-shadow: var(--shadow-sm);
  }
  .card.selected {
    background: color-mix(in srgb, var(--ac) 8%, transparent);
    border-color: color-mix(in srgb, var(--ac) 35%, transparent);
    box-shadow: 0 0 12px color-mix(in srgb, var(--ac) 15%, transparent);
  }

  .accent-bar {
    width: 3px;
    flex-shrink: 0;
    background: var(--ac);
    opacity: 0.6;
    transition: opacity var(--t-fast);
  }
  .card.selected .accent-bar { opacity: 1; }

  .body {
    flex: 1;
    padding: 9px 9px 9px 11px;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .top {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .name {
    flex: 1;
    font-weight: 600;
    font-size: 13px;
  }

  .edit-btn {
    padding: 1px 4px;
    font-size: 12px;
    opacity: 0;
    transition: opacity var(--t-fast);
    border: none;
  }
  .card:hover .edit-btn { opacity: 1; }

  .meta {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
  }
  .role {
    color: var(--color-text-4);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-family: var(--font-mono);
    font-size: 10px;
  }
  .status { margin-left: auto; font-size: 11px; }
  .status.idle    { color: var(--color-text-4); }
  .status.running { color: var(--color-accent-warn); }
  .status.waiting { color: var(--color-accent-2); }
  .status.done    { color: var(--color-accent); }
  .status.error   { color: var(--color-accent-err); }

  .stats {
    font-size: 10px;
    color: var(--color-text-3);
  }
</style>
