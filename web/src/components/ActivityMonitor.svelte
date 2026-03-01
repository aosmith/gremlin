<script lang="ts">
  import type { AgentConfig, Message } from '../lib/types'
  import { tick } from 'svelte'

  interface Props {
    messages: Message[]
    agents: AgentConfig[]
    logs: string[]
  }
  const { messages, agents, logs }: Props = $props()

  let scrollEl = $state<HTMLDivElement | undefined>(undefined)

  const agentMap = $derived(new Map(agents.map((a) => [a.id, a])))

  function agentColor(id: string): string {
    return agentMap.get(id)?.color ?? 'var(--text-muted)'
  }

  function agentName(id: string): string {
    if (id === 'user') return 'USER'
    if (id === 'system') return 'SYSTEM'
    if (id === 'broadcast') return 'BROADCAST'
    return (agentMap.get(id)?.name ?? id).toUpperCase()
  }

  function formatTime(ts: number): string {
    const d = new Date(ts)
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
  }

  function msgClass(type: string): string {
    if (type === 'task') return 'task'
    if (type === 'error') return 'error'
    if (type === 'human') return 'human'
    if (type === 'system') return 'system'
    if (type === 'result') return 'result'
    return ''
  }

  // Auto-scroll to bottom when new messages arrive
  $effect(() => {
    void messages.length
    void logs.length
    tick().then(() => {
      if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight
    })
  })
</script>

<div class="monitor">
  <div class="monitor-header">
    <span class="label">Activity Monitor</span>
    <span class="count muted">{messages.length} events</span>
  </div>

  <div class="feed" bind:this={scrollEl}>
    {#if messages.length === 0 && logs.length === 0}
      <div class="empty">
        <div class="empty-icon">◉</div>
        <div>Awaiting session start…</div>
        <div class="muted" style="font-size:12px;margin-top:4px">Enter a task and press Run</div>
      </div>
    {/if}

    {#each messages as msg (msg.id)}
      <div class="event {msgClass(msg.type)}">
        <span class="time mono">{formatTime(msg.timestamp)}</span>
        <span class="route">
          <span class="agent-name" style="color: {agentColor(msg.fromAgent)}">{agentName(msg.fromAgent)}</span>
          <span class="arrow">→</span>
          <span class="agent-name" style="color: {agentColor(msg.toAgent)}">{agentName(msg.toAgent)}</span>
        </span>
        <span class="badge {msg.type}">{msg.type}</span>
        <div class="content">{msg.content}</div>
      </div>
    {/each}

    {#if logs.length > 0}
      <div class="log-section">
        {#each logs as log}
          <div class="log-line mono">{log}</div>
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .monitor {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
  }

  .monitor-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 14px;
    border-bottom: 1px solid var(--border);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .label { color: var(--accent); }
  .count { font-family: var(--font-mono); }

  .feed {
    flex: 1;
    overflow-y: auto;
    padding: 8px 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-dim);
    gap: 8px;
    font-size: 13px;
  }
  .empty-icon { font-size: 28px; opacity: 0.4; }

  .event {
    padding: 8px 14px;
    border-bottom: 1px solid rgba(48,54,61,0.5);
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 6px;
    font-size: 12px;
  }
  .event:last-child { border-bottom: none; }
  .event:hover { background: var(--surface-2); }

  .event.task    { border-left: 3px solid var(--accent-gold); padding-left: 11px; }
  .event.error   { border-left: 3px solid var(--accent-red);  padding-left: 11px; background: rgba(248,81,73,0.04); }
  .event.human   { border-left: 3px solid #58a6ff;           padding-left: 11px; background: rgba(88,166,255,0.04); }
  .event.system  { border-left: 3px solid var(--text-dim);   padding-left: 11px; }
  .event.result  { border-left: 3px solid var(--accent);     padding-left: 11px; }

  .time {
    color: var(--text-dim);
    font-size: 11px;
    flex-shrink: 0;
  }

  .route {
    display: flex;
    align-items: center;
    gap: 5px;
    flex-shrink: 0;
  }
  .agent-name {
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.02em;
  }
  .arrow { color: var(--text-dim); }

  .badge {
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 3px;
    text-transform: uppercase;
    font-weight: 600;
    letter-spacing: 0.04em;
    flex-shrink: 0;
    background: var(--surface-3);
    color: var(--text-muted);
  }
  .badge.task   { background: rgba(210,153,34,0.2); color: var(--accent-gold); }
  .badge.error  { background: rgba(248,81,73,0.2);  color: var(--accent-red); }
  .badge.human  { background: rgba(88,166,255,0.2); color: #79c0ff; }
  .badge.result { background: rgba(63,185,80,0.2);  color: var(--accent); }

  .content {
    width: 100%;
    color: var(--text);
    font-size: 12.5px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    padding-top: 3px;
  }

  .log-section {
    padding: 8px 14px;
    border-top: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .log-line {
    font-size: 11px;
    color: var(--text-dim);
  }
</style>
