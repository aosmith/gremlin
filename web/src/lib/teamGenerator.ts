/**
 * AI-powered team generator — describes your needs, gets a tailored agent team.
 */

import { callLLM } from './api'
import type { AgentConfig, Settings } from './types'
import { AGENT_COLORS } from './types'

export interface GeneratedTeam {
  name: string
  icon: string
  description: string
  agents: AgentConfig[]
}

const SYSTEM_PROMPT = `You are a team architect for GREMLIN, a multi-agent coordination system.
The user will describe their needs in plain language. Design a team of 5–8 specialist agents.

Requirements:
- Exactly 1 agent with role "orchestrator" (decomposes tasks, assigns work)
- Exactly 1 agent with role "synthesizer" (integrates all outputs into a final answer)
- 3–6 agents with role "worker" (domain specialists)
- Each agent needs a unique snake_case id (e.g. "market_analyst", "risk_manager")
- Each agent needs a detailed, domain-specific systemPrompt (2-4 sentences minimum)
- Choose a short mode name (1-3 words), a single emoji icon, and a one-line description

Respond with ONLY valid JSON (no markdown, no explanation):

{
  "name": "Mode Name",
  "icon": "🎯",
  "description": "One-line description of this mode",
  "agents": [
    {
      "id": "orchestrator_id",
      "name": "Display Name",
      "role": "orchestrator",
      "systemPrompt": "Detailed system prompt..."
    },
    {
      "id": "worker_id",
      "name": "Display Name",
      "role": "worker",
      "systemPrompt": "Detailed system prompt..."
    },
    {
      "id": "synthesizer_id",
      "name": "Display Name",
      "role": "synthesizer",
      "systemPrompt": "Detailed system prompt..."
    }
  ]
}`

export async function generateTeam(
  description: string,
  settings: Settings,
  signal?: AbortSignal,
): Promise<GeneratedTeam> {
  const raw = await callLLM(
    SYSTEM_PROMPT,
    [{ role: 'user', content: description }],
    settings,
    undefined,
    signal,
  )
  return parseTeamResponse(raw)
}

function parseTeamResponse(raw: string): GeneratedTeam {
  // Strip <think>…</think> blocks (reasoning models)
  const noThink = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  // Strip markdown fences
  const stripped = noThink.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')
  const start = stripped.indexOf('{')
  const end = stripped.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('No JSON object found in response')

  const parsed = JSON.parse(stripped.slice(start, end + 1))

  if (!parsed.name || !Array.isArray(parsed.agents) || parsed.agents.length < 2) {
    throw new Error('Invalid team structure: needs name and at least 2 agents')
  }

  const agents: AgentConfig[] = parsed.agents.map((a: any, i: number) => ({
    id: String(a.id || `agent_${i}`),
    name: String(a.name || a.id || `Agent ${i + 1}`),
    role: (['orchestrator', 'worker', 'synthesizer'].includes(a.role) ? a.role : 'worker') as AgentConfig['role'],
    systemPrompt: String(a.systemPrompt || ''),
    color: AGENT_COLORS[i % AGENT_COLORS.length],
  }))

  return {
    name: String(parsed.name),
    icon: String(parsed.icon || '★'),
    description: String(parsed.description || ''),
    agents,
  }
}
