<script lang="ts">
  import type { AgentConfig, Message } from '../lib/types'
  import { cleanContent } from '../lib/cleanContent'
  import { marked } from 'marked'
  import { tick } from 'svelte'

  interface Props {
    messages: Message[]
    agents: AgentConfig[]
    logs: string[]
  }
  const { messages, agents, logs }: Props = $props()

  const MSG_TRUNCATE = 2000

  let scrollEl = $state<HTMLDivElement | undefined>(undefined)
  let expanded = $state(new Set<string>())

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
        <div class="empty-hint muted">Enter a task and press Run</div>
      </div>
    {/if}

    {#each messages as msg (msg.id)}
      <div class="event {msg.type}">
        <span class="time mono">{formatTime(msg.timestamp)}</span>
        <span class="route">
          <span class="agent-name" style="color: {agentColor(msg.fromAgent)}">{agentName(msg.fromAgent)}</span>
          <span class="arrow">→</span>
          <span class="agent-name" style="color: {agentColor(msg.toAgent)}">{agentName(msg.toAgent)}</span>
        </span>
        <span class="badge {msg.type}">{msg.type}</span>
        {#if cleanContent(msg.content).length > MSG_TRUNCATE && !expanded.has(msg.id)}
          <div class="content prose-sm">{@html marked.parse(cleanContent(msg.content).slice(0, MSG_TRUNCATE) + '…')}</div>
          <button class="expand-link" onclick={() => { expanded = new Set([...expanded, msg.id]) }}>show more</button>
        {:else}
          <div class="content prose-sm">{@html marked.parse(cleanContent(msg.content))}</div>
        {/if}
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
  .empty-hint { font-size: 12px; margin-top: 4px; }

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
    word-break: break-word;
    padding-top: 3px;
  }

  /* Compact markdown styling for monitor messages */
  .prose-sm :global(p) { margin: 0.3em 0; }
  .prose-sm :global(h1),
  .prose-sm :global(h2),
  .prose-sm :global(h3) { font-size: 1em; font-weight: 700; margin: 0.4em 0 0.2em; }
  .prose-sm :global(ul), .prose-sm :global(ol) { margin: 0.2em 0; padding-left: 1.4em; }
  .prose-sm :global(li) { margin: 0.1em 0; }
  .prose-sm :global(strong) { font-weight: 700; }
  .prose-sm :global(code) {
    font-family: var(--font-mono);
    font-size: 0.9em;
    padding: 1px 4px;
    background: rgba(110,118,129,0.15);
    border-radius: 3px;
  }
  .prose-sm :global(pre) {
    background: rgba(0,0,0,0.25);
    border-radius: 4px;
    padding: 6px 8px;
    overflow-x: auto;
    font-size: 11px;
  }
  .prose-sm :global(pre code) { background: none; padding: 0; }
  .prose-sm :global(table) { border-collapse: collapse; margin: 0.3em 0; font-size: 11px; }
  .prose-sm :global(th), .prose-sm :global(td) { border: 1px solid var(--border); padding: 3px 6px; }
  .prose-sm :global(th) { background: rgba(255,255,255,0.04); font-weight: 700; }
  .prose-sm :global(hr) { border: none; border-top: 1px solid var(--border); margin: 0.5em 0; }

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

  .expand-link {
    background: none;
    border: none;
    color: var(--accent);
    cursor: pointer;
    font-size: inherit;
    padding: 0;
    text-decoration: underline;
  }
</style>
