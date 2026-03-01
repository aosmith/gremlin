/**
 * Tool definitions exposed to agents in dev mode.
 * Covers the full CRUD surface for a project directory.
 */

import { projectFS } from './filesystem'

// ── OpenAI-format tool definitions ────────────────────────────────────────────

export interface OAIToolParam {
  type: string
  description: string
  enum?: string[]
}

export interface OAITool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, OAIToolParam>
      required: string[]
    }
  }
}

export const DEV_TOOLS: OAITool[] = [
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Write (create or overwrite) a file in the project directory. ' +
        'Parent directories are created automatically. ' +
        'Always write complete file contents — never partial.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to project root, e.g. "src/App.tsx"' },
          content: { type: 'string', description: 'Complete file content' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the full content of an existing file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to project root' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List files and sub-directories at a path. Use "/" for the project root.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path relative to project root' },
        },
        required: ['path'],
      },
    },
  },
]

// ── Anthropic-format tool definitions ─────────────────────────────────────────
// Derived from DEV_TOOLS so they stay in sync automatically.

export function toAnthropicTools(tools: OAITool[]) {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }))
}

// ── Tool executor ─────────────────────────────────────────────────────────────

export interface ToolCallRecord {
  id: string
  name: string
  args: Record<string, unknown>
  result: string
  isError: boolean
}

export async function executeTool(
  id: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallRecord> {
  try {
    let result = ''
    switch (name) {
      case 'write_file': {
        const { path, content } = args as { path: string; content: string }
        await projectFS.writeFile(path, content)
        result = `Written ${path} (${content.length.toLocaleString()} chars)`
        break
      }
      case 'read_file': {
        const { path } = args as { path: string }
        result = await projectFS.readFile(path)
        break
      }
      case 'list_directory': {
        const { path = '/' } = args as { path?: string }
        const entries = await projectFS.listDirectory(path)
        result = entries
          .map((e) => `${e.kind === 'directory' ? '📁' : '📄'} ${e.name}`)
          .join('\n') || '(empty)'
        break
      }
      default:
        throw new Error(`Unknown tool: ${name}`)
    }
    return { id, name, args, result, isError: false }
  } catch (err) {
    const result = err instanceof Error ? err.message : String(err)
    return { id, name, args, result, isError: true }
  }
}
