# GREMLIN — Technical Documentation

Deep-dive into the internals for contributors and anyone extending the system.

---

## Table of contents

1. [System overview](#system-overview)
2. [Execution model](#execution-model)
3. [Agent runner lifecycle](#agent-runner-lifecycle)
4. [Coordinator state machine](#coordinator-state-machine)
5. [LLM API layer](#llm-api-layer)
6. [Tool system](#tool-system)
7. [Streaming](#streaming)
8. [Memory management (Ollama)](#memory-management-ollama)
9. [Auto-grounding search](#auto-grounding-search)
10. [Round digest broadcasting](#round-digest-broadcasting)
11. [Autotune engine](#autotune-engine)
12. [Reactive store](#reactive-store)
13. [Session persistence](#session-persistence)
14. [Vite plugins](#vite-plugins)
15. [Design system](#design-system)
16. [Key constants](#key-constants)

---

## System overview

Gremlin is a local-first, browser-native multi-agent coordinator. The entire application runs in the browser — there is no backend server. The Vite dev server provides supporting middleware (CORS proxy, hardware detection) but carries no application state.

```
Browser
├── Svelte 5 UI (App.svelte, components/)
├── GremlinStore (store.svelte.ts) — reactive global state via Svelte 5 runes
├── AgentRunner (agentRunner.ts) — orchestration engine
├── Coordinator (coordinator.ts) — in-memory agent registry + message router
├── API layer (api.ts) — LLM calls for all provider formats
├── Tools (tools.ts) — protocol, dev, search, browser tool executors
└── Search (search.ts) — web search provider implementations

Vite dev server (Node.js)
├── /cors-proxy — forwards requests to external APIs
├── /api/system-info — hardware detection (RAM, GPU, CPU)
├── Ollama sidecar — auto-starts ollama serve with memory caps
└── Browser sidecar — auto-starts Playwright headless Chromium
```

Data flows in one direction: **User task → Coordinator → AgentRunner → LLM → Coordinator → UI**. The coordinator is the single source of truth for agent status and message history.

---

## Execution model

Gremlin uses a round-based execution model with three agent roles:

| Role | Count | Purpose |
|------|-------|---------|
| **Orchestrator** | 1 | Decomposes the task, assigns subtasks to workers |
| **Worker** | N | Executes subtasks, can message peers or orchestrator |
| **Synthesizer** | 1 | Integrates all worker outputs into the final deliverable |

**Round lifecycle:**

```
Round 1:  Orchestrator receives user task → sends subtasks to workers
Round 2+: Workers execute → message each other → report back
          Round digest broadcast shares context between agents
Final:    Synthesizer receives all outputs → produces result via mark_done()
```

Workers run in parallel within each round, batched by model assignment to minimize Ollama model swaps. A concurrency cap (`MAX_CONCURRENT = 3`) prevents overwhelming LLM providers.

---

## Agent runner lifecycle

### Initialization (`run()`)

```
run(task, agents, settings, attachments, callbacks, tools)
  │
  ├── Initialize coordinator: clearSession(), register agents
  ├── Emit user task to orchestrator inbox
  ├── Detect hardware: initLocalModelProfile(localEndpoints)
  ├── Pull missing models: ensureMissingModels()
  ├── Auto-ground with web search: groundWithSearch(task, orchestrator)
  ├── Start heartbeat (sleep/wake detector)
  │
  └── try: runLoop()
      finally: stopHeartbeat(), coord.setRunning(false), onDone()
```

### Main loop (`runLoop()`)

Each iteration:

1. **Increment round**, check against `maxRounds`
2. **Find pending agents** — those with unprocessed messages in coordinator
3. **Deadlock guard** — if no pending agents but synthesizer hasn't run:
   - Force waiting workers to "done"
   - Call `forceSynthesis()` to feed all outputs to synthesizer
4. **Check completion** — all workers done + synthesizer done → exit
5. **Group by model** — `groupByModel(pending)` sorts agents so same-model agents run together
6. **Dispatch batches** — for each model group, run agents with `MAX_CONCURRENT` parallelism
7. **Broadcast round digest** — share summaries of what each agent produced this round
8. **Peer-message wake-up** — if workers marked done but have unread peer messages, reset to "waiting"
9. **Trigger synthesis** — when all workers done, send synthesis request

### Agent turn (`runAgentTurn()`)

```
runAgentTurn(agent, round)
  │
  ├── Collect new messages from coordinator
  ├── Build user content from messages
  ├── Set agent status → 'running'
  ├── Build system prompt: buildSystemPrompt(agent)
  │   ├── Agent's systemPrompt
  │   ├── Dev tool instructions (if engineering mode)
  │   ├── Search tool instructions (if search configured)
  │   ├── Current date + knowledge cutoff warning
  │   ├── Agent roster (who can I message?)
  │   ├── Communication protocol (send_message, mark_done)
  │   └── Role-specific instructions (orchestrator/synthesizer)
  │
  ├── Create per-agent stream callback
  ├── Call callLLMWithTools() with retry logic
  │   └── Up to MAX_RETRIES (3) with exponential backoff
  │
  ├── Parse response (protocol tools or JSON fallback)
  ├── Route outgoing messages through coordinator
  │   └── Detect hallucinated agent names → prompt user
  ├── Update agent status → 'done' or 'waiting'
  └── Clear streaming text
```

### Retry logic

Transient errors (network timeouts, 429/5xx) retry up to `MAX_RETRIES = 3` with exponential backoff (`RETRY_BASE_MS = 2000ms × 2^attempt`). Non-retryable errors (CORS, connection refused to localhost, tool loop exceeded) fail immediately. On final failure, the agent is set to `'error'` status and an error message is emitted.

### Human-in-the-loop

`injectHumanMessage(agentId, content)` emits a message with `type: 'human'` to the target agent through the coordinator, then resumes the run loop. The agent will process this message on its next turn.

### Per-agent stop

`stopAgent(agentId)` adds the agent to `stoppedAgents` set, aborts its in-flight fetch via `activeTurnAborts`, and marks it done in the coordinator. The run continues with remaining agents.

---

## Coordinator state machine

The coordinator (`coordinator.ts`) is a pure TypeScript module with no framework dependencies. It maintains:

**Per-agent state:**
- `status: AgentStatus` — `'idle' | 'running' | 'waiting' | 'done' | 'stopping' | 'error'`
- `messageCount: number` — messages sent by this agent
- `unreadCount: number` — messages received (direct + broadcast)

**API:**
```typescript
addAgent(cfg: AgentConfig): void
getAgents(): AgentState[]
updateAgentStatus(agentId: string, status: AgentStatus): void
getAgentStatus(agentId: string): AgentStatus

routeMessage(msg: Omit<Message, 'id'>): string   // returns generated UUID
getMessagesFor(agentId: string): Message[]        // direct + broadcast
getMessageCountFor(agentId: string): number

clearSession(): void
setRunning(running: boolean): void
getRunning(): boolean
```

**Message routing rules:**
- All messages get a `crypto.randomUUID()` ID
- Sender's `messageCount` increments on every outgoing message
- Recipient's `unreadCount` increments unless `toAgent` is `'user'` or `'broadcast'`
- Broadcast messages (`toAgent: 'broadcast'`) are received by all agents via `getMessagesFor()`

---

## LLM API layer

`api.ts` supports four provider formats:

| Format | Function | Streaming | Tool calling |
|--------|----------|-----------|--------------|
| `openai` | `callOpenAIWithTools()` | SSE via `streamOpenAIResponse()` | Yes |
| `anthropic` | `callAnthropicWithTools()` | SSE via `streamAnthropicResponse()` | Yes |
| `gemini` | `callGemini()` | No | No (text-only fallback) |
| `webllm` | `callWebLLMWithTools()` | No | Yes (via WebGPU engine) |

### Provider resolution

`resolveProviderSettings(agent)` determines which LLM endpoint and model to use:

1. If `llmProviders[]` is populated → round-robin across providers
2. Per-agent `model` override wins over provider default
3. Fallback: legacy single-provider from `settings.apiEndpoint`

### CORS proxy

`proxiedFetch(url, init, settings)` routes requests through the CORS proxy only when needed:

**Direct (no proxy):** `localhost`, `127.0.0.1`, `::1`, `0.0.0.0`, `api.openai.com`, `api.anthropic.com`, `openrouter.ai`, `generativelanguage.googleapis.com`, `api.together.xyz`, `api.cloudflare.com`

**Proxied:** Everything else (DuckDuckGo, Brave, SearXNG, etc.) → sent to `/cors-proxy` with `X-Target-URL` header.

### Ollama-specific options

For local endpoints (`localhost` or `127.0.0.1`):
- `body.options = { num_ctx: computeNumCtx(model) }` — dynamic context window sizing
- `body.keep_alive = '5m'` — keep model loaded briefly between same-model calls

---

## Tool system

Tools are defined in `tools.ts` and split into four categories:

### Protocol tools (always available)

| Tool | Parameters | Purpose |
|------|-----------|---------|
| `send_message` | `to: string, content: string` | Route a message to another agent |
| `mark_done` | `result?: string` | Signal task completion; result shown to user |

Protocol tool calls are intercepted by `createExecutor()` and collected into a `CollectedState` object rather than executed as real tools.

### Dev tools (engineering mode + open project folder)

| Tool | Parameters | Purpose |
|------|-----------|---------|
| `write_file` | `path: string, content: string` | Create/overwrite file via File System Access API |
| `read_file` | `path: string` | Read file contents |
| `list_directory` | `path?: string` | List files and subdirectories |

### Search tools (when `searchProviders` is configured)

| Tool | Parameters | Purpose |
|------|-----------|---------|
| `web_search` | `query: string` | Search via configured provider (DuckDuckGo, Brave, etc.) |
| `web_fetch` | `url: string` | Fetch and extract text from a URL (max 30k chars) |

Search providers are tried in order with fallback. Supported: `duckduckgo`, `searxng`, `brave`, `serper`, `tavily`, `cloudflare`.

### Browser tools (when browser sidecar is running)

8 tools proxied to the Playwright server at `http://127.0.0.1:3131`:

| Tool | Purpose |
|------|---------|
| `browse_navigate` | Open a URL, returns title + status |
| `browse_content` | Extract text from page or selector |
| `browse_click` | Click an element |
| `browse_type` | Type into an input, optionally submit |
| `browse_evaluate` | Run JavaScript in page context |
| `browse_assert` | Assert conditions on elements (PASS/FAIL) |
| `browse_links` | List all links on the page |
| `browse_wait` | Wait for an element to appear/disappear |

---

## Streaming

Real-time token streaming is supported for OpenAI-compatible and Anthropic providers.

### Callback chain

```
oaiFetch(stream: true) →
  streamOpenAIResponse(resp, onStream) →
    parseSSE(resp) →                          // async generator yielding SSE events
      delta.content → onStream(delta, acc)    // plain text content
      delta.tool_calls → extractToolCallText(name, args) → onStream(delta, acc)
        // extracts readable text from JSON args (content/result fields)

agentRunner creates per-agent wrapper:
  streamCb = (delta, acc) → cb.onStream(agentId, delta, acc)

store.onStream sets reactive state:
  streamingAgentId = agentId
  streamingText = accumulated

ActivityMonitor.svelte displays:
  strips <think> tags, shows at 50% opacity in monospace
```

### Tool call streaming

When models use tool calling (which is the primary communication mechanism), their output is in tool call arguments — not `content` text. The SSE parsers extract readable text from tool call JSON using `extractToolCallText()`:

- For `send_message` → extracts the `content` field value
- For `mark_done` / `set_result` → extracts the `result` field value
- Handles partial JSON (closing quote may not exist yet)
- Unescapes JSON string encoding (`\n`, `\"`, `\\`)

### Stream lifecycle

1. Stream starts when first delta arrives → `streamingAgentId` set, typing dots appear
2. Text accumulates as deltas arrive → displayed in activity monitor
3. Stream cleared **after** messages are emitted (not immediately after LLM response) → prevents text disappearing before messages appear
4. On error: stream cleared in catch block

---

## Memory management (Ollama)

### The problem

Ollama models default to their maximum context window (e.g., qwen3 defaults to 262K tokens). The KV cache for large context windows can consume 40+ GB, causing layers to spill from GPU to CPU (5-10x slower).

### Dynamic `num_ctx` computation

`computeNumCtx(modelName)` calculates the optimal context window per-request:

```
GPU memory budget = gpuMemoryGB × 0.85   (15% reserved for OS)
KV budget = GPU budget - model weight size
```

| KV budget | num_ctx |
|-----------|---------|
| ≤ 0 GB | 2048 |
| < 1 GB | 4096 |
| < 2 GB | 8192 |
| < 4 GB | 16384 |
| < 8 GB | 32768 |
| ≥ 8 GB | 65536 |

### Hardware detection

`initLocalModelProfile(endpoints)` runs once per session:

1. Fetches `/api/system-info` from Vite server → GPU memory (macOS: unified memory = total RAM)
2. Fetches `/api/tags` from each Ollama endpoint → model names and sizes in GB
3. Caches in module-level `_gpuMemoryGB` and `_modelSizeMap`

### Ollama sidecar environment

The Vite plugin starts Ollama with conservative defaults:

| Env var | Value | Purpose |
|---------|-------|---------|
| `OLLAMA_NUM_CTX` | 8192 | Server-level context cap (overridden per-request) |
| `OLLAMA_MAX_LOADED_MODELS` | 1 | Only one model in VRAM at a time |
| `OLLAMA_NUM_PARALLEL` | 4 | Concurrent requests per loaded model |
| `OLLAMA_KEEP_ALIVE` | 30s | Keep model warm briefly between calls |

### Model unloading

`unloadOllamaModels()` is called when a run ends or is stopped:

1. Queries `/api/ps` to find actually-loaded models
2. Sends `keep_alive: 0` to each via `/api/generate`
3. Falls back to unloading by configured model names if `/api/ps` fails

---

## Auto-grounding search

Before agents start their main loop, the runner automatically searches the web for the task topic and injects results into the orchestrator's context.

### Why

Local LLM models have training cutoffs (typically 2024 or earlier). Despite system prompt instructions to call `web_search()`, smaller models frequently ignore tool-calling instructions and generate from stale training data. Auto-grounding ensures agents always have current data in context.

### How

`groundWithSearch(task, orchestrator)`:

1. Checks if search tools are available (skips if not)
2. Builds a search query from the task text + current month/year
3. Calls `performWebSearch()` via the configured provider
4. Injects results as a `type: 'system'` message to the orchestrator
5. Logs progress: "Grounding: searching for current data…"

The orchestrator then includes this context when decomposing the task for workers. Workers inherit the grounding data through their subtask descriptions.

---

## Round digest broadcasting

At the end of each round, `broadcastRoundDigest()` shares a summary of what each agent produced with all other agents.

### Purpose

Prevents agents from working in isolation or repeating each other's work. Gives each agent context about what others discovered before their next turn.

### Implementation

1. For each agent that just ran, extract the last assistant message (truncated to 800 chars)
2. For each agent that will run next (not done/error):
   - Build a digest of OTHER agents' summaries (exclude self)
   - Emit as a `type: 'system'` message: `── Round N digest ──\n[Agent Name]: summary...`

### Preventing feedback loops

- Only summaries from the CURRENT round are included
- Agents don't receive their own summary
- Done/error agents are excluded from receiving digests

---

## Autotune engine

The setup wizard (`TuningView.svelte`) uses `autotune.ts` to recommend model assignments.

### Scored recommendation (`computeRecommendation()`)

1. Computes usable VRAM: `hardware.gpuMemoryGB × 0.85`
2. Classifies agents by role: orchestrator, code, reasoning, research, synthesis, general
3. Scores each model against each role class using `MODEL_CAPABILITIES` matrix
4. Picks strategy based on VRAM:
   - **Single-model** (< 18GB): best all-around model
   - **Dual-model** (18-32GB): two complementary models via coverage scoring
   - **Multi-model** (> 32GB): best-per-role assignments

### AI recommendation (`computeAIRecommendation()`)

Uses in-browser WebLLM (Qwen2.5-3B via WebGPU) to analyze hardware + models and produce per-mode assignments. Considers both local Ollama models AND cloud providers. Falls back to scored recommendation if WebGPU is unavailable.

---

## Reactive store

`GremlinStore` in `store.svelte.ts` uses Svelte 5 runes (`$state`, `$derived`, `$effect`) for reactive global state.

### Key state

| Field | Type | Purpose |
|-------|------|---------|
| `settings` | `Settings` | LLM provider config, persisted to localStorage |
| `appMode` | `AppMode` | Current mode (general, finance, etc.) |
| `agentConfigs` | `AgentConfig[]` | Agent definitions for current mode |
| `agentStates` | `AgentState[]` | Live status, message counts, metrics |
| `messages` | `Message[]` | All inter-agent messages this session |
| `logs` | `string[]` | System log entries |
| `output` | `string` | Final synthesizer result |
| `isRunning` | `boolean` | Whether a run is active |
| `streamingAgentId` | `string \| null` | Currently streaming agent |
| `streamingText` | `string` | Accumulated streaming content |

### Callbacks

`makeCallbacks()` creates the `RunnerCallbacks` object that bridges the AgentRunner to the reactive store:

| Callback | Store update |
|----------|-------------|
| `onMessage` | Push to `messages[]`, sync agent states |
| `onStatusUpdate` | Sync from coordinator |
| `onLog` | Push to `logs[]` |
| `onOutput` | Set `output` |
| `onStream` | Set `streamingAgentId` + `streamingText` |
| `onDone` | Clear running state, merge metrics, archive session |

### Sleep/wake detector

A 5-second interval checks for wall-clock gaps > 15 seconds (indicating system sleep). On wake detection, aborts the stale run since TCP connections to Ollama/providers are dead.

---

## Session persistence

### Current session

Debounced (1-second) save to `localStorage` under `gremlin_session`:

```typescript
interface PersistedSession {
  messages: Message[]
  logs: string[]
  output: string
  agentStates: AgentState[]
}
```

Task input saved separately under `gremlin_task` (survives `clearSession()`).

### Session history

Up to 1,000 past sessions stored as:
- **Index:** `gremlin_session_history` — array of `SessionHistoryEntry` (id, task, mode, timestamp, counts)
- **Archives:** `gremlin_session_{id}` — full session data per entry

Sessions are archived automatically when a run completes or a new run starts. Restored sessions update in-place rather than duplicating.

### Agent config persistence

Per-mode agent configs stored under `gremlin_agents_{mode}`. On version bump (`BUILTIN_AGENTS_VERSION`), the migration syncs `systemPrompt` and `model` fields from code defaults while preserving user edits to other fields.

---

## Vite plugins

Four custom plugins in `vite.config.ts`:

### `corsProxy()`

Middleware at `/cors-proxy`. Forwards requests using the `X-Target-URL` header. Strips hop-by-hop headers, handles pre-flight OPTIONS, re-decompresses and re-measures content-length. Dev-only — production uses a Cloudflare Worker.

### `browserSidecar()`

Auto-spawns `server/browser-server.mjs` (Playwright headless Chromium) as a child process. Provides 8 browser tools at `http://127.0.0.1:3131`. Gracefully handles missing Playwright installation.

### `ollamaSidecar()`

Detects Ollama via `which ollama`, kills existing instances, restarts with memory-safe environment variables (`NUM_CTX=8192`, `MAX_LOADED=1`, `PARALLEL=4`, `KEEP_ALIVE=30s`). Skips if Ollama is not installed.

### `systemInfo()`

Middleware at `GET /api/system-info`. Returns JSON with platform-specific hardware detection:
- **macOS:** `sysctl hw.memsize` for RAM, `system_profiler` for GPU name, unified memory = total RAM
- **Linux:** `/proc/meminfo`, `nproc`, `nvidia-smi` for discrete GPU
- Used by `initLocalModelProfile()` to size `num_ctx` appropriately

---

## Design system

Glass-morphism dark theme defined in `app.css`:

| Token | Value | Usage |
|-------|-------|-------|
| `--color-bg` | `#090c12` | App background |
| `--color-accent` | `#3fb950` | Primary green |
| `--color-accent-2` | `#58a6ff` | Blue |
| `--color-accent-warn` | `#d29922` | Amber warnings |
| `--color-accent-err` | `#f85149` | Red errors |
| `--glass` | `rgba(28,28,30,0.64)` | Glass surface |
| `--blur-subtle` | `12px` | Backdrop blur |

### Print stylesheet

`@media print` rules in `app.css` hide everything except the activity feed and final result. Colors invert to white background / black text for clean paper output. Events use `break-inside: avoid` for clean page breaks.

### Prose enhancement

`tableCards.ts` post-processes rendered Markdown:
- Tables with 4+ columns → responsive card grids
- Standalone bold verdict words (**BUY**, **SELL**, **HOLD**, etc.) → colored pill badges
- Signed numbers (+12.3%, -5.2%) → green/red coloring
- Section headings matching patterns → styled callout boxes

---

## Key constants

| Constant | Value | Location | Purpose |
|----------|-------|----------|---------|
| `MAX_RETRIES` | 3 | agentRunner.ts | LLM call retry attempts |
| `RETRY_BASE_MS` | 2000 | agentRunner.ts | Exponential backoff base |
| `MAX_CONCURRENT` | 3 | agentRunner.ts | Parallel agent limit per batch |
| `MAX_HISTORY_PER_AGENT` | 20 | agentRunner.ts | Message pruning (10 turns) |
| `MAX_SESSION_HISTORY` | 1000 | store.svelte.ts | Archived session cap |
| `MAX_FETCH_CHARS` | 30000 | tools.ts | Web page content limit |
| `SPA_THRESHOLD` | 200 | tools.ts | Min content before SPA fallback |
| `BUILTIN_AGENTS_VERSION` | 13 | store.svelte.ts | Agent schema migration trigger |
| `BROWSER_SIDECAR` | `http://127.0.0.1:3131` | tools.ts | Playwright server address |
| `maxRounds` (default) | 32 | types.ts | Default round limit per session |
