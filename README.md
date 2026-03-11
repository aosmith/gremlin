# ⚡ GREMLIN

A local, browser-native multi-agent coordinator. A TypeScript module routes all inter-agent messages; a Svelte UI lets you watch every conversation and inject human input at any point. No server required.

---

## Getting started

Pick a provider, get a model, and run. Here are links for the most common setups:

| Provider | Type | Get started |
|---|---|---|
| **Ollama** | Local, free | [ollama.com](https://ollama.com) — install, then `ollama pull llama3.2` |
| **LM Studio** | Local, free | [lmstudio.ai](https://lmstudio.ai) — download a model, start the local server |
| **WebLLM** | In-browser, free | No install — select WebLLM in Settings, pick a model, runs via [WebGPU](https://developer.chrome.com/docs/web-platform/webgpu) (Chrome 113+) |
| **OpenRouter** | Cloud, free tier | [openrouter.ai](https://openrouter.ai) — create account, copy API key |
| **Groq** | Cloud, free tier | [console.groq.com](https://console.groq.com) — create account, copy API key |
| **OpenAI** | Cloud, paid | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| **Anthropic** | Cloud, paid | [console.anthropic.com](https://console.anthropic.com) — create API key |
| **Google Gemini** | Cloud, free tier | [aistudio.google.com](https://aistudio.google.com) — create API key |
| **Together** | Cloud, paid | [api.together.xyz](https://api.together.xyz) — create account, copy API key |

Once you have a provider ready, open GREMLIN → **Settings** (⚙) → pick your provider → paste your key (if needed) → pick a model → **Save**. Type a task and hit **Run**.

---

## Features

| | |
|---|---|
| 🧠 **TypeScript coordinator** | In-memory agent state machine with message routing |
| 🤝 **Collaborative agents** | Agents have individual system prompts and message each other autonomously |
| 🔍 **Full visibility** | Every inter-agent message is shown in real time — nothing hidden |
| 💬 **Human-in-the-loop** | Click any agent during a run to read its thread and inject instructions |
| 🗂 **7 built-in modes** | General · Engineering · Finance · Industrial · Biomedical · Medicine · Networking |
| ⚙ **Dev mode** | Engineering agents write real files to your disk via the File System Access API |
| 🔎 **Web search** | DuckDuckGo out of the box — or configure Brave, Serper, Tavily, SearXNG |
| 🌐 **WebLLM** | Run quantised models entirely in the browser via WebGPU — no server or key needed |
| 🖼 **Multimodal** | Attach, paste, or drag-and-drop images into your task prompt |
| 🔌 **10 providers** | Ollama, LM Studio, WebLLM, OpenRouter, Groq, OpenAI, Anthropic, Gemini, Together, Custom |
| 📦 **Single HTML file** | `dist/index.html` has everything inlined — JS, CSS, all assets |
| 🏠 **Fully local** | No backend, no accounts; only outbound traffic is calls to your chosen LLM |

---

## Quick start

### Prerequisites

| Tool | Version | Install |
|---|---|---|
| Node.js | 18+ | [nodejs.org](https://nodejs.org) |

### Build

```bash
git clone https://github.com/aosmith/gremlin.git
cd gremlin
bash setup.sh
```

This installs dependencies and builds everything. Output: `web/dist/index.html` — a single self-contained file.

Or build manually:

```bash
cd web
npm install
npm run build
```

### Serve

```bash
# Any static file server works:
npx serve dist               # → http://localhost:3000
python3 -m http.server 3000 -d dist
```

### Development (live reload)

```bash
cd web
npm run dev   # → http://localhost:5173
```

---

## Modes

Switch modes with the tab bar below the navbar. Each mode loads a different set of agents. Agent configs are saved per-mode.

| Mode | Agents | Use for |
|---|---|---|
| **General** 🌐 | CEO · Researcher · Analyst · Critic · Writer · Chief of Staff | Research, writing, analysis |
| **Engineering** ⚙ | CTO · Frontend Dev · Backend Dev · Full-Stack Dev · DevOps · QA · Security · Simplicity Eng · Staff Engineer | Software projects |
| **Finance** 📈 | Capital Allocator · Value Analyst · Activist Analyst · Risk Manager · Sector Analyst · News & Sentiment · Investment Strategist | Investment research |
| **Industrial** 🏭 | General Manager · Manufacturing Eng · Operations Manager · Supply Chain · Quality Eng · Commercial Manager · Plant Controller | Manufacturing, operations & supply chain |
| **Biomedical** 🧬 | Chief Dev Officer · Research Scientist · Regulatory Affairs · Clinical Affairs · CMC · Quality & Compliance · Pharmacovigilance · Program Director | Drug & device development |
| **Medicine** 🩺 | Attending Physician · Internist · Radiologist · Lab Medicine · Clinical Pharmacist · Nurse Practitioner · Chief of Medicine | Clinical reasoning, diagnosis, treatment |
| **Networking** 📡 | NOC Director · Transport Eng · IP/MPLS Eng · Voice/UC Eng · RF/Wireless Eng · Security Analyst · Service Assurance Lead | Telecom NOC, triage, routing |
| **+ New Mode** | Snapshot of your current agents | Any custom team |

Click **+ New Mode** to save your current agent configuration as a named mode. Custom modes can be deleted; the seven built-in ones cannot.

---

## Dev mode (Engineering)

When the **Engineering** mode is active, a **📁 Open Folder** button appears in the toolbar. Select a local project directory and the agents gain file system tools:

| Tool | Description |
|---|---|
| `write_file(path, content)` | Create or overwrite a file (parent directories are created automatically) |
| `read_file(path)` | Read a file's full content |
| `list_directory(path)` | List files and subdirectories |

Tool calls appear as messages in the Activity Monitor. Written files show up in a **file tree** in the left sidebar; click any file to open it in the **code viewer** panel.

> The File System Access API requires Chrome 86+ or Edge 86+. Firefox does not support it.

---

## Web search

Agents can search the web and fetch pages during a run. Two search tools are available:

| Tool | Description |
|---|---|
| `web_search(query)` | Search the web via the configured provider |
| `web_fetch(url)` | Fetch and extract text from any URL (max 30k chars) |

**DuckDuckGo** is the default search provider — no API key needed. For better results, configure a provider in Settings:

| Provider | API key needed | Notes |
|---|---|---|
| **DuckDuckGo** (default) | No | HTML scrape via CORS proxy |
| **Brave Search** | Yes | Free tier: 2,000 queries/mo |
| **Serper** (Google) | Yes | Free tier: 2,500 queries/mo |
| **Tavily** | Yes | AI-optimised, free tier: 1,000 queries/mo |
| **SearXNG** | No | Self-hosted; set your instance URL in Settings |

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
| `Llama-3.2-3B-Instruct-q4f16_1-MLC` | ~2 GB | Good balance (default) |
| `Qwen2.5-3B-Instruct-q4f16_1-MLC` | ~2 GB | Strong at reasoning |
| `Phi-3.5-mini-instruct-q4f16_1-MLC` | ~2 GB | Microsoft's compact model |
| `gemma-2-2b-it-q4f16_1-MLC` | ~1.5 GB | Google's 2B model |
| `Qwen2.5-7B-Instruct-q4f16_1-MLC` | ~4 GB | Higher quality |
| `Mistral-7B-Instruct-v0.3-q4f16_1-MLC` | ~4 GB | Strong general-purpose |
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

Agents also have access to protocol tools (`send_message`, `mark_done`) for providers that support tool calling.

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                         Browser                          │
│                                                          │
│  ┌─────────────────┐    ┌────────────────────────────┐   │
│  │  Svelte 5 UI    │───▶│  Coordinator (TypeScript)  │   │
│  │  (TypeScript)   │◀───│  • Agent registry          │   │
│  │                 │    │  • Message routing          │   │
│  │  Activity       │    │  • Session state            │   │
│  │  Monitor        │    └────────────────────────────┘   │
│  │  File Tree      │                                     │
│  │  Code Viewer    │                                     │
│  └────────┬────────┘                                     │
│           │                                              │
│  ┌────────▼────────┐    ┌────────────────────────────┐   │
│  │  AgentRunner.ts │    │  File System Access API    │   │
│  │  • Calls LLM    │    │  write_file / read_file /  │   │
│  │  • Tool loop    │───▶│  list_directory            │   │
│  │  • Routes msgs  │    │  (Engineering mode only)   │   │
│  │  • Web search   │    └────────────────────────────┘   │
│  └────────┬────────┘                                     │
│           │ fetch()  or  WebGPU (WebLLM)                 │
└───────────┼──────────────────────────────────────────────┘
            ▼
   ┌─────────────────────────────────┐
   │  LLM                           │
   │  Anthropic / OpenAI / Gemini   │
   │  Ollama / Groq / OpenRouter    │
   │  Together / WebLLM (WebGPU)    │
   └─────────────────────────────────┘
```

---

## Project structure

```
gremlin/
├── web/
│   ├── src/
│   │   ├── App.svelte              # Main layout, navbar, mode bar, modals
│   │   ├── app.css                 # Glass-morphism design system
│   │   ├── lib/
│   │   │   ├── types.ts            # Types, providers, mode presets, agent configs
│   │   │   ├── coordinator.ts      # In-memory agent state & message router
│   │   │   ├── api.ts              # LLM call functions (all formats + tool loops)
│   │   │   ├── agentRunner.ts      # Multi-agent orchestration engine
│   │   │   ├── store.svelte.ts     # Reactive global state (Svelte 5 runes)
│   │   │   ├── filesystem.ts       # File System Access API wrapper
│   │   │   ├── tools.ts            # Tool definitions + executor (dev/search/protocol)
│   │   │   ├── webllm.ts           # WebLLM / WebGPU wrapper
│   │   │   ├── cleanContent.ts     # Protocol JSON → readable display text
│   │   │   └── tableCards.ts       # Prose enhancement (tables, callouts)
│   │   └── components/
│   │       ├── ActivityMonitor.svelte  # Real-time message feed
│   │       ├── AgentCard.svelte        # Sidebar agent widget
│   │       ├── AgentPanel.svelte       # Agent detail + human input
│   │       ├── AgentEditModal.svelte   # Add/edit agent dialog
│   │       ├── SettingsModal.svelte    # Provider + API settings
│   │       ├── HelpModal.svelte        # Setup guide + onboarding
│   │       ├── SessionHistory.svelte   # Past session browser
│   │       ├── FileTree.svelte         # Project file tree (dev mode)
│   │       ├── CodeViewer.svelte       # File content viewer (dev mode)
│   │       └── NewModeModal.svelte     # Create custom mode dialog
│   ├── scripts/
│   │   └── smoke-test.mjs          # Post-build smoke test
│   ├── index.html
│   ├── package.json
│   └── vite.config.ts
├── proxy/
│   ├── worker.js                   # Cloudflare Worker CORS proxy
│   └── wrangler.toml
├── setup.sh                        # One-shot build script
└── package.json                    # Root npm scripts
```

---

## Deployment

GREMLIN is a single HTML file (`web/dist/index.html`) that can be hosted anywhere — Cloudflare Pages, GitHub Pages, Netlify, S3, or any static file server.

### What works out of the box

- **Most LLM providers** — OpenAI, Anthropic, OpenRouter, Gemini, Together all support browser CORS natively. Just add your API key in Settings.
- **Web search** — DuckDuckGo is the default provider, routed through a CORS proxy. No API key needed.
- **All UI, modes, and agents** — everything runs client-side.

### CORS proxy

A few services block browser requests (Groq, DuckDuckGo, Brave Search). GREMLIN ships with a default Cloudflare Worker proxy for those. Providers that support browser CORS (OpenAI, Anthropic, OpenRouter, Gemini, Together, Serper, Tavily, and all local providers) always go direct.

To deploy your own proxy:

```bash
cd proxy
npx wrangler login
npx wrangler deploy
```

Then update the proxy URL in Settings → Advanced, or in `web/src/lib/types.ts` (`DEFAULT_SETTINGS.proxyUrl`).

### Local LLM providers (Ollama, LM Studio)

If you host the site on a custom domain (e.g. `gremlin.example.com`) and want to use a local Ollama instance, you need to allow the origin:

```bash
OLLAMA_ORIGINS=https://gremlin.example.com ollama serve
```

Ollama only accepts requests from `localhost` by default. LM Studio has a similar CORS setting in its server preferences.

---

## Troubleshooting

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

**Agents produce plain text instead of JSON**
→ Smaller or older models sometimes ignore the JSON format instruction. Try a larger or more instruction-tuned model.

---

## License

[PolyForm Noncommercial 1.0.0](LICENSE.md) — free for personal and noncommercial use.
