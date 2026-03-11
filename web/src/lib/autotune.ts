/**
 * Auto-tune engine: detect hardware, recommend models, apply optimal config.
 */

import type { AgentConfig } from './types'

// ── Hardware & model detection ────────────────────────────────────────────────

export async function detectHardware(): Promise<HardwareProfile> {
  try {
    const resp = await fetch('/api/system-info')
    if (resp.ok) return await resp.json()
  } catch { /* fallback */ }
  return {
    platform: navigator.platform,
    arch: 'unknown',
    totalMemoryGB: (navigator as any).deviceMemory ?? 8,
    gpuName: 'Unknown',
    gpuMemoryGB: (navigator as any).deviceMemory ?? 8,
    cpuCores: navigator.hardwareConcurrency ?? 4,
  }
}

export async function detectOllamaModels(endpoint: string): Promise<InstalledModel[]> {
  try {
    const base = endpoint.replace(/\/v1.*$/, '')
    const resp = await fetch(`${base}/api/tags`)
    if (!resp.ok) return []
    const data = await resp.json()
    return (data.models ?? []).map((m: any) => {
      const { family, parameterSize } = parseModelFamily(m.name)
      return { name: m.name, sizeGB: Math.round(m.size / 1e9 * 10) / 10, family, parameterSize }
    })
  } catch { return [] }
}

export async function isOllamaRunning(endpoint: string): Promise<boolean> {
  try {
    const base = endpoint.replace(/\/v1.*$/, '')
    const resp = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(3000) })
    return resp.ok
  } catch { return false }
}

// ── Types ──────────────────────────────────────────────────────────────────────

export interface HardwareProfile {
  platform: string
  arch: string
  totalMemoryGB: number
  gpuName: string
  gpuMemoryGB: number
  cpuCores: number
}

export interface InstalledModel {
  name: string
  sizeGB: number
  family: string
  parameterSize: string
}

export interface TuneWarning {
  text: string
  /** Model to pull to resolve this warning (null if no action available) */
  pullModel: string | null
}

export interface TuneRecommendation {
  strategy: 'single-model' | 'dual-model' | 'multi-model'
  assignments: Record<string, string>
  globalModel: string
  reasoning: string
  warnings: TuneWarning[]
  suggestedModels: SuggestedModel[]
}

export interface SuggestedModel {
  name: string
  sizeGB: number
  reason: string
  pullCommand: string
  installed: boolean
}

// ── Agent role classification ──────────────────────────────────────────────────

type AgentRoleClass = 'orchestrator' | 'code' | 'reasoning' | 'research' | 'synthesis' | 'general'

const CODE_KEYWORDS = ['Dev', 'Eng', 'QA', 'DevOps', 'Security Eng', 'Simplicity', 'coder']
const REASONING_KEYWORDS = ['Analyst', 'Critic', 'Risk', 'Probability', 'Arbitrage', 'Quality', 'Internist', 'Radiologist', 'Lab Medicine']
const RESEARCH_KEYWORDS = ['Researcher', 'News', 'Filings', 'Sector', 'Whale', 'Pharmacist', 'Supply Chain', 'Commercial']

export function classifyAgentRole(agent: AgentConfig): AgentRoleClass {
  if (agent.role === 'orchestrator') return 'orchestrator'
  if (agent.role === 'synthesizer') return 'synthesis'
  const name = agent.name
  if (CODE_KEYWORDS.some(k => name.includes(k))) return 'code'
  if (REASONING_KEYWORDS.some(k => name.includes(k))) return 'reasoning'
  if (RESEARCH_KEYWORDS.some(k => name.includes(k))) return 'research'
  return 'general'
}

// ── Model name parsing ─────────────────────────────────────────────────────────

export function parseModelFamily(name: string): { family: string; parameterSize: string } {
  const parts = name.split(':')
  const baseName = parts[0]
  const tag = parts[1] || ''
  const sizeMatch = tag.match(/(\d+b)/i) || baseName.match(/(\d+b)/i)

  // Match against known families first (longest match wins to avoid prefix collisions)
  const knownFamilies = Object.keys(MODEL_CAPABILITIES).sort((a, b) => b.length - a.length)
  for (const fam of knownFamilies) {
    if (baseName === fam || baseName.startsWith(fam)) {
      return { family: fam, parameterSize: sizeMatch ? sizeMatch[1].toLowerCase() : '' }
    }
  }

  // Fallback: strip trailing version numbers (e.g. llama3.1 → llama3)
  const family = baseName.replace(/[-_]?\d+(\.\d+)?$/, '')
  return { family, parameterSize: sizeMatch ? sizeMatch[1].toLowerCase() : '' }
}

// ── Capability scoring ─────────────────────────────────────────────────────────

const MODEL_CAPABILITIES: Record<string, Record<AgentRoleClass, number>> = {
  'qwen3':         { orchestrator: 95, code: 70, reasoning: 75, research: 70, synthesis: 75, general: 85 },
  'qwen2.5-coder': { orchestrator: 50, code: 95, reasoning: 55, research: 40, synthesis: 50, general: 55 },
  'deepseek-r1':   { orchestrator: 55, code: 65, reasoning: 95, research: 65, synthesis: 80, general: 70 },
  'command-r':     { orchestrator: 50, code: 35, reasoning: 60, research: 95, synthesis: 55, general: 60 },
  'qwq':           { orchestrator: 55, code: 55, reasoning: 88, research: 55, synthesis: 95, general: 65 },
  'mistral-small': { orchestrator: 65, code: 60, reasoning: 55, research: 60, synthesis: 50, general: 80 },
  'llama3':        { orchestrator: 70, code: 65, reasoning: 70, research: 70, synthesis: 70, general: 80 },
  'gemma':         { orchestrator: 60, code: 70, reasoning: 65, research: 55, synthesis: 55, general: 70 },
  'phi':           { orchestrator: 55, code: 75, reasoning: 60, research: 45, synthesis: 50, general: 65 },
}

const DEFAULT_SCORES: Record<AgentRoleClass, number> = {
  orchestrator: 50, code: 50, reasoning: 50, research: 50, synthesis: 50, general: 50,
}

function getCapabilities(family: string): Record<AgentRoleClass, number> {
  return MODEL_CAPABILITIES[family] || DEFAULT_SCORES
}

function avgScore(caps: Record<AgentRoleClass, number>, roles: AgentRoleClass[]): number {
  if (roles.length === 0) return 0
  return roles.reduce((sum, r) => sum + caps[r], 0) / roles.length
}

// ── Ideal model families per role ─────────────────────────────────────────────

const IDEAL_FAMILIES: Record<AgentRoleClass, string> = {
  orchestrator: 'qwen3',
  code: 'qwen2.5-coder',
  reasoning: 'deepseek-r1',
  research: 'command-r',
  synthesis: 'qwq',
  general: 'mistral-small',
}

/** Specific Ollama model name to pull for each ideal family */
const IDEAL_MODELS: Record<string, string> = {
  'qwen3': 'qwen3:30b',
  'qwen2.5-coder': 'qwen2.5-coder:32b',
  'deepseek-r1': 'deepseek-r1:32b',
  'command-r': 'command-r:35b',
  'qwq': 'qwq:32b',
  'mistral-small': 'mistral-small:24b',
}

// ── Recommendation engine ──────────────────────────────────────────────────────

export function computeRecommendation(
  hardware: HardwareProfile,
  models: InstalledModel[],
  agents: AgentConfig[],
): TuneRecommendation {
  // Reserve 5GB for OS + apps; on Apple Silicon unified memory this is enough
  // since OLLAMA_NUM_CTX caps context so KV cache stays small.
  const usableVRAM = Math.max(hardware.gpuMemoryGB - 5, hardware.gpuMemoryGB * 0.5)
  const fittingModels = models.filter(m => m.sizeGB <= usableVRAM)
  const warnings: TuneWarning[] = []

  if (fittingModels.length === 0) {
    return {
      strategy: 'single-model',
      assignments: {},
      globalModel: models.length > 0 ? models[0].name : '',
      reasoning: 'No models fit within usable VRAM. Consider smaller models.',
      warnings: [{ text: 'No installed models fit within GPU memory budget.', pullModel: null }],
      suggestedModels: suggestModelsForHardware(hardware, models),
    }
  }

  // Classify all agent roles needed
  const agentRoles = agents.map(a => ({ agent: a, role: classifyAgentRole(a) }))
  const uniqueRoles = [...new Set(agentRoles.map(ar => ar.role))]

  // Pick strategy
  let strategy: TuneRecommendation['strategy']
  if (usableVRAM < 18) {
    strategy = 'single-model'
  } else if (usableVRAM < 32) {
    // Can we fit two models simultaneously?
    const canDual = findBestDualModels(fittingModels, uniqueRoles, usableVRAM)
    strategy = canDual ? 'dual-model' : 'single-model'
  } else {
    strategy = 'multi-model'
  }

  let assignments: Record<string, string> = {}
  let globalModel = ''
  let reasoning = ''

  if (strategy === 'single-model') {
    // Pick model with highest average score across needed roles
    let bestModel = fittingModels[0]
    let bestAvg = -1
    for (const m of fittingModels) {
      const caps = getCapabilities(m.family)
      const avg = avgScore(caps, uniqueRoles)
      if (avg > bestAvg) {
        bestAvg = avg
        bestModel = m
      }
    }
    globalModel = bestModel.name
    for (const ar of agentRoles) {
      assignments[ar.agent.id] = globalModel
    }
    reasoning = `Single model strategy: ${globalModel} (avg score ${bestAvg.toFixed(0)} across ${uniqueRoles.length} roles). VRAM budget: ${usableVRAM.toFixed(1)}GB.`

    // Warn about roles where the chosen model is weak (< 60)
    const caps = getCapabilities(bestModel.family)
    for (const role of uniqueRoles) {
      if (caps[role] < 60) {
        const idealFamily = IDEAL_FAMILIES[role]
        const idealModel = idealFamily ? IDEAL_MODELS[idealFamily] ?? null : null
        warnings.push({
          text: `${globalModel} scores only ${caps[role]} for '${role}' agents — consider a specialized model.`,
          pullModel: idealModel,
        })
      }
    }
  } else if (strategy === 'dual-model') {
    const dual = findBestDualModels(fittingModels, uniqueRoles, usableVRAM)!
    const [m1, m2] = dual
    const caps1 = getCapabilities(m1.family)
    const caps2 = getCapabilities(m2.family)

    // Assign each agent to whichever model is better for its role
    for (const ar of agentRoles) {
      assignments[ar.agent.id] = caps1[ar.role] >= caps2[ar.role] ? m1.name : m2.name
    }
    globalModel = caps1['general'] >= caps2['general'] ? m1.name : m2.name
    reasoning = `Dual model strategy: ${m1.name} + ${m2.name} (combined ${(m1.sizeGB + m2.sizeGB).toFixed(1)}GB, budget ${usableVRAM.toFixed(1)}GB).`
  } else {
    // Multi-model: assign best model per role
    const bestPerRole: Record<string, InstalledModel> = {}
    for (const role of uniqueRoles) {
      let best = fittingModels[0]
      let bestScore = -1
      for (const m of fittingModels) {
        const score = getCapabilities(m.family)[role]
        if (score > bestScore) {
          bestScore = score
          best = m
        }
      }
      bestPerRole[role] = best
    }
    for (const ar of agentRoles) {
      assignments[ar.agent.id] = bestPerRole[ar.role].name
    }
    // Global = best general model
    globalModel = bestPerRole['general']?.name || fittingModels[0].name
    const modelList = [...new Set(Object.values(bestPerRole).map(m => m.name))].join(', ')
    reasoning = `Multi-model strategy using ${modelList}. Each role gets its best-scoring model. VRAM budget: ${usableVRAM.toFixed(1)}GB.`
  }

  // Check for ideal model families not installed
  const installedFamilies = new Set(models.map(m => m.family))
  for (const role of uniqueRoles) {
    const ideal = IDEAL_FAMILIES[role]
    if (ideal && !installedFamilies.has(ideal)) {
      warnings.push({
        text: `Missing '${ideal}' — the top-rated family for '${role}' agents.`,
        pullModel: IDEAL_MODELS[ideal] ?? null,
      })
    }
  }

  return {
    strategy,
    assignments,
    globalModel,
    reasoning,
    warnings,
    suggestedModels: suggestModelsForHardware(hardware, models),
  }
}

// ── Dual model selection ───────────────────────────────────────────────────────

function findBestDualModels(
  models: InstalledModel[],
  roles: AgentRoleClass[],
  usableVRAM: number,
): [InstalledModel, InstalledModel] | null {
  let bestPair: [InstalledModel, InstalledModel] | null = null
  let bestCoverage = -1

  for (let i = 0; i < models.length; i++) {
    for (let j = i + 1; j < models.length; j++) {
      const m1 = models[i], m2 = models[j]
      if (m1.sizeGB + m2.sizeGB > usableVRAM) continue
      if (m1.family === m2.family) continue // no point in two of the same family

      const caps1 = getCapabilities(m1.family)
      const caps2 = getCapabilities(m2.family)
      // Coverage = sum of max(score1, score2) for each role
      const coverage = roles.reduce((sum, r) => sum + Math.max(caps1[r], caps2[r]), 0)
      if (coverage > bestCoverage) {
        bestCoverage = coverage
        bestPair = [m1, m2]
      }
    }
  }
  return bestPair
}

// ── Model suggestions based on hardware ────────────────────────────────────────

const SUGGESTION_TIERS: { maxVRAM: number; models: Omit<SuggestedModel, 'pullCommand'>[] }[] = [
  {
    maxVRAM: 8,
    models: [
      { name: 'qwen3:8b', sizeGB: 5, reason: 'Strong general-purpose model for limited VRAM' },
      { name: 'phi4:14b', sizeGB: 9, reason: 'Good coding and reasoning at small size' },
    ],
  },
  {
    maxVRAM: 16,
    models: [
      { name: 'qwen3:14b', sizeGB: 9, reason: 'Balanced orchestrator and general model' },
      { name: 'deepseek-r1:14b', sizeGB: 9, reason: 'Strong reasoning at mid-range size' },
      { name: 'mistral-small:24b', sizeGB: 14, reason: 'Fast general/tool-calling model' },
    ],
  },
  {
    maxVRAM: 24,
    models: [
      { name: 'qwen3:30b', sizeGB: 19, reason: 'Top orchestrator — fast MoE with 3.3B active params' },
      { name: 'deepseek-r1:32b', sizeGB: 20, reason: 'Best-in-class reasoning and analysis' },
      { name: 'command-r:35b', sizeGB: 19, reason: 'Built-in citations, ideal for research agents' },
      { name: 'qwq:32b', sizeGB: 20, reason: 'Purpose-built synthesis and reasoning' },
      { name: 'qwen2.5-coder:32b', sizeGB: 20, reason: 'Top coding model for engineering agents' },
      { name: 'mistral-small:24b', sizeGB: 14, reason: 'Fast general/tool-calling model' },
    ],
  },
  {
    maxVRAM: 48,
    models: [
      { name: 'qwen3:30b', sizeGB: 19, reason: 'Top orchestrator — fast MoE with 3.3B active params' },
      { name: 'deepseek-r1:32b', sizeGB: 20, reason: 'Best-in-class reasoning and analysis' },
      { name: 'command-r:35b', sizeGB: 19, reason: 'Built-in citations, ideal for research agents' },
      { name: 'qwq:32b', sizeGB: 20, reason: 'Purpose-built synthesis and reasoning' },
      { name: 'qwen2.5-coder:32b', sizeGB: 20, reason: 'Top coding model for engineering agents' },
      { name: 'mistral-small:24b', sizeGB: 14, reason: 'Fast general/tool-calling model' },
    ],
  },
  {
    maxVRAM: Infinity,
    models: [
      { name: 'qwen3:72b', sizeGB: 43, reason: 'Largest Qwen3 — top quality across all roles' },
      { name: 'llama3:70b', sizeGB: 40, reason: 'Strong 70B general-purpose model' },
      { name: 'deepseek-r1:70b', sizeGB: 43, reason: 'Full-size DeepSeek reasoning model' },
      { name: 'command-r:35b', sizeGB: 19, reason: 'Built-in citations, ideal for research agents' },
      { name: 'qwq:32b', sizeGB: 20, reason: 'Purpose-built synthesis and reasoning' },
      { name: 'qwen2.5-coder:32b', sizeGB: 20, reason: 'Top coding model for engineering agents' },
    ],
  },
]

export function suggestModelsForHardware(
  hardware: HardwareProfile,
  installed: InstalledModel[],
): SuggestedModel[] {
  const usableVRAM = hardware.gpuMemoryGB * 0.75
  const installedNames = new Set(installed.map(m => m.name))

  // Find the appropriate tier
  const tier = SUGGESTION_TIERS.find(t => usableVRAM < t.maxVRAM) || SUGGESTION_TIERS[SUGGESTION_TIERS.length - 1]

  return tier.models
    .filter(m => m.sizeGB <= usableVRAM)
    .map(m => ({
      ...m,
      installed: installedNames.has(m.name),
      pullCommand: `ollama pull ${m.name}`,
    }))
}
