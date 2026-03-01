/**
 * Thin wrapper around the browser's File System Access API.
 * Agents write/read files here; the rest of the app observes via the store.
 */

export class ProjectFileSystem {
  private root: FileSystemDirectoryHandle | null = null
  public rootName = ''

  get isOpen() { return this.root !== null }

  async open(): Promise<string> {
    this.root = await window.showDirectoryPicker({ mode: 'readwrite' })
    this.rootName = this.root.name
    return this.root.name
  }

  close() {
    this.root = null
    this.rootName = ''
  }

  private async resolveDir(parts: string[]): Promise<FileSystemDirectoryHandle> {
    let dir = this.requireRoot()
    for (const part of parts) {
      dir = await dir.getDirectoryHandle(part, { create: true })
    }
    return dir
  }

  private requireRoot(): FileSystemDirectoryHandle {
    if (!this.root) throw new Error('No project directory open — select a folder first')
    return this.root
  }

  private parsePath(path: string): string[] {
    return path.replace(/^\//, '').split('/').filter(Boolean)
  }

  async writeFile(path: string, content: string): Promise<void> {
    const parts = this.parsePath(path)
    if (parts.length === 0) throw new Error('Invalid path')
    const dir = await this.resolveDir(parts.slice(0, -1))
    const fh = await dir.getFileHandle(parts.at(-1)!, { create: true })
    const w = await fh.createWritable()
    await w.write(content)
    await w.close()
  }

  async readFile(path: string): Promise<string> {
    const parts = this.parsePath(path)
    let dir = this.requireRoot()
    for (const part of parts.slice(0, -1)) {
      dir = await dir.getDirectoryHandle(part)
    }
    const fh = await dir.getFileHandle(parts.at(-1)!)
    const file = await fh.getFile()
    return file.text()
  }

  async listDirectory(path = '/'): Promise<Array<{ name: string; kind: 'file' | 'directory' }>> {
    let dir = this.requireRoot()
    for (const part of this.parsePath(path)) {
      dir = await dir.getDirectoryHandle(part)
    }
    const entries: Array<{ name: string; kind: 'file' | 'directory' }> = []
    for await (const [name, handle] of dir.entries()) {
      entries.push({ name, kind: handle.kind as 'file' | 'directory' })
    }
    return entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  }

  /** Recursively collect all file paths (for FileTree). */
  async getAllFilePaths(
    dir?: FileSystemDirectoryHandle,
    prefix = '',
  ): Promise<string[]> {
    const d = dir ?? this.requireRoot()
    const paths: string[] = []
    for await (const [name, handle] of d.entries()) {
      const p = prefix ? `${prefix}/${name}` : name
      if (handle.kind === 'file') {
        paths.push(p)
      } else {
        const sub = await this.getAllFilePaths(handle as FileSystemDirectoryHandle, p)
        paths.push(...sub)
      }
    }
    return paths.sort()
  }
}

export const projectFS = new ProjectFileSystem()
