<!-- Agent detail panel: shows conversation history + human-in-the-loop input -->
<script lang="ts">
  import type { AgentState, Message } from '../lib/types'
  import { store } from '../lib/store.svelte'
  import { tick } from 'svelte'

  interface Props {
    agent: AgentState
    messages: Message[]
    onclose: () => void
  }
  const { agent, messages, onclose }: Props = $props()

  let humanInput = $state('')
  let scrollEl = $state<HTMLDivElement | undefined>(undefined)

  const agentMessages = $derived(
    messages.filter(
      (m) =>
        m.fromAgent === agent.id ||
        m.toAgent === agent.id ||
        m.toAgent === 'broadcast',
    ),
  )

  $effect(() => {
    void agentMessages.length
    tick().then(() => {
      if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight
    })
  })

  function agentName(id: string): string {
    if (id === 'user') return 'You'
    if (id === 'system') return 'System'
    const found = store.agentConfigs.find((a) => a.id === id)
    return found?.name ?? id
  }

  function agentColor(id: string): string {
    if (id === 'user') return '#58a6ff'
    if (id === 'system') return 'var(--text-dim)'
    const found = store.agentConfigs.find((a) => a.id === id)
    return found?.color ?? 'var(--text-muted)'
  }

  function formatTime(ts: number): string {
    return new Date(ts).toLocaleTimeString(undefined, {
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    })
  }

  function sendHuman() {
    const content = humanInput.trim()
    if (!content) return
    store.injectHumanMessage(agent.id, content)
    humanInput = ''
  }
</script>

<div class="panel">
  <div class="panel-header">
    <div class="panel-title">
      <span class="dot {agent.status}"></span>
      <span style="color: {agent.color}">{agent.name}</span>
      <span class="role muted">/ {agent.role}</span>
    </div>
    <button class="ghost icon" onclick={onclose} title="Close">✕</button>
  </div>

  <div class="panel-body">
    <div class="section-label">Conversation</div>
    <div class="conversation" bind:this={scrollEl}>
      {#if agentMessages.length === 0}
        <div class="empty-conv muted">No messages yet</div>
      {/if}
      {#each agentMessages as msg (msg.id)}
        <div class="msg" class:outgoing={msg.fromAgent === agent.id}>
          <div class="msg-meta">
            <span class="msg-from" style="color: {agentColor(msg.fromAgent)}">{agentName(msg.fromAgent)}</span>
            {#if msg.fromAgent !== agent.id}
              <span class="msg-arrow muted">→</span>
              <span class="msg-to" style="color: {agentColor(msg.toAgent)}">{agentName(msg.toAgent)}</span>
            {/if}
            <span class="msg-time muted mono">{formatTime(msg.timestamp)}</span>
          </div>
          <div class="msg-content">{msg.content}</div>
        </div>
      {/each}
    </div>

    <div class="human-input-section">
      <div class="section-label">Send direct message to {agent.name}</div>
      <div class="input-row">
        <textarea
          bind:value={humanInput}
          placeholder="Type a direction or message for this agent…"
          rows="3"
          onkeydown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendHuman()
          }}
        ></textarea>
        <button
          class="primary send-btn"
          onclick={sendHuman}
          disabled={!humanInput.trim() || !store.isRunning}
          title={store.isRunning ? 'Send (Ctrl+Enter)' : 'Start a run first'}
        >
          Send
        </button>
      </div>
      {#if !store.isRunning}
        <small class="muted">Agent must be in an active run to receive messages</small>
      {/if}
    </div>

    <div class="agent-info">
      <div class="section-label">System Prompt</div>
      <pre class="prompt-preview">{agent.systemPrompt}</pre>
    </div>
  </div>
</div>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .panel-title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 600;
    font-size: 14px;
  }
  .role { font-size: 12px; }

  .panel-body {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .section-label {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--text-dim);
    padding: 10px 14px 4px;
    flex-shrink: 0;
  }

  .conversation {
    flex: 1;
    overflow-y: auto;
    padding: 0 14px 8px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 120px;
    max-height: 280px;
  }

  .empty-conv {
    font-size: 12px;
    padding: 12px 0;
    text-align: center;
  }

  .msg {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 8px 10px;
    border-radius: 5px;
    background: var(--surface-2);
    border: 1px solid var(--border);
  }
  .msg.outgoing {
    background: rgba(63,185,80,0.06);
    border-color: rgba(63,185,80,0.25);
  }

  .msg-meta {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
  }
  .msg-from { font-weight: 700; font-family: var(--font-mono); }
  .msg-to   { font-family: var(--font-mono); }
  .msg-time { margin-left: auto; }

  .msg-content {
    font-size: 12.5px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .human-input-section {
    flex-shrink: 0;
    padding: 0 14px 8px;
    display: flex;
    flex-direction: column;
    gap: 5px;
    border-top: 1px solid var(--border);
    padding-top: 8px;
  }

  .input-row {
    display: flex;
    gap: 8px;
    align-items: flex-end;
  }
  .input-row textarea {
    flex: 1;
    min-height: 66px;
    font-size: 12px;
  }
  .send-btn {
    flex-shrink: 0;
    align-self: flex-end;
  }

  .agent-info {
    flex-shrink: 0;
    border-top: 1px solid var(--border);
  }

  .prompt-preview {
    font-size: 11px;
    font-family: var(--font-mono);
    color: var(--text-muted);
    padding: 8px 14px 14px;
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.6;
  }
</style>
