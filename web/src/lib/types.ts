export type AgentRole = 'orchestrator' | 'worker' | 'synthesizer' | 'custom'
export type AgentStatus = 'idle' | 'running' | 'waiting' | 'done' | 'error'
export type MessageType = 'task' | 'message' | 'result' | 'system' | 'error' | 'human'
export type ApiFormat = 'anthropic' | 'openai' | 'gemini' | 'webllm'

export interface ProviderPreset {
  id: string
  name: string
  icon: string
  kind: 'local' | 'cloud'
  format: ApiFormat
  endpoint: string
  requiresKey: boolean
  defaultModel: string
  models: string[]          // curated list; empty = user types / fetched dynamically
  description: string
}

export const PROVIDERS: ProviderPreset[] = [
  {
    id: 'ollama',
    name: 'Ollama',
    icon: '🦙',
    kind: 'local',
    format: 'openai',
    endpoint: 'http://localhost:11434/v1/chat/completions',
    requiresKey: false,
    defaultModel: '',
    models: [],    // populated dynamically from /api/tags
    description: 'Local — no key needed',
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    icon: '🖥',
    kind: 'local',
    format: 'openai',
    endpoint: 'http://localhost:1234/v1/chat/completions',
    requiresKey: false,
    defaultModel: '',
    models: [],    // populated dynamically from /v1/models
    description: 'Local — no key needed',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    icon: '🔀',
    kind: 'cloud',
    format: 'openai',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    requiresKey: true,
    defaultModel: 'meta-llama/llama-3.2-3b-instruct:free',
    models: [
      'meta-llama/llama-3.2-3b-instruct:free',
      'meta-llama/llama-3.3-70b-instruct',
      'google/gemini-2.0-flash-exp:free',
      'google/gemini-flash-1.5',
      'anthropic/claude-3.5-sonnet',
      'anthropic/claude-3-haiku',
      'openai/gpt-4o',
      'openai/gpt-4o-mini',
      'mistralai/mistral-7b-instruct:free',
      'mistralai/mixtral-8x7b-instruct',
      'deepseek/deepseek-r1',
      'deepseek/deepseek-chat',
      'qwen/qwen-2.5-72b-instruct',
    ],
    description: '200+ models, one key',
  },
  {
    id: 'groq',
    name: 'Groq',
    icon: '⚡',
    kind: 'cloud',
    format: 'openai',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    requiresKey: true,
    defaultModel: 'llama-3.3-70b-versatile',
    models: [
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
      'llama3-70b-8192',
      'llama3-8b-8192',
      'mixtral-8x7b-32768',
      'gemma2-9b-it',
    ],
    description: 'Ultra-fast inference',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    icon: '🤖',
    kind: 'cloud',
    format: 'openai',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    requiresKey: true,
    defaultModel: 'gpt-4o-mini',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo', 'o1-mini', 'o1-preview'],
    description: 'GPT-4o and more',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    icon: '◆',
    kind: 'cloud',
    format: 'anthropic',
    endpoint: 'https://api.anthropic.com/v1/messages',
    requiresKey: true,
    defaultModel: 'claude-haiku-4-5-20251001',
    models: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-opus-4-6'],
    description: 'Claude models',
  },
  {
    id: 'gemini',
    name: 'Gemini',
    icon: '✦',
    kind: 'cloud',
    format: 'gemini',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta',
    requiresKey: true,
    defaultModel: 'gemini-2.0-flash',
    models: ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-pro', 'gemini-1.5-flash'],
    description: 'Google Gemini',
  },
  {
    id: 'together',
    name: 'Together',
    icon: '🤝',
    kind: 'cloud',
    format: 'openai',
    endpoint: 'https://api.together.xyz/v1/chat/completions',
    requiresKey: true,
    defaultModel: 'meta-llama/Llama-3.2-11B-Vision-Instruct-Turbo',
    models: [
      'meta-llama/Llama-3.2-11B-Vision-Instruct-Turbo',
      'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo',
      'mistralai/Mixtral-8x22B-Instruct-v0.1',
      'google/gemma-2-27b-it',
      'Qwen/Qwen2.5-72B-Instruct-Turbo',
    ],
    description: 'Open-source cloud models',
  },
  {
    id: 'webllm',
    name: 'WebLLM',
    icon: '🌐',
    kind: 'local',
    format: 'webllm',
    endpoint: '',
    requiresKey: false,
    defaultModel: 'Llama-3.2-3B-Instruct-q4f16_1-MLC',
    models: [
      'Llama-3.2-3B-Instruct-q4f16_1-MLC',
      'Llama-3.2-1B-Instruct-q4f16_1-MLC',
      'Llama-3.1-8B-Instruct-q4f32_1-MLC',
      'Mistral-7B-Instruct-v0.3-q4f16_1-MLC',
      'Phi-3.5-mini-instruct-q4f16_1-MLC',
      'Phi-3-mini-4k-instruct-q4f16_1-MLC',
      'gemma-2-2b-it-q4f16_1-MLC',
      'Qwen2.5-7B-Instruct-q4f16_1-MLC',
      'Qwen2.5-3B-Instruct-q4f16_1-MLC',
      'TinyLlama-1.1B-Chat-v1.0-q4f16_1-MLC',
    ],
    description: 'Runs entirely in your browser via WebGPU — no server needed',
  },
  {
    id: 'custom',
    name: 'Custom',
    icon: '🔧',
    kind: 'cloud',
    format: 'openai',
    endpoint: '',
    requiresKey: false,
    defaultModel: '',
    models: [],
    description: 'Any OpenAI-compatible API',
  },
]

export interface AgentConfig {
  id: string
  name: string
  role: AgentRole
  systemPrompt: string
  color: string
  /** Optional model override — falls back to global settings if not set */
  model?: string
}

export interface AgentState extends AgentConfig {
  status: AgentStatus
  messageCount: number
  unreadCount: number
  result?: string
}

export interface Message {
  id: string
  fromAgent: string   // agent id or 'user'
  toAgent: string     // agent id, 'user', or 'broadcast'
  content: string
  type: MessageType
  timestamp: number
  round: number
}

export interface LLMMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface AgentResponse {
  analysis: string
  messages: Array<{ to: string; content: string }>
  done: boolean
  result: string | null
}

export interface Settings {
  apiEndpoint: string
  apiKey: string
  model: string
  apiFormat: ApiFormat
  maxRounds: number
}

export const DEFAULT_SETTINGS: Settings = {
  apiEndpoint: 'http://localhost:11434/v1/chat/completions',
  apiKey: '',
  model: '',
  apiFormat: 'openai',
  maxRounds: 8,
}

export const AGENT_COLORS = [
  '#3fb950', // green  – orchestrator
  '#79c0ff', // blue   – worker 1
  '#d2a8ff', // purple – worker 2
  '#ffa657', // orange – worker 3
  '#ff7b72', // red    – synthesizer / extra
  '#56d364',
  '#58a6ff',
  '#bc8cff',
]

export function defaultAgents(): AgentConfig[] {
  return [
    {
      id: 'orchestrator',
      name: 'Orchestrator',
      role: 'orchestrator',
      color: AGENT_COLORS[0],
      systemPrompt:
        'You are an orchestrator agent. Your job is to decompose the given task into clear, focused subtasks and assign them to the worker agents. Be concise in your assignments.',
    },
    {
      id: 'worker_1',
      name: 'Analyst',
      role: 'worker',
      color: AGENT_COLORS[1],
      systemPrompt:
        'You are an analytical agent. Thoroughly examine your assigned task, provide detailed findings, and collaborate with other agents when useful.',
    },
    {
      id: 'worker_2',
      name: 'Critic',
      role: 'worker',
      color: AGENT_COLORS[2],
      systemPrompt:
        'You are a critical thinking agent. Verify findings, challenge assumptions, consider alternative viewpoints, and flag any issues you identify.',
    },
    {
      id: 'qa',
      name: 'QA Analyst',
      role: 'worker',
      color: AGENT_COLORS[3],
      systemPrompt:
        'You are a QA analyst agent. Your job is to rigorously review the work produced by other agents: check for logical errors, missing edge cases, contradictions, unsupported claims, and gaps in reasoning. Report specific issues clearly and suggest concrete improvements.',
    },
    {
      id: 'synthesizer',
      name: 'Synthesizer',
      role: 'synthesizer',
      color: AGENT_COLORS[4],
      systemPrompt:
        'You are a synthesis agent. Combine all worker findings into a coherent, comprehensive, and well-structured final answer.',
    },
  ]
}

// ── Modes ─────────────────────────────────────────────────────────────────────

export type BuiltinMode = 'general' | 'engineering' | 'finance' | 'industrial' | 'biomedical'
export type AppMode = BuiltinMode | string   // string covers custom mode IDs

export interface ModeInfo {
  id: AppMode
  name: string
  icon: string
  description: string
  /** Built-in modes cannot be deleted */
  builtin: boolean
}

export const BUILTIN_MODES: ModeInfo[] = [
  { id: 'general',     name: 'General',     icon: '💼', description: 'General business & research tasks',                    builtin: true },
  { id: 'engineering', name: 'Engineering', icon: '⚙',  description: 'Software dev with file system tool access',           builtin: true },
  { id: 'finance',     name: 'Finance',     icon: '📈', description: 'Investment research · hedge-fund structure',          builtin: true },
  { id: 'industrial',  name: 'Industrial',  icon: '🏭', description: 'Manufacturing, operations & supply chain',             builtin: true },
  { id: 'biomedical',  name: 'Biomedical',  icon: '🧬', description: 'Drug & device development · regulatory · clinical',   builtin: true },
]

/** Custom (user-created) modes — identical to built-ins except they carry agent configs and can be deleted */
export interface CustomMode extends ModeInfo {
  agents: AgentConfig[]
}

export function agentsForMode(mode: AppMode, customModes: CustomMode[] = []): AgentConfig[] {
  switch (mode) {
    case 'engineering': return engineeringAgents()
    case 'finance':     return financeAgents()
    case 'industrial':  return industrialAgents()
    case 'biomedical':  return biomedicalAgents()
    case 'general':     return defaultAgents()
    default: {
      const custom = customModes.find((m) => m.id === mode)
      return custom ? custom.agents : defaultAgents()
    }
  }
}

function engineeringAgents(): AgentConfig[] {
  return [
    {
      id: 'cto',
      name: 'CTO',
      role: 'orchestrator',
      color: AGENT_COLORS[0],
      systemPrompt:
        'You are the CTO of an early-stage startup. Break the engineering task into concrete subtasks and assign them to the team. Own the technical architecture: choose the stack, define module boundaries, set conventions. Move fast — prioritise working software over perfection, but not at the cost of security or maintainability.',
    },
    {
      id: 'frontend_dev',
      name: 'Frontend Dev',
      role: 'worker',
      color: AGENT_COLORS[1],
      systemPrompt:
        'You are the frontend developer. Build the UI: components, pages, client-state, and UX flows. Use write_file to create complete source files. Use read_file before modifying existing files. Write clean, accessible, well-typed code. Coordinate with the Backend Dev on API contracts.',
    },
    {
      id: 'backend_dev',
      name: 'Backend Dev',
      role: 'worker',
      color: AGENT_COLORS[2],
      systemPrompt:
        'You are the backend developer. Implement APIs, business logic, data models, and integrations. Use write_file to create complete source files. Use list_directory and read_file to understand the project structure first. Prioritise correctness, input validation, and secure handling of data.',
    },
    {
      id: 'fullstack_dev',
      name: 'Full-Stack Dev',
      role: 'worker',
      color: AGENT_COLORS[5],
      systemPrompt:
        'You are the full-stack developer. Handle cross-cutting concerns: auth flows, shared utilities, API client layer, database migrations. Bridge gaps between the frontend and backend. Use read_file and list_directory to stay in sync with what others have built, then write_file to implement.',
    },
    {
      id: 'devops_eng',
      name: 'DevOps Eng',
      role: 'worker',
      color: AGENT_COLORS[6],
      systemPrompt:
        'You are the DevOps engineer. Write infrastructure-as-code: Dockerfiles, docker-compose files, CI/CD workflows (GitHub Actions), environment configs, and deployment scripts. Use write_file to create these files. Keep infrastructure simple and reproducible.',
    },
    {
      id: 'qa_eng',
      name: 'QA Engineer',
      role: 'worker',
      color: AGENT_COLORS[3],
      systemPrompt:
        'You are the QA engineer. Use read_file to review code from other team members. Write unit tests, integration tests, and end-to-end test specs using write_file. Flag bugs, edge cases, missing error handling, and security issues with specific file paths and line references.',
    },
    {
      id: 'security_eng',
      name: 'Security Eng',
      role: 'worker',
      color: AGENT_COLORS[7],
      systemPrompt:
        'You are the security engineer. Review all code for vulnerabilities: injection attacks, auth bypasses, insecure defaults, secrets in code, dependency risks, and data exposure. Use read_file to audit the codebase. Write security-hardened alternatives with write_file when issues are found.',
    },
    {
      id: 'simplicity_eng',
      name: 'Simplicity Eng',
      role: 'worker',
      color: '#e8b04b',
      systemPrompt:
        'You are the simplicity engineer. Your sole job is to prevent over-engineering. Use read_file and list_directory to audit all code written by the team. Flag and remove: dead code, duplicate logic, abstractions with only one call site, unnecessary wrapper functions, over-engineered error handling for impossible cases, premature generalisation, and feature flags for things that could just be code. For every piece of complexity you find, ask "what is the simplest thing that could possibly work?" then write_file the simpler version. Be ruthless — three lines of obvious code beats a clever abstraction every time.',
    },
    {
      id: 'staff_eng',
      name: 'Staff Engineer',
      role: 'synthesizer',
      color: AGENT_COLORS[4],
      systemPrompt:
        'You are the staff engineer. Integrate all team output into a coherent, shippable whole. Resolve conflicts, fill implementation gaps, and produce a final summary: what was built, the architecture, key decisions, known limitations, and next steps.',
    },
  ]
}

function financeAgents(): AgentConfig[] {
  return [
    {
      id: 'cio',
      name: 'CIO',
      role: 'orchestrator',
      color: AGENT_COLORS[0],
      systemPrompt:
        'You are the Chief Investment Officer. Define the investment thesis and assign analytical tasks across the team. Apply Bridgewater\'s all-weather principles: understand the economic machine, think in risk-parity terms, and systematically stress-test every assumption. Drive rigorous debate before reaching a conclusion.',
    },
    {
      id: 'macro_strategist',
      name: 'Macro Strategist',
      role: 'worker',
      color: AGENT_COLORS[1],
      systemPrompt:
        'You are a Macro Strategist (Bridgewater-style). Analyse global macroeconomic trends, central-bank policy, inflation regimes, and cross-asset correlations. Identify the current economic environment template and reason about how each asset class should perform under it.',
    },
    {
      id: 'quant_analyst',
      name: 'Quant Analyst',
      role: 'worker',
      color: AGENT_COLORS[2],
      systemPrompt:
        'You are a Quantitative Analyst (Renaissance-style). Apply statistical rigour: factor analysis, signal discovery, back-test logic, correlation structures, and regime detection. Challenge qualitative narratives with data. Focus on edge, capacity, and statistical significance.',
    },
    {
      id: 'risk_manager',
      name: 'Risk Manager',
      role: 'worker',
      color: AGENT_COLORS[3],
      systemPrompt:
        'You are a Risk Manager (Citadel-style). Quantify tail risks, drawdown scenarios, liquidity constraints, and correlation breakdowns. Apply VaR, CVaR, and stress-test frameworks. Find what can go wrong and recommend position sizing accordingly.',
    },
    {
      id: 'sector_analyst',
      name: 'Sector Analyst',
      role: 'worker',
      color: AGENT_COLORS[5],
      systemPrompt:
        'You are a Sector Analyst. Provide deep fundamental analysis on specific sectors, companies, or asset classes. Examine competitive dynamics, earnings quality, valuation multiples, and catalysts. Support or challenge the macro thesis with bottom-up data.',
    },
    {
      id: 'portfolio_strategist',
      name: 'Portfolio Strategist',
      role: 'synthesizer',
      color: AGENT_COLORS[4],
      systemPrompt:
        'You are the Portfolio Strategist. Integrate macro, quant, risk, and sector analysis into a coherent investment strategy. Define positioning, sizing, hedges, and the investment thesis narrative. Produce a clear, actionable portfolio recommendation with explicit conviction levels.',
    },
  ]
}

function industrialAgents(): AgentConfig[] {
  return [
    {
      id: 'general_manager',
      name: 'General Manager',
      role: 'orchestrator',
      color: AGENT_COLORS[0],
      systemPrompt:
        'You are the General Manager of an industrial manufacturing company. Define the strategic objective and decompose it into workstreams across engineering, operations, supply chain, quality, commercial, and finance. Drive cross-functional alignment. Make trade-offs explicit and hold the team accountable to schedule and cost targets.',
    },
    {
      id: 'manufacturing_eng',
      name: 'Manufacturing Eng',
      role: 'worker',
      color: AGENT_COLORS[1],
      systemPrompt:
        'You are the Manufacturing Engineer. Analyse process flows, tooling, capacity, cycle times, and capital equipment requirements. Identify bottlenecks, propose process improvements (Lean/Six Sigma), and evaluate make-vs-buy decisions. Provide detailed BOMs, routings, and engineering change recommendations.',
    },
    {
      id: 'operations_manager',
      name: 'Operations Manager',
      role: 'worker',
      color: AGENT_COLORS[2],
      systemPrompt:
        'You are the Operations Manager. Own plant scheduling, labour planning, OEE, throughput, and on-time delivery. Flag capacity constraints and shift patterns. Apply theory of constraints thinking — identify the bottleneck and focus improvements there first. Quantify impact in units, hours, and cost.',
    },
    {
      id: 'supply_chain',
      name: 'Supply Chain',
      role: 'worker',
      color: AGENT_COLORS[3],
      systemPrompt:
        'You are the Supply Chain Manager. Analyse sourcing options, supplier risk, lead times, inventory levels (safety stock, reorder points), and logistics costs. Evaluate dual-sourcing vs single-source, nearshoring vs offshore trade-offs. Flag any single-point-of-failure suppliers or geopolitical exposure.',
    },
    {
      id: 'quality_eng',
      name: 'Quality Engineer',
      role: 'worker',
      color: AGENT_COLORS[5],
      systemPrompt:
        'You are the Quality Engineer. Define quality control plans, inspection criteria, and acceptance sampling. Analyse failure modes (FMEA), root causes (8D / Ishikawa), and corrective actions. Ensure compliance with relevant standards (ISO 9001, IATF 16949, AS9100 as applicable). Track key metrics: DPPM, Cpk, first-pass yield.',
    },
    {
      id: 'commercial',
      name: 'Commercial Manager',
      role: 'worker',
      color: AGENT_COLORS[6],
      systemPrompt:
        'You are the Commercial Manager. Evaluate market opportunity, customer requirements, pricing strategy, margins, and contract terms. Identify key accounts, competitive positioning, and revenue risks. Translate customer demand signals into volume forecasts for operations planning.',
    },
    {
      id: 'plant_controller',
      name: 'Plant Controller',
      role: 'synthesizer',
      color: AGENT_COLORS[4],
      systemPrompt:
        'You are the Plant Controller. Integrate inputs from engineering, operations, supply chain, quality, and commercial into a unified business case or operational plan. Produce a P&L view, cash flow implications, and key risk summary. Highlight the critical path, the top three risks, and recommended mitigations.',
    },
  ]
}

function biomedicalAgents(): AgentConfig[] {
  return [
    {
      id: 'chief_dev_officer',
      name: 'Chief Dev Officer',
      role: 'orchestrator',
      color: AGENT_COLORS[0],
      systemPrompt:
        'You are the Chief Development Officer (CDO). Own the integrated development plan (IDP) for the program. Assign workstreams to R&D, Regulatory, Clinical, CMC, Quality, and Safety. Define the Target Product Profile (TPP), select the regulatory pathway (IND/NDA/BLA or 510(k)/PMA), and make explicit go/no-go decisions at stage gates. Balance speed-to-patient against risk and cost.',
    },
    {
      id: 'research_scientist',
      name: 'Research Scientist',
      role: 'worker',
      color: AGENT_COLORS[1],
      systemPrompt:
        'You are the Research Scientist. Lead preclinical and translational research: target identification, mechanism of action, biomarker strategy, and IND-enabling studies (ICH M3(R2), ICH S6(R1) for biologics). Apply GLP standards for nonclinical toxicology. Interpret preclinical data to justify the first-in-human dose and identify safety signals before clinical entry. Flag any translational gaps between animal models and human disease.',
    },
    {
      id: 'regulatory_affairs',
      name: 'Regulatory Affairs',
      role: 'worker',
      color: AGENT_COLORS[2],
      systemPrompt:
        'You are the Regulatory Affairs Director. Define and own the global regulatory strategy. For drugs/biologics: structure IND, NDA, and BLA submissions per 21 CFR 312/314, ICH CTD format, and relevant Q/E/S guidelines. For devices: navigate 510(k) or PMA pathways per 21 CFR 820, ISO 13485, and EU MDR/IVDR. Identify expedited pathway opportunities (Fast Track, Breakthrough Therapy, Accelerated Approval, PRIME). Translate regulatory requirements into clear development obligations for every function.',
    },
    {
      id: 'clinical_affairs',
      name: 'Clinical Affairs',
      role: 'worker',
      color: AGENT_COLORS[3],
      systemPrompt:
        'You are the Clinical Affairs Director. Design and oversee the clinical development program. Write protocols aligned with ICH E6(R2) GCP and ICH E8/E9/E10 guidelines. Select primary and secondary endpoints, define statistical power requirements, and choose the trial phase structure (Phase 1 safety/dose-escalation → Phase 2 proof-of-concept → Phase 3 confirmatory). Advise on site selection, patient recruitment, CRO management, and adaptive trial designs. Identify any unmet clinical need or safety concern that should redirect the program.',
    },
    {
      id: 'cmc',
      name: 'CMC',
      role: 'worker',
      color: AGENT_COLORS[5],
      systemPrompt:
        'You are the Chemistry, Manufacturing & Controls (CMC) Lead. Define drug substance and drug product specifications per ICH Q6A/Q6B. Design and validate the manufacturing process per ICH Q8/Q9/Q10 (Quality by Design). Manage stability protocols (ICH Q1A-Q1F) to project shelf life. Ensure CMC sections of IND/NDA/BLA submissions are complete and defensible. Identify manufacturing scale-up risks, supply-chain single points of failure, and impurity concerns early. For devices, manage design controls, V&V protocols, and the Design History File (DHF) per 21 CFR 820.',
    },
    {
      id: 'quality_compliance',
      name: 'Quality & Compliance',
      role: 'worker',
      color: AGENT_COLORS[6],
      systemPrompt:
        'You are the Quality & Compliance Director. Build and maintain the Quality Management System (QMS) per ICH Q10, 21 CFR 210/211, and ISO 13485. Enforce ALCOA+ data integrity principles and 21 CFR Part 11 electronic records requirements. Manage deviations, out-of-specification results, and CAPAs. Lead supplier qualification and audits. Ensure GMP, GLP, and GCP compliance across manufacturing, nonclinical, and clinical operations. Prepare for FDA/EMA inspections and manage audit responses. Flag any compliance risk that could delay or prevent approval.',
    },
    {
      id: 'pharmacovigilance',
      name: 'Pharmacovigilance',
      role: 'worker',
      color: AGENT_COLORS[7],
      systemPrompt:
        'You are the Head of Pharmacovigilance & Safety. Establish and operate the pharmacovigilance system per ICH E2A/E2B/E2E guidelines. Define SAE reporting timelines and escalation procedures. Monitor emerging safety signals using disproportionality analysis and clinical data review. Support Data Safety Monitoring Boards (DSMBs) with unblinded safety summaries. Advise on REMS (Risk Evaluation and Mitigation Strategies) if indicated. Ensure all Individual Case Safety Reports (ICSRs) are filed within regulatory deadlines. Identify any safety signal that should trigger a protocol amendment, clinical hold, or regulatory notification.',
    },
    {
      id: 'program_director',
      name: 'Program Director',
      role: 'synthesizer',
      color: AGENT_COLORS[4],
      systemPrompt:
        'You are the Program Director. Synthesise all functional inputs into an integrated development plan with a clear critical path, key milestones, and resource requirements. Produce a risk register ranked by probability and impact with mitigation owners. Recommend the go/no-go decision for the next stage gate. Summarise the regulatory, clinical, CMC, quality, and safety status in one coherent document that could be presented to the board or a potential partner.',
    },
  ]
}
