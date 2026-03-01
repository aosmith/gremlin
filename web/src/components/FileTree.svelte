<script lang="ts">
  interface Props {
    files: string[]
    selectedFile: string | null
    onselect: (path: string) => void
  }
  const { files, selectedFile, onselect }: Props = $props()

  // ── Tree building ──────────────────────────────────────────────────────────
  interface TreeNode {
    name: string
    path: string
    kind: 'file' | 'directory'
    children: TreeNode[]
  }

  function buildTree(paths: string[]): TreeNode[] {
    const root: TreeNode = { name: '', path: '', kind: 'directory', children: [] }
    for (const filePath of paths) {
      const parts = filePath.split('/').filter(Boolean)
      let cur = root
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]
        const isFile = i === parts.length - 1
        let node = cur.children.find((n) => n.name === part)
        if (!node) {
          node = { name: part, path: parts.slice(0, i + 1).join('/'), kind: isFile ? 'file' : 'directory', children: [] }
          cur.children.push(node)
        }
        if (!isFile) cur = node
      }
    }
    // Sort: directories first, then files, each alphabetically
    const sortNodes = (nodes: TreeNode[]): TreeNode[] => {
      return [...nodes].sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
        return a.name.localeCompare(b.name)
      }).map((n) => ({ ...n, children: sortNodes(n.children) }))
    }
    return sortNodes(root.children)
  }

  const tree = $derived(buildTree(files))

  // Track which directories are open
  let openDirs = $state<Set<string>>(new Set())

  function toggleDir(path: string) {
    const next = new Set(openDirs)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    openDirs = next
  }

  // Auto-open parent dirs when a file is selected
  $effect(() => {
    if (!selectedFile) return
    const parts = selectedFile.split('/')
    const next = new Set(openDirs)
    for (let i = 1; i < parts.length; i++) {
      next.add(parts.slice(0, i).join('/'))
    }
    openDirs = next
  })

  // Simple extension → icon mapping
  function fileIcon(name: string): string {
    const ext = name.split('.').pop()?.toLowerCase() ?? ''
    const icons: Record<string, string> = {
      ts: '🔷', tsx: '⚛', js: '📜', jsx: '⚛', svelte: '🧡',
      css: '🎨', scss: '🎨', html: '🌐', json: '📋', md: '📝',
      rs: '🦀', toml: '⚙', yaml: '⚙', yml: '⚙', env: '🔒',
      py: '🐍', go: '🐹', rb: '💎', sh: '🖥', sql: '🗄',
      png: '🖼', jpg: '🖼', jpeg: '🖼', gif: '🖼', svg: '🖼',
      wasm: '⚡',
    }
    return icons[ext] ?? '📄'
  }
</script>

{#if files.length === 0}
  <div class="empty">No files yet</div>
{:else}
  <ul class="tree">
    {#each tree as node (node.path)}
      <li>
        {#if node.kind === 'directory'}
          <button
            class="dir-btn"
            onclick={() => toggleDir(node.path)}
            title={node.path}
          >
            <span class="arrow" class:open={openDirs.has(node.path)}>›</span>
            <span class="dir-icon">📁</span>
            <span class="name">{node.name}</span>
          </button>
          {#if openDirs.has(node.path) && node.children.length > 0}
            <ul class="subtree">
              {#each node.children as child (child.path)}
                <li>
                  {#if child.kind === 'directory'}
                    <button class="dir-btn" onclick={() => toggleDir(child.path)} title={child.path}>
                      <span class="arrow" class:open={openDirs.has(child.path)}>›</span>
                      <span class="dir-icon">📁</span>
                      <span class="name">{child.name}</span>
                    </button>
                    {#if openDirs.has(child.path) && child.children.length > 0}
                      <ul class="subtree">
                        {#each child.children as grandchild (grandchild.path)}
                          <li>
                            <button
                              class="file-btn"
                              class:active={selectedFile === grandchild.path}
                              onclick={() => grandchild.kind === 'file' && onselect(grandchild.path)}
                              title={grandchild.path}
                            >
                              <span class="file-icon">{grandchild.kind === 'file' ? fileIcon(grandchild.name) : '📁'}</span>
                              <span class="name">{grandchild.name}</span>
                            </button>
                          </li>
                        {/each}
                      </ul>
                    {/if}
                  {:else}
                    <button
                      class="file-btn"
                      class:active={selectedFile === child.path}
                      onclick={() => onselect(child.path)}
                      title={child.path}
                    >
                      <span class="file-icon">{fileIcon(child.name)}</span>
                      <span class="name">{child.name}</span>
                    </button>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        {:else}
          <button
            class="file-btn"
            class:active={selectedFile === node.path}
            onclick={() => onselect(node.path)}
            title={node.path}
          >
            <span class="file-icon">{fileIcon(node.name)}</span>
            <span class="name">{node.name}</span>
          </button>
        {/if}
      </li>
    {/each}
  </ul>
{/if}

<style>
  .empty {
    font-size: 11px;
    color: var(--color-text-4);
    padding: 10px 12px;
    font-style: italic;
  }

  ul, li {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .tree { padding: 4px 0; }

  .subtree {
    padding-left: 16px;
    border-left: 1px solid var(--glass-border);
    margin-left: 10px;
  }

  .dir-btn, .file-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    border-radius: 4px;
    padding: 2px 6px;
    cursor: pointer;
    font-size: 12px;
    color: var(--color-text-2);
    min-height: 24px;
    height: auto;
    transition: background var(--t-fast), color var(--t-fast);
  }

  .dir-btn:hover  { background: var(--glass); color: var(--color-text); }
  .file-btn:hover { background: var(--glass); color: var(--color-text); }
  .file-btn.active {
    background: var(--glass-tinted);
    color: var(--color-accent);
    border: 1px solid var(--glass-tinted-border);
  }

  .arrow {
    font-size: 12px;
    color: var(--color-text-4);
    width: 12px;
    flex-shrink: 0;
    transition: transform var(--t-fast);
    display: inline-block;
  }
  .arrow.open { transform: rotate(90deg); }

  .dir-icon, .file-icon {
    font-size: 13px;
    flex-shrink: 0;
    line-height: 1;
  }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
</style>
