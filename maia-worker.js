/**
 * Maia3 Web Worker — runs ONNX inference off the main thread.
 *
 * Messages FROM main thread:
 *   { type: 'init', modelUrl, modelVersion }
 *   { type: 'download' }
 *   { type: 'inference', id, tokens, eloSelfs, eloOppos, batchSize }
 *
 * Messages TO main thread:
 *   { type: 'status', status }
 *   { type: 'progress', progress }
 *   { type: 'error', message, id? }
 *   { type: 'inference-result', id, logitsMove, logitsValue }
 */

importScripts('/ort/ort.wasm.min.js')

const ORT = ort
ORT.env.wasm.wasmPaths = '/ort/'

// ── Cache API storage ─────────────────────────────────────────────────────────
// The Cache API is purpose-built for large binary resources and persists
// reliably across page reloads.  IndexedDB blob/ArrayBuffer storage had
// fragile durability guarantees for 87 MB payloads in many browsers.

const CACHE_STORE = 'maia-model-cache'  // cache bucket name
const CACHE_KEY   = 'maia3-model-data'  // entry key within the bucket

async function getCachedModel(modelUrl, modelVersion) {
  try {
    const cache  = await caches.open(CACHE_STORE)
    const stored = await cache.match(CACHE_KEY)
    if (!stored) return null
    // Verify URL + version so stale entries are not used after model updates
    if (stored.headers.get('X-Model-Url')     !== modelUrl ||
        stored.headers.get('X-Model-Version') !== modelVersion) {
      await cache.delete(CACHE_KEY)
      return null
    }
    const buf = await stored.arrayBuffer()
    return buf.byteLength > 0 ? buf : null
  } catch (e) {
    return null
  }
}

async function storeModel(modelUrl, modelVersion, buffer) {
  const cache    = await caches.open(CACHE_STORE)
  const response = new Response(buffer, {
    headers: {
      'Content-Type':    'application/octet-stream',
      'X-Model-Url':     modelUrl,
      'X-Model-Version': modelVersion,
    }
  })
  await cache.put(CACHE_KEY, response)
}

// ── Worker state ─────────────────────────────────────────────────────────────

let session = null
let modelUrl = null
let modelVersion = null

async function initSession(buffer) {
  session = await ORT.InferenceSession.create(buffer)
}

// ── Message handler ──────────────────────────────────────────────────────────

self.onmessage = async (e) => {
  const msg = e.data

  try {
    switch (msg.type) {
      case 'init': {
        modelUrl = msg.modelUrl
        modelVersion = msg.modelVersion
        postMessage({ type: 'status', status: 'loading' })

        const buffer = await getCachedModel(modelUrl, modelVersion)
        if (buffer) {
          await initSession(buffer)
          postMessage({ type: 'status', status: 'ready' })
        } else {
          postMessage({ type: 'status', status: 'no-cache' })
        }
        break
      }

      case 'download': {
        postMessage({ type: 'status', status: 'downloading' })
        postMessage({ type: 'progress', progress: 0 })
        const response = await fetch(modelUrl)
        if (!response.ok) throw new Error('Failed to fetch model')

        let buffer

        if (response.body && typeof response.body.getReader === 'function') {
          const reader = response.body.getReader()
          const contentLength = +(response.headers.get('Content-Length') || 0)
          const chunks = []
          let receivedLength = 0
          let lastReportedProgress = 0

          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            chunks.push(value)
            receivedLength += value.length

            if (contentLength > 0) {
              const currentProgress = Math.floor(
                (receivedLength / contentLength) * 100,
              )
              if (currentProgress >= lastReportedProgress + 10) {
                postMessage({ type: 'progress', progress: currentProgress })
                lastReportedProgress = currentProgress
              }
            }
          }

          buffer = new Uint8Array(receivedLength)
          let position = 0
          for (const chunk of chunks) {
            buffer.set(chunk, position)
            position += chunk.length
          }
        } else {
          buffer = new Uint8Array(await response.arrayBuffer())
        }

        await storeModel(modelUrl, modelVersion, buffer.buffer)
        await initSession(buffer.buffer)
        postMessage({ type: 'progress', progress: 100 })
        postMessage({ type: 'status', status: 'ready' })
        break
      }

      case 'inference': {
        if (!session) {
          postMessage({
            type: 'error',
            message: 'Model not initialized',
            id: msg.id,
          })
          return
        }

        const { id, tokens, eloSelfs, eloOppos, batchSize } = msg

        const feeds = {
          tokens: new ORT.Tensor('float32', new Float32Array(tokens), [
            batchSize,
            64,
            12,
          ]),
          elo_self: new ORT.Tensor('float32', new Float32Array(eloSelfs), [
            batchSize,
          ]),
          elo_oppo: new ORT.Tensor('float32', new Float32Array(eloOppos), [
            batchSize,
          ]),
        }

        const result = await session.run(feeds)

        const logitsMove = new Float32Array(result.logits_move.data)
        const logitsValue = new Float32Array(result.logits_value.data)

        postMessage(
          {
            type: 'inference-result',
            id,
            logitsMove: logitsMove.buffer,
            logitsValue: logitsValue.buffer,
          },
          [logitsMove.buffer, logitsValue.buffer],
        )
        break
      }
    }
  } catch (err) {
    postMessage({
      type: 'error',
      message: err.message || 'Unknown worker error',
      id: msg.id,
    })
  }
}
