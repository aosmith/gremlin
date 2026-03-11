/**
 * Auto-tune engine: detect hardware, recommend models, apply optimal config.
 * Includes AI-powered recommendations via in-browser WebLLM.
 */

import type { AgentConfig, LLMProviderConfig } from './types'
import { BUILTIN_MODES, PROVIDERS, agentsForMode } from './types'
import { isWebGPUAvailable, callWebLLM } from './webllm'
import type { ProgressCallback } from './webllm'

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

// ── AI-powered recommendation via WebLLM ─────────────────────────────────────

/** Model family descriptions for the AI prompt — tells the 3B model what each family is good at */
const MODEL_DESCRIPTIONS: Record<string, string> = {
  'qwen3': 'Fast MoE architecture (3.3B active params in 30B version). Excellent orchestration, delegation, JSON output, tool calling. Good general-purpose.',
  'qwen2.5-coder': 'Purpose-built for code generation, editing, and debugging. Top-tier for all software engineering tasks. Weak at non-code tasks.',
  'deepseek-r1': 'Deep reasoning model. Outputs chain-of-thought in <think> tags. Best for analysis, risk assessment, diagnostics, probability estimation.',
  'command-r': 'Research/RAG specialist with built-in citation support. Best for web research, document analysis, financial filings, news synthesis.',
  'qwq': 'Purpose-built for reasoning and synthesis. Excellent at combining multiple inputs into coherent summaries. Best synthesizer available.',
  'mistral-small': 'Fast, efficient general model (14GB at 24b). Best native JSON/tool calling. Good for manufacturing, operations, networking, editing tasks.',
  'llama3': 'Strong general-purpose model from Meta. Balanced across all tasks. Good default when no specialist needed.',
  'gemma': 'Google model, good at coding and general tasks. Compact and efficient.',
  'phi': 'Microsoft model, strong at coding and reasoning for its size. Very efficient.',
}

export interface AIRecommendation extends TuneRecommendation {
  /** Per-mode assignments: mode id → agent id → model name */
  modeAssignments: Record<string, Record<string, string>>
  /** Raw AI reasoning text */
  aiReasoning: string
}

/**
 * Use the in-browser WebLLM model to analyze hardware, installed models,
 * cloud providers, and all agent roles across every mode, then recommend
 * optimal assignments. Falls back to computeRecommendation() if WebGPU
 * is unavailable or the AI call fails.
 */
export async function computeAIRecommendation(
  hardware: HardwareProfile,
  models: InstalledModel[],
  cloudProviders: LLMProviderConfig[],
  localModel: string,
  onProgress?: ProgressCallback,
  onStatus?: (status: string) => void,
): Promise<AIRecommendation | null> {
  if (!isWebGPUAvailable()) return null
  if (models.length === 0 && cloudProviders.length === 0) return null

  const usableVRAM = Math.max(hardware.gpuMemoryGB - 5, hardware.gpuMemoryGB * 0.5)

  // Gather all agents from all builtin modes
  const modeAgents: { mode: string; modeName: string; agents: { id: string; name: string; role: string; roleClass: AgentRoleClass }[] }[] = []
  for (const mode of BUILTIN_MODES) {
    if (mode.id === 'tuning') continue
    const agents = agentsForMode(mode.id)
    if (agents.length === 0) continue
    modeAgents.push({
      mode: mode.id,
      modeName: mode.name,
      agents: agents.map(a => ({
        id: a.id,
        name: a.name,
        role: a.role,
        roleClass: classifyAgentRole(a),
      })),
    })
  }

  // Build local model info string
  const fittingLocal = models.filter(m => m.sizeGB <= usableVRAM)
  const localModelInfo = fittingLocal
    .map(m => {
      const desc = MODEL_DESCRIPTIONS[m.family] || 'General-purpose model.'
      return `  - ${m.name} (${m.sizeGB}GB, family: ${m.family}): ${desc}`
    }).join('\n')

  // Build cloud provider info string
  const cloudInfo = cloudProviders.map(cp => {
    const preset = PROVIDERS.find(p => p.id === cp.id)
    const providerName = preset?.name || cp.id
    return `  - "${cp.model}" via ${providerName} (cloud, no VRAM cost, unlimited parallel calls)`
  }).join('\n')

  // All available model names for validation
  const allAvailableModels = new Set([
    ...fittingLocal.map(m => m.name),
    ...cloudProviders.map(cp => cp.model),
  ])

  if (allAvailableModels.size === 0) return null

  // Build agent summary per mode
  const modeInfo = modeAgents.map(m => {
    const agentList = m.agents.map(a => `  - ${a.id} "${a.name}" [${a.role}] → role_class: ${a.roleClass}`).join('\n')
    return `MODE: ${m.modeName} (${m.mode})\n${agentList}`
  }).join('\n\n')

  // Build the model availability section
  let modelSection = ''
  if (localModelInfo) {
    modelSection += `LOCAL MODELS (Ollama, fit in VRAM):\n${localModelInfo}\n`
  }
  if (cloudInfo) {
    modelSection += `\nCLOUD MODELS (API providers, no VRAM constraint):\n${cloudInfo}\n`
  }

  const prompt = `You are an AI model assignment optimizer. Given hardware specs, available models (local + cloud), and agent definitions across multiple modes, assign the BEST model to each agent.

HARDWARE:
- GPU: ${hardware.gpuName}
- Total Memory: ${hardware.totalMemoryGB}GB
- Usable VRAM: ${usableVRAM.toFixed(1)}GB (after OS overhead)
- CPU Cores: ${hardware.cpuCores}
- Platform: ${hardware.platform}/${hardware.arch}

CONSTRAINTS:
- Local Ollama models load ONE at a time into VRAM (MAX_LOADED_MODELS=1). Model swapping takes 10-30 seconds. Minimize distinct local models per mode.
- Cloud models have NO VRAM cost and support unlimited parallel calls. Prefer cloud models for roles needing high quality or when local VRAM is limited.
- If both local and cloud models are available, use cloud for quality-critical roles (reasoning, synthesis) and local for latency-sensitive roles (orchestrator) or when privacy matters.

AVAILABLE MODELS:
${modelSection}
ROLE CLASSES:
- orchestrator: Delegates tasks, reads reports, outputs JSON with messages. Needs fast response, good JSON output.
- code: Writes/edits code. Needs strong code generation.
- reasoning: Deep analysis, risk assessment, diagnostics. Needs chain-of-thought.
- research: Web research, document analysis, citations. Needs RAG/citation ability.
- synthesis: Combines multiple inputs into final report. Needs reasoning + writing.
- general: Miscellaneous tasks. Needs balanced capabilities.

AGENTS BY MODE:
${modeInfo}

RULES:
1. Match model strengths to role classes
2. Minimize distinct LOCAL models per mode to reduce swap overhead
3. Cloud models can be used freely without swap penalty
4. Every agent MUST get a model assignment — use exact model names from the lists above
5. Pick ONE global default model (the best all-rounder from any source)

Respond with ONLY valid JSON, no other text:
{
  "reasoning": "Brief explanation of your strategy",
  "globalModel": "model_name",
  "strategy": "single-model" | "dual-model" | "multi-model",
  "modes": {
    "mode_id": {
      "agent_id": "model_name",
      ...
    },
    ...
  }
}`

  try {
    onStatus?.('Loading AI model...')
    const response = await callWebLLM(
      [{ role: 'user', content: prompt }],
      localModel,
      2048,
      onProgress,
    )
    onStatus?.('Parsing recommendation...')

    // Extract JSON from response (handle markdown code blocks)
    let jsonStr = response.trim()
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (fenceMatch) jsonStr = fenceMatch[1].trim()

    // Try to find JSON object if there's extra text
    const braceStart = jsonStr.indexOf('{')
    const braceEnd = jsonStr.lastIndexOf('}')
    if (braceStart >= 0 && braceEnd > braceStart) {
      jsonStr = jsonStr.slice(braceStart, braceEnd + 1)
    }

    const parsed = JSON.parse(jsonStr) as {
      reasoning: string
      globalModel: string
      strategy: string
      modes: Record<string, Record<string, string>>
    }

    // Validate: ensure globalModel is an available model (local or cloud)
    if (!allAvailableModels.has(parsed.globalModel)) {
      // Pick the closest match or first available
      parsed.globalModel = models.find(m => parsed.globalModel.includes(m.family))?.name
        || cloudProviders[0]?.model
        || models[0]?.name
        || ''
    }

    // Validate all mode assignments reference available models (local or cloud)
    const modeAssignments: Record<string, Record<string, string>> = {}
    const flatAssignments: Record<string, string> = {}

    for (const ma of modeAgents) {
      const modeMap = parsed.modes?.[ma.mode] || {}
      const validated: Record<string, string> = {}
      for (const agent of ma.agents) {
        let assigned = modeMap[agent.id]
        if (!assigned || !allAvailableModels.has(assigned)) {
          // Fallback: use global model
          assigned = parsed.globalModel
        }
        validated[agent.id] = assigned
        flatAssignments[agent.id] = assigned
      }
      modeAssignments[ma.mode] = validated
    }

    // Map strategy string to type
    const strategyMap: Record<string, TuneRecommendation['strategy']> = {
      'single-model': 'single-model',
      'dual-model': 'dual-model',
      'multi-model': 'multi-model',
    }
    const strategy = strategyMap[parsed.strategy] || 'multi-model'

    return {
      strategy,
      assignments: flatAssignments,
      globalModel: parsed.globalModel,
      reasoning: parsed.reasoning || 'AI-optimized model assignments.',
      warnings: [],
      suggestedModels: suggestModelsForHardware(hardware, models),
      modeAssignments,
      aiReasoning: parsed.reasoning || '',
    }
  } catch (err) {
    console.warn('[autotune] AI recommendation failed, falling back to scored system:', err)
    return null
  }
}
