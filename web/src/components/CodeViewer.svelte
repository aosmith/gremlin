<script lang="ts">
  import { projectFS } from '../lib/filesystem'

  interface Props {
    path: string | null
    onclose: () => void
  }
  const { path, onclose }: Props = $props()

  let content   = $state<string | null>(null)
  let loading   = $state(false)
  let error     = $state<string | null>(null)

  $effect(() => {
    if (!path) { content = null; error = null; return }
    loading = true
    error   = null
    projectFS.readFile(path)
      .then((txt) => { content = txt; loading = false })
      .catch((err) => { error = err instanceof Error ? err.message : String(err); loading = false })
  })

  // Line numbers
  const lines = $derived(content ? content.split('\n') : [])

  // File language hint (for label)
  const lang = $derived(
    (() => {
      if (!path) return ''
      const ext = path.split('.').pop()?.toLowerCase() ?? ''
      const map: Record<string, string> = {
        ts: 'TypeScript', tsx: 'TSX', js: 'JavaScript', jsx: 'JSX',
        svelte: 'Svelte', css: 'CSS', html: 'HTML', json: 'JSON',
        md: 'Markdown', rs: 'Rust', toml: 'TOML', py: 'Python',
        go: 'Go', sh: 'Shell', yaml: 'YAML', yml: 'YAML', sql: 'SQL',
      }
      return map[ext] ?? ext.toUpperCase()
    })()
  )

  function copyToClipboard() {
    if (content) navigator.clipboard.writeText(content)
  }
</script>

<div class="viewer">
  <div class="viewer-header">
    <div class="path-row">
      <span class="path-icon">📄</span>
      <span class="path-text" title={path ?? ''}>{path ?? '—'}</span>
      {#if lang}
        <span class="lang-badge">{lang}</span>
      {/if}
    </div>
    <div class="header-actions">
      {#if content}
        <button class="ghost" onclick={copyToClipboard} title="Copy to clipboard" style="font-size:11px">
          ⎘ Copy
        </button>
      {/if}
      <button class="ghost icon" onclick={onclose} title="Close">✕</button>
    </div>
  </div>

  <div class="viewer-body">
    {#if loading}
      <div class="status-msg muted">Loading…</div>
    {:else if error}
      <div class="status-msg err">✖ {error}</div>
    {:else if content === null}
      <div class="status-msg muted">Select a file to view its contents.</div>
    {:else if lines.length === 0}
      <div class="status-msg muted">(empty file)</div>
    {:else}
      <div class="code-wrap">
        <div class="line-nums" aria-hidden="true">
          {#each lines as _, i}
            <span>{i + 1}</span>
          {/each}
        </div>
        <pre class="code-content"><code>{content}</code></pre>
      </div>
    {/if}
  </div>
</div>

<style>
  .viewer {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: rgba(9, 12, 18, 0.6);
    border: 1px solid var(--glass-border);
    border-radius: var(--radius);
    overflow: hidden;
  }

  /* Header */
  .viewer-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 10px;
    border-bottom: 1px solid var(--glass-border);
    background: var(--glass);
    flex-shrink: 0;
    gap: 8px;
    min-height: 36px;
  }

  .path-row {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    flex: 1;
  }
  .path-icon { font-size: 13px; flex-shrink: 0; }
  .path-text {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--color-accent-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .lang-badge {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 1px 5px;
    border-radius: 3px;
    background: var(--glass-blue);
    border: 1px solid var(--glass-blue-border);
    color: var(--color-accent-2);
    flex-shrink: 0;
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }

  /* Body */
  .viewer-body {
    flex: 1;
    overflow: auto;
    min-height: 0;
  }

  .status-msg {
    padding: 16px;
    font-size: 12px;
  }
  .status-msg.err { color: var(--color-accent-err); }

  /* Code */
  .code-wrap {
    display: flex;
    min-height: 100%;
  }

  .line-nums {
    display: flex;
    flex-direction: column;
    padding: 12px 10px 12px 12px;
    font-family: var(--font-mono);
    font-size: 11.5px;
    line-height: 1.65;
    color: var(--color-text-4);
    text-align: right;
    user-select: none;
    border-right: 1px solid var(--glass-border);
    background: rgba(0, 0, 0, 0.15);
    flex-shrink: 0;
    min-width: 42px;
  }

  .code-content {
    flex: 1;
    margin: 0;
    padding: 12px 16px;
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.65;
    color: var(--color-text);
    white-space: pre;
    overflow-x: auto;
    background: none;
  }
</style>
