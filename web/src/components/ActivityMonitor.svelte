<script lang="ts">
  import type { AgentConfig, Message } from '../lib/types'
  import { cleanContent } from '../lib/cleanContent'
  import { enhanceProse } from '../lib/tableCards'
  import { marked } from 'marked'
  import { tick } from 'svelte'

  interface Props {
    messages: Message[]
    agents: AgentConfig[]
    logs: string[]
    streamingAgentId?: string | null
    streamingText?: string
  }
  const { messages, agents, logs, streamingAgentId = null, streamingText = '' }: Props = $props()

  // Messages always expand fully — no truncation

  let scrollEl = $state<HTMLDivElement | undefined>(undefined)
  let logEl = $state<HTMLDivElement | undefined>(undefined)

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

  // Auto-scroll to bottom when new messages arrive or streaming text updates
  $effect(() => {
    void messages.length
    void streamingText
    tick().then(() => {
      if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight
    })
  })

  // Auto-scroll log section independently
  $effect(() => {
    void logs.length
    tick().then(() => {
      if (logEl) logEl.scrollTop = logEl.scrollHeight
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
        <div class="content prose-sm">{@html enhanceProse(marked.parse(cleanContent(msg.content)) as string)}</div>
      </div>
    {/each}

    {#if streamingAgentId && streamingText}
      <div class="event streaming">
        <span class="route">
          <span class="agent-name" style="color: {agentColor(streamingAgentId)}">{agentName(streamingAgentId)}</span>
          <span class="typing-indicator">
            <span class="typing-dot"></span>
            <span class="typing-dot"></span>
            <span class="typing-dot"></span>
          </span>
        </span>
        <span class="typing-label muted">is thinking…</span>
      </div>
    {/if}
  </div>

  {#if logs.length > 0}
    <div class="log-section" bind:this={logEl}>
      {#each logs as log}
        <div class="log-line mono">{log}</div>
      {/each}
    </div>
  {/if}
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

  /* Markdown styling for monitor messages */
  .prose-sm :global(p) { margin: 0.4em 0; }
  .prose-sm :global(h1),
  .prose-sm :global(h2),
  .prose-sm :global(h3) {
    font-size: 1em;
    font-weight: 700;
    margin: 0.8em 0 0.3em;
    color: var(--accent);
    border-bottom: 1px solid rgba(63,185,80,0.15);
    padding-bottom: 2px;
  }
  .prose-sm :global(h1) { font-size: 1.05em; }
  .prose-sm :global(ul), .prose-sm :global(ol) { margin: 0.4em 0; padding-left: 1.5em; }
  .prose-sm :global(li) { margin: 0.2em 0; }
  .prose-sm :global(li)::marker { color: var(--text-dim); }
  .prose-sm :global(strong) { font-weight: 700; color: var(--text); }
  .prose-sm :global(em) { color: var(--text-muted); }
  .prose-sm :global(code) {
    font-family: var(--font-mono);
    font-size: 0.88em;
    padding: 1px 5px;
    background: rgba(110,118,129,0.15);
    border-radius: 3px;
  }
  .prose-sm :global(pre) {
    background: rgba(0,0,0,0.3);
    border: 1px solid rgba(48,54,61,0.5);
    border-radius: 5px;
    padding: 8px 10px;
    overflow-x: auto;
    font-size: 11px;
    margin: 0.4em 0;
  }
  .prose-sm :global(pre code) { background: none; padding: 0; }
  /* Small tables */
  .prose-sm :global(.table-wrap) {
    overflow-x: auto;
    margin: 0.4em 0;
    border: 1px solid rgba(48,54,61,0.5);
    border-radius: 4px;
  }
  .prose-sm :global(table) {
    border-collapse: collapse;
    font-size: 10px;
    width: 100%;
    margin: 0;
  }
  .prose-sm :global(th), .prose-sm :global(td) {
    border: 1px solid rgba(48,54,61,0.5);
    padding: 3px 7px;
    text-align: left;
  }
  .prose-sm :global(th) {
    background: rgba(63,185,80,0.06);
    font-weight: 700;
    color: var(--accent);
    font-size: 9px;
    text-transform: uppercase;
  }

  /* Card grid for wide tables */
  .prose-sm :global(.card-grid) {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 6px;
    margin: 0.4em 0;
  }
  .prose-sm :global(.data-card) {
    background: rgba(255,255,255,0.02);
    border: 1px solid rgba(48,54,61,0.5);
    border-radius: 5px;
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .prose-sm :global(.card-title) {
    font-weight: 700;
    font-size: 12px;
    color: var(--accent);
    padding-bottom: 4px;
    border-bottom: 1px solid rgba(63,185,80,0.12);
  }
  .prose-sm :global(.card-fields) {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 3px 8px;
  }
  .prose-sm :global(.card-field) {
    display: flex;
    flex-direction: column;
    gap: 0;
  }
  .prose-sm :global(.card-label) {
    font-size: 8px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-dim);
    font-family: var(--font-mono);
  }
  .prose-sm :global(.card-value) {
    font-size: 11px;
    color: var(--text);
    line-height: 1.3;
  }
  .prose-sm :global(hr) { border: none; border-top: 1px solid var(--border); margin: 0.6em 0; }
  .prose-sm :global(.agent-label) {
    font-family: var(--font-mono);
    font-size: 0.8em;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--accent);
    background: rgba(63,185,80,0.08);
    padding: 1px 5px;
    border-radius: 2px;
    border: 1px solid rgba(63,185,80,0.12);
  }
  .prose-sm :global(.ticker) {
    font-family: var(--font-mono);
    font-weight: 700;
    color: #79c0ff;
    background: rgba(88,166,255,0.08);
    padding: 0 3px;
    border-radius: 2px;
    font-size: 0.88em;
    letter-spacing: 0.02em;
  }
  .prose-sm :global(blockquote) {
    border-left: 2px solid var(--accent);
    margin: 0.4em 0;
    padding: 0.2em 0 0.2em 10px;
    color: var(--text-muted);
  }

  /* Callouts in activity monitor */
  .prose-sm :global(.callout) {
    margin: 0.5em 0;
    padding: 6px 10px;
    border-radius: 5px;
    border: 1px solid rgba(48,54,61,0.5);
  }
  .prose-sm :global(.callout > h2),
  .prose-sm :global(.callout > h3) {
    margin-top: 0;
    font-size: 0.9em;
  }
  .prose-sm :global(.callout-source) {
    background: rgba(88,166,255,0.04);
    border-color: rgba(88,166,255,0.15);
    border-left: 2px solid rgba(88,166,255,0.4);
  }
  .prose-sm :global(.callout-source > h2),
  .prose-sm :global(.callout-source > h3) { color: #79c0ff; }
  .prose-sm :global(.callout-data) {
    background: rgba(210,153,34,0.04);
    border-color: rgba(210,153,34,0.15);
    border-left: 2px solid rgba(210,153,34,0.35);
  }
  .prose-sm :global(.section-break) {
    height: 0;
    margin: 0.8em 0 0.3em;
    border-top: 1px solid rgba(48,54,61,0.3);
  }

  .log-section {
    padding: 8px 14px;
    border-top: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex-shrink: 0;
    max-height: 120px;
    overflow-y: auto;
  }
  .log-line {
    font-size: 11px;
    color: var(--text-dim);
  }

  /* ── Typing indicator ──────────────────────────────────────────────── */
  .event.streaming {
    border-left: 3px solid var(--accent);
    padding-left: 11px;
    background: rgba(63,185,80,0.03);
    align-items: center;
  }

  .typing-label {
    font-size: 11px;
    font-style: italic;
  }

  .typing-indicator {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    margin-left: 6px;
    vertical-align: middle;
  }

  .typing-dot {
    display: inline-block;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: var(--accent);
    animation: typing-bounce 1.2s ease-in-out infinite;
  }
  .typing-dot:nth-child(2) { animation-delay: 0.2s; }
  .typing-dot:nth-child(3) { animation-delay: 0.4s; }

  @keyframes typing-bounce {
    0%, 60%, 100% { opacity: 0.3; transform: translateY(0); }
    30% { opacity: 1; transform: translateY(-3px); }
  }

</style>
