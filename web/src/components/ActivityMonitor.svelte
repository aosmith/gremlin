<script lang="ts">
  import type { AgentConfig, Message } from '../lib/types'
  import { cleanContent } from '../lib/cleanContent'
  import { enhanceProse } from '../lib/tableCards'
  import { sanitizeHtml } from '../lib/sanitize'
  import { marked } from 'marked'
  import { tick } from 'svelte'

  interface Props {
    messages: Message[]
    agents: AgentConfig[]
    logs: string[]
    streamingAgentId?: string | null
    streamingText?: string
    outputHtml?: string
    isRunning?: boolean
    onCopy?: () => void
    onReply?: (text: string) => void
    onRetry?: (agentId: string) => void
  }
  const { messages, agents, logs, streamingAgentId = null, streamingText = '', outputHtml = '', isRunning = false, onCopy, onReply, onRetry }: Props = $props()

  let replyText = $state('')

  function sendReply() {
    const text = replyText.trim()
    if (!text || !onReply) return
    replyText = ''
    onReply(text)
  }

  // Messages always expand fully — no truncation

  let scrollEl = $state<HTMLDivElement | undefined>(undefined)
  let logEl = $state<HTMLDivElement | undefined>(undefined)

  const agentMap = $derived(new Map(agents.map((a) => [a.id, a])))

  function agentColor(id: string): string {
    return agentMap.get(id)?.color ?? 'var(--color-text-3)'
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

  <div class="feed" bind:this={scrollEl} role="log" aria-live="polite" aria-label="Agent activity feed">
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
        <span class="badge {msg.type === 'task' ? 'badge-warn' : msg.type === 'error' ? 'badge-error' : msg.type === 'human' ? 'badge-info' : msg.type === 'result' ? 'badge-accent' : 'badge-default'}">{msg.type}</span>
        {#if msg.type === 'error' && onRetry && isRunning}
          <button class="btn-retry" onclick={() => onRetry(msg.fromAgent)} aria-label="Retry {agentName(msg.fromAgent)}">Retry</button>
        {/if}
        <div class="content prose-sm">{@html sanitizeHtml(enhanceProse(marked.parse(cleanContent(msg.content)) as string))}</div>
      </div>
    {/each}

    {#if streamingAgentId && streamingText}
      {@const displayText = streamingText.replace(/<think>[\s\S]*?(<\/think>|$)/gi, '').trim()}
      <div class="event streaming">
        <span class="route">
          <span class="agent-name" style="color: {agentColor(streamingAgentId)}">{agentName(streamingAgentId)}</span>
          <span class="streaming-badge">streaming</span>
        </span>
        {#if displayText}
          <div class="content prose-sm streaming-content">{displayText}</div>
        {:else}
          <span class="typing-indicator">
            <span class="typing-dot"></span>
            <span class="typing-dot"></span>
            <span class="typing-dot"></span>
          </span>
        {/if}
      </div>
    {/if}

    {#if outputHtml && !isRunning}
      <div class="final-result">
        <div class="final-result-header">
          <span class="result-dot"></span>
          <span class="result-label">Result</span>
          {#if onCopy}
            <button class="ghost btn-sm" onclick={onCopy}>Copy</button>
          {/if}
        </div>
        <div class="result-body prose-sm">{@html sanitizeHtml(outputHtml)}</div>
        {#if onReply}
          <div class="reply-bar">
            <input
              class="reply-input"
              type="text"
              placeholder="Ask a follow-up…"
              bind:value={replyText}
              onkeydown={(e) => e.key === 'Enter' && sendReply()}
            />
            <button
              class="primary reply-btn"
              onclick={sendReply}
              disabled={!replyText.trim()}
            >Reply</button>
          </div>
        {/if}
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
    border: 1px solid var(--glass-border);
    border-radius: var(--radius);
    background: var(--color-surface);
  }

  .monitor-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 14px;
    border-bottom: 1px solid var(--glass-border);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .label { color: var(--color-accent); }
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
    color: var(--color-text-4);
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

  .event.task    { border-left: 3px solid var(--color-accent-warn); padding-left: 11px; }
  .event.error   { border-left: 3px solid var(--color-accent-err);  padding-left: 11px; background: rgba(248,81,73,0.04); }
  .event.human   { border-left: 3px solid #58a6ff;           padding-left: 11px; background: rgba(88,166,255,0.04); }
  .event.system  { border-left: 3px solid var(--color-text-4);   padding-left: 11px; }
  .event.result  { border-left: 3px solid var(--color-accent);     padding-left: 11px; }

  .time {
    color: var(--color-text-4);
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
  .arrow { color: var(--color-text-4); }

  .content {
    width: 100%;
    color: var(--color-text);
    font-size: 12.5px;
    line-height: 1.5;
    word-break: break-word;
    padding-top: 3px;
  }

  /* ── Final result block ──────────────────────────────────────────── */
  .final-result {
    margin: 8px 10px 12px;
    border: 1px solid rgba(63,185,80,0.25);
    border-radius: 8px;
    background: rgba(63,185,80,0.03);
    animation: result-in 0.3s ease-out;
  }
  @keyframes result-in {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  .final-result-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    border-bottom: 1px solid rgba(63,185,80,0.15);
  }
  .result-dot {
    width: 7px; height: 7px;
    border-radius: 50%;
    background: var(--color-accent);
    box-shadow: 0 0 8px rgba(63,185,80,0.6);
    flex-shrink: 0;
  }
  .result-label {
    font-size: 11px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--color-accent);
    flex: 1;
  }
  .result-body {
    padding: 14px 16px;
    font-size: 13px;
    line-height: 1.65;
  }
  .reply-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px 10px;
    border-top: 1px solid rgba(63,185,80,0.12);
  }
  .reply-input {
    flex: 1;
    background: rgba(255,255,255,0.03);
    border: 1px solid rgba(48,54,61,0.5);
    border-radius: 5px;
    color: var(--color-text);
    font-size: 12px;
    padding: 6px 10px;
    outline: none;
    transition: all 0.15s ease;
  }
  .reply-input:focus {
    background: rgba(63,185,80,0.04);
    border-color: rgba(63,185,80,0.3);
    box-shadow: 0 0 0 2px rgba(63,185,80,0.08);
  }
  .reply-btn {
    flex-shrink: 0;
  }
  .btn-sm { font-size: 11px; }

  .log-section {
    padding: 8px 14px;
    border-top: 1px solid var(--glass-border);
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex-shrink: 0;
    max-height: 120px;
    overflow-y: auto;
  }
  .log-line {
    font-size: 11px;
    color: var(--color-text-4);
  }

  /* ── Typing indicator ──────────────────────────────────────────────── */
  .event.streaming {
    border-left: 3px solid var(--color-accent);
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
    background: var(--color-accent);
    animation: typing-bounce 1.2s ease-in-out infinite;
  }
  .typing-dot:nth-child(2) { animation-delay: 0.2s; }
  .typing-dot:nth-child(3) { animation-delay: 0.4s; }

  @keyframes typing-bounce {
    0%, 60%, 100% { opacity: 0.3; transform: translateY(0); }
    30% { opacity: 1; transform: translateY(-3px); }
  }

  .streaming-badge {
    display: inline-block;
    font-size: 9px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-accent);
    background: rgba(63,185,80,0.1);
    border: 1px solid rgba(63,185,80,0.25);
    border-radius: 3px;
    padding: 1px 5px;
    margin-left: 6px;
    animation: pulse-badge 2s ease-in-out infinite;
  }

  @keyframes pulse-badge {
    0%, 100% { opacity: 0.7; }
    50% { opacity: 1; }
  }

  .streaming-content {
    white-space: pre-wrap;
    opacity: 0.7;
    max-height: 300px;
    overflow-y: auto;
    mask-image: linear-gradient(to bottom, black 70%, transparent 100%);
    -webkit-mask-image: linear-gradient(to bottom, black 70%, transparent 100%);
  }

</style>
