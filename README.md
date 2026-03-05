# ⚡ GREMLIN

A local, browser-native multi-agent coordinator. A Rust/WASM module routes all inter-agent messages; a Svelte UI lets you watch every conversation and inject human input at any point. No server required.

---

## Features

| | |
|---|---|
| 🦀 **WASM coordinator** | Rust-compiled message router with SIMD128 + bulk-memory acceleration |
| 🤝 **Collaborative agents** | Agents have individual system prompts and message each other autonomously |
| 🔍 **Full visibility** | Every inter-agent message is shown in real time — nothing hidden |
| 💬 **Human-in-the-loop** | Click any agent during a run to read its thread and inject instructions |
| 🗂 **Modes** | General · Engineering (8-person startup team) · Finance (hedge-fund structure) · custom |
| ⚙ **Dev mode** | Engineering agents write real files to your disk via the File System Access API |
| 🌐 **WebLLM** | Run quantised models entirely in the browser via WebGPU — no server or key needed |
| 🔌 **9 providers** | Ollama, LM Studio, OpenRouter, Groq, OpenAI, Anthropic, Gemini, Together, Custom |
| 📦 **Single HTML file** | `dist/index.html` has everything inlined — WASM binary, JS, CSS |
| 🏠 **Fully local** | No backend, no accounts; only outbound traffic is calls to your chosen LLM |

---

## Quick start

### Prerequisites

| Tool | Version | Install |
|---|---|---|
| Rust + Cargo | 1.75+ | [rustup.rs](https://rustup.rs) |
| Node.js | 18+ | [nodejs.org](https://nodejs.org) |

### macOS / Linux

```bash
git clone https://github.com/your-username/gremlin.git
cd gremlin
./setup.sh
npx serve web/dist   # → http://localhost:3000
```

Manual steps if you prefer:

```bash
# Rust toolchain
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env
curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh
rustup target add wasm32-unknown-unknown

# Node dependencies
cd web && npm install && cd ..

# Build WASM (absolute path required for --out-dir)
export RUSTFLAGS="-C target-feature=+simd128,+bulk-memory,+nontrapping-fptoint"
wasm-pack build crates/coordinator --target web \
  --out-dir "$(pwd)/web/src/wasm" --release

# Embed WASM + build frontend
node web/scripts/encode-wasm.mjs
cd web && npm run build && cd ..

npx serve web/dist
```

### Windows

```powershell
# Install Rust from https://rustup.rs, Node from https://nodejs.org
rustup target add wasm32-unknown-unknown
cargo install wasm-pack

cd web; npm install; cd ..

$env:RUSTFLAGS="-C target-feature=+simd128,+bulk-memory,+nontrapping-fptoint"
wasm-pack build crates/coordinator --target web `
  --out-dir "$((Get-Location).Path)/web/src/wasm" --release

node web/scripts/encode-wasm.mjs
cd web; npm run build; cd ..

npx serve web/dist   # → http://localhost:3000
```

### Development (live reload)

```bash
# Build WASM once (only needed when Rust changes)
cd web && npm run build:wasm

# Start Vite dev server
npm run dev   # → http://localhost:5173
```

---

## Modes

Switch modes with the tab bar below the navbar. Each mode loads a different set of agents. Settings are saved per-mode.

| Mode | Agents | Use for |
|---|---|---|
| **General** 💼 | Orchestrator · Analyst · Critic · QA Analyst · Synthesizer | Research, writing, analysis |
| **Engineering** ⚙ | CTO · Frontend Dev · Backend Dev · Full-Stack Dev · DevOps · QA · Security · Staff Engineer | Software projects |
| **Finance** 📈 | Capital Allocator · Value Analyst · Activist Analyst · Risk Manager · Sector Analyst · News & Sentiment · Investment Strategist | Investment research |
| **Industrial** 🏭 | General Manager · Manufacturing Eng · Operations Manager · Supply Chain · Quality Eng · Commercial Manager · Plant Controller | Manufacturing, operations & supply chain |
| **Biomedical** 🧬 | Chief Dev Officer · Research Scientist · Regulatory Affairs · Clinical Affairs · CMC · Quality & Compliance · Pharmacovigilance · Program Director | Drug & device development |
| **+ New Mode** | Snapshot of your current agents | Any custom team |

Click **+ New Mode** to save your current agent configuration as a named mode. Custom modes can be deleted; the three built-in ones cannot.

---

## Dev mode (Engineering)

When the **Engineering** mode is active, a **📁 Open Folder** button appears in the toolbar. Select a local project directory and the agents gain file system tools:

| Tool | Description |
|---|---|
| `write_file(path, content)` | Create or overwrite a file (parent directories are created automatically) |
| `read_file(path)` | Read a file's full content |
| `list_directory(path)` | List files and subdirectories |

Tool calls appear as messages in the Activity Monitor. Written files show up in a **file tree** in the left sidebar; click any file to open it in the **code viewer** panel.

> The File System Access API requires a browser that supports it (Chrome 86+, Edge 86+). Firefox does not support it.

---

## WebLLM (in-browser inference)

Select **WebLLM 🌐** in Settings to run a quantised model entirely in your browser using WebGPU. No API key or external server needed.

**Requirements:** Chrome 113+ or Edge 113+ (WebGPU). Firefox and Safari do not support WebGPU by default.

**Workflow:**
1. Open Settings → select WebLLM → pick a model
2. Click **Run** — the model downloads to your browser cache on first use (~500 MB – 4 GB depending on model)
3. A progress bar appears below the navbar during loading; subsequent runs use the cache instantly

**Available models (curated list):**

| Model | Size (approx) | Notes |
|---|---|---|
| `TinyLlama-1.1B-Chat-v1.0-q4f16_1-MLC` | ~700 MB | Fastest; good for testing |
| `Llama-3.2-1B-Instruct-q4f16_1-MLC` | ~800 MB | Small, fast |
| `Llama-3.2-3B-Instruct-q4f16_1-MLC` | ~2 GB | Good balance |
| `Phi-3.5-mini-instruct-q4f16_1-MLC` | ~2 GB | Strong at reasoning |
| `gemma-2-2b-it-q4f16_1-MLC` | ~1.5 GB | Google's 2B model |
| `Mistral-7B-Instruct-v0.3-q4f16_1-MLC` | ~4 GB | Higher quality |
| `Llama-3.1-8B-Instruct-q4f32_1-MLC` | ~4 GB | Best quality locally |

---

## LLM providers

Open **⚙ Settings** to pick a provider. The provider grid covers:

| Provider | Kind | Notes |
|---|---|---|
| **Ollama** | Local | `ollama pull llama3.2` · click ↺ Discover |
| **LM Studio** | Local | Start local server · click ↺ Discover |
| **WebLLM** | In-browser | WebGPU required; no key needed |
| **OpenRouter** | Cloud | 200+ models; free tier available |
| **Groq** | Cloud | Very fast inference; free tier |
| **OpenAI** | Cloud | GPT-4o and variants |
| **Anthropic** | Cloud | Claude models |
| **Gemini** | Cloud | Google Gemini; free tier |
| **Together** | Cloud | Open-source cloud models |
| **Custom** | Cloud | Any OpenAI-compatible endpoint |

API keys are stored only in `localStorage` and never sent anywhere except your chosen endpoint.

---

## Agent communication protocol

Agents respond with JSON. GREMLIN parses and routes the messages automatically:

```json
{
  "analysis": "My reasoning goes here",
  "messages": [
    { "to": "critic",      "content": "Can you verify finding #3?" },
    { "to": "synthesizer", "content": "Final results: …" }
  ],
  "done": false,
  "result": null
}
```

- `"done": true` marks the agent's task as complete
- `"result"` contains the final output (the synthesizer's result is shown to the user)
- Plain-text responses are accepted as a fallback — treated as a final result

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                          Browser                            │
│                                                             │
│  ┌─────────────────┐      ┌────────────────────────────┐   │
│  │  Svelte 5 UI    │─────▶│  WASM Coordinator (Rust)   │   │
│  │  (TypeScript)   │◀─────│  • Agent registry          │   │
│  │                 │      │  • Message routing         │   │
│  │  Activity       │      │  • Session state           │   │
│  │  Monitor        │      │  SIMD128 + bulk-memory     │   │
│  │  File Tree      │      └────────────────────────────┘   │
│  │  Code Viewer    │                                        │
│  └────────┬────────┘                                        │
│           │                                                 │
│  ┌────────▼────────┐    ┌──────────────────────────────┐   │
│  │  AgentRunner.ts │    │  File System Access API      │   │
│  │  • Calls LLM    │    │  write_file / read_file /    │   │
│  │  • Tool loop    │───▶│  list_directory              │   │
│  │  • Routes msgs  │    │  (Engineering mode only)     │   │
│  └────────┬────────┘    └──────────────────────────────┘   │
│           │ fetch()  or  WebGPU (WebLLM)                   │
└───────────┼─────────────────────────────────────────────────┘
            ▼
   ┌─────────────────────────────────────┐
   │  LLM                                │
   │  Anthropic / OpenAI / Gemini /      │
   │  Ollama / Groq / OpenRouter /       │
   │  WebLLM (in-browser WebGPU) / …    │
   └─────────────────────────────────────┘
```

---

## Project structure

```
gremlin/
├── crates/
│   └── coordinator/            # Rust WASM module
│       ├── Cargo.toml
│       └── src/lib.rs           # Agent state machine & message router
├── web/
│   ├── src/
│   │   ├── App.svelte            # Main layout, navbar, mode bar
│   │   ├── app.css               # Glass-morphism design system
│   │   ├── lib/
│   │   │   ├── types.ts          # Types, providers, mode presets
│   │   │   ├── coordinator.ts    # WASM JS bindings
│   │   │   ├── api.ts            # LLM call functions (all providers + tool loops)
│   │   │   ├── agentRunner.ts    # Multi-agent orchestration engine
│   │   │   ├── store.svelte.ts   # Reactive global state (Svelte 5 runes)
│   │   │   ├── filesystem.ts     # File System Access API wrapper
│   │   │   ├── tools.ts          # Tool definitions + executor (dev mode)
│   │   │   └── webllm.ts         # WebLLM / WebGPU wrapper
│   │   ├── components/
│   │   │   ├── ActivityMonitor.svelte  # Real-time message feed
│   │   │   ├── AgentCard.svelte        # Sidebar agent widget
│   │   │   ├── AgentPanel.svelte       # Agent detail + human input
│   │   │   ├── AgentEditModal.svelte   # Add/edit agent dialog
│   │   │   ├── SettingsModal.svelte    # Provider + API settings
│   │   │   ├── FileTree.svelte         # Project file tree (dev mode)
│   │   │   ├── CodeViewer.svelte       # File content viewer (dev mode)
│   │   │   └── NewModeModal.svelte     # Create custom mode dialog
│   │   └── wasm/                 # Generated by wasm-pack (git-ignored)
│   ├── scripts/
│   │   └── encode-wasm.mjs       # Base64-encodes WASM for single-file build
│   ├── index.html
│   ├── package.json
│   └── vite.config.ts
├── Cargo.toml                    # Rust workspace
├── package.json                  # Root npm scripts
└── setup.sh                      # One-shot build script
```

---

## WASM hardware acceleration

The Rust coordinator compiles with:

- **SIMD128** — 128-bit vectorised operations
- **Bulk memory** — faster `memcpy` / `memset`
- **Non-trapping float-to-int** — eliminates runtime conversion checks
- **LTO + opt-level 3** — full link-time and compiler optimisation

Browser support: Chrome 91+, Firefox 89+, Safari 16.4+, Edge 91+.

---

## Deployment

GREMLIN is a single HTML file (`web/dist/index.html`) that can be hosted anywhere — Cloudflare Pages, GitHub Pages, Netlify, S3, or any static file server.

### What works out of the box

- **Web search** — DuckDuckGo is the default provider, routed through a built-in CORS proxy. No API key or configuration needed.
- **Cloud LLM providers** — OpenRouter, Anthropic, OpenAI, Gemini, Groq, Together all route through the CORS proxy automatically. Just add your API key in Settings.
- **All UI, modes, and agents** — everything runs client-side.

### Local LLM providers (Ollama, LM Studio)

If you host the site on a custom domain (e.g. `gremlin.example.com`) and want to use a local Ollama instance, you need to allow the origin:

```bash
OLLAMA_ORIGINS=https://gremlin.example.com ollama serve
```

This is because Ollama only accepts requests from `localhost` by default. LM Studio has a similar CORS setting in its server preferences.

### CORS proxy

A Cloudflare Worker in `proxy/` handles CORS for external APIs (search providers and cloud LLM endpoints). It's already deployed and configured as the default — no setup required.

To deploy your own proxy:

```bash
cd proxy
npx wrangler login
npx wrangler deploy
```

Then update the proxy URL in `web/src/lib/types.ts` (`DEFAULT_SETTINGS.proxyUrl`) or override it per-user in Settings.

### Search providers

| Provider | API key needed | Notes |
|---|---|---|
| **DuckDuckGo** (default) | No | HTML scrape via CORS proxy |
| **Brave Search** | Yes | [brave.com/search/api](https://brave.com/search/api/) |
| **Serper** (Google) | Yes | [serper.dev](https://serper.dev) |
| **Tavily** | Yes | [tavily.com](https://tavily.com) |
| **SearXNG** | No | Self-hosted; set your instance URL in Settings |

---

## Troubleshooting

**`WASM coordinator failed to load`**
→ Run `npm run build:wasm` from `web/` to compile the Rust module.

**`wasm-pack --out-dir` writes to the wrong directory**
→ Use an absolute path: `--out-dir "$(pwd)/web/src/wasm"`. Relative paths are resolved relative to the crate, not the workspace root.

**`API 401 / 403`**
→ Check your API key in Settings.

**`CORS error` in browser console**
→ If opening locally: serve over HTTP, not `file://`: `npx serve web/dist`
→ If using Ollama from a hosted site: set `OLLAMA_ORIGINS=https://your-domain.com` when starting Ollama
→ If web search fails: check that the CORS proxy URL is set in Settings (the default should work)

**WebLLM: `WebGPU is not available`**
→ Use Chrome 113+ or Edge 113+. Firefox and Safari do not support WebGPU by default.

**WebLLM: model loads but produces garbled output**
→ Some quantised models struggle with strict JSON. Switch to a larger model or use a server-side provider.

**`wasm-pack not found` on Windows**
→ Run `cargo install wasm-pack`, then restart your terminal.

**Agents produce plain text instead of JSON**
→ Smaller or older models sometimes ignore the JSON format instruction. Try a larger or more instruction-tuned model.

---

## License

MIT
