// Embeddings utility-process worker — its own esbuild entry (see
// scripts/build-main.mjs). Runs transformers.js so model load, tokenization
// and tensor marshalling never block the main process (which brokers
// approvals and streams agent events). A native ORT crash kills THIS
// process, not the app.
//
// RPC over Electron utilityProcess MessagePort:
//   in : { id, type: 'embed', texts: string[] }
//   out: { id, ok: true, vectors: number[][] } | { id, ok: false, error }
//   out (unsolicited): { type: 'status', state, progress?, message? }

import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers'

const MODEL = 'Xenova/all-MiniLM-L6-v2'

interface EmbedMsg {
  id: number
  type: 'embed'
  texts: string[]
}

let extractor: FeatureExtractionPipeline | null = null
let loading: Promise<FeatureExtractionPipeline> | null = null

function post(msg: unknown): void {
  // typeof check keeps this file loadable under plain node for debugging
  if (typeof process.parentPort !== 'undefined') process.parentPort.postMessage(msg)
}

async function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (extractor) return extractor
  if (!loading) {
    const cacheDir = process.env.MESH_MODEL_CACHE
    if (cacheDir) env.cacheDir = cacheDir
    post({ type: 'status', state: 'downloading', progress: 0 })
    loading = pipeline('feature-extraction', MODEL, {
      dtype: 'q8',
      progress_callback: (p: { status?: string; progress?: number }) => {
        if (typeof p.progress === 'number') post({ type: 'status', state: 'downloading', progress: p.progress })
      },
    }).then((ex) => {
      extractor = ex as FeatureExtractionPipeline
      post({ type: 'status', state: 'ready' })
      return extractor
    })
    loading.catch((e: Error) => {
      post({ type: 'status', state: 'error', message: e.message })
      loading = null
    })
  }
  return loading
}

process.parentPort?.on('message', (e: { data: EmbedMsg }) => {
  const msg = e.data
  if (msg?.type !== 'embed') return
  void (async () => {
    try {
      const ex = await getExtractor()
      const out = await ex(msg.texts, { pooling: 'mean', normalize: true })
      // out.data is a flat Float32Array [n * dims]
      const dims = (out.dims as number[])[1]
      const flat = out.data as Float32Array
      const vectors: number[][] = []
      for (let i = 0; i < msg.texts.length; i++) vectors.push(Array.from(flat.subarray(i * dims, (i + 1) * dims)))
      post({ id: msg.id, ok: true, vectors })
    } catch (err) {
      post({ id: msg.id, ok: false, error: (err as Error).message })
    }
  })()
})

// Kick the model load immediately — the download races user activity, and
// search degrades gracefully until 'ready' arrives.
void getExtractor().catch(() => {})
