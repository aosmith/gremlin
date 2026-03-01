/**
 * WebLLM wrapper — runs LLMs in-browser using WebGPU.
 * Lazily initializes when first needed; caches the engine for reuse.
 */

import type { InitProgressReport, MLCEngineInterface } from '@mlc-ai/web-llm'

export type WebLLMProgress = { text: string; progress: number }
export type ProgressCallback = (p: WebLLMProgress) => void

let engine: MLCEngineInterface | null = null
let loadedModel = ''

/** Check WebGPU availability */
export function isWebGPUAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator
}

/**
 * Get (or lazily create) the WebLLM engine for the given model.
 * Downloads and caches the model on first use.
 */
export async function getEngine(
  model: string,
  onProgress?: ProgressCallback,
): Promise<MLCEngineInterface> {
  if (engine && loadedModel === model) return engine

  // Dynamically import to avoid loading the heavy library unless needed
  const { CreateMLCEngine } = await import('@mlc-ai/web-llm')

  engine = await CreateMLCEngine(model, {
    initProgressCallback: (report: InitProgressReport) => {
      onProgress?.({ text: report.text, progress: report.progress })
    },
  })
  loadedModel = model
  return engine
}

export function getLoadedModel(): string {
  return loadedModel
}

/**
 * Call the WebLLM engine with an OpenAI-compatible messages array.
 * Handles model loading progress via onProgress callback.
 */
export async function callWebLLM(
  messages: Array<{ role: string; content: string }>,
  model: string,
  maxTokens = 4096,
  onProgress?: ProgressCallback,
): Promise<string> {
  if (!isWebGPUAvailable()) {
    throw new Error('WebGPU is not available in this browser. Try Chrome 113+ or Edge 113+.')
  }

  const eng = await getEngine(model, onProgress)

  const response = await eng.chat.completions.create({
    messages: messages as Parameters<typeof eng.chat.completions.create>[0]['messages'],
    max_tokens: maxTokens,
    stream: false,
  })

  return (response.choices[0]?.message?.content as string) ?? ''
}
