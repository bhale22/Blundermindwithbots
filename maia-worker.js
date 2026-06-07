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

// ── Storage layer: Cache API (primary) + IndexedDB (secondary) ───────────────
//
// Cache API is the primary store because browsers treat it as persistent by
// default for large assets and it survives storage-pressure eviction better
// than IndexedDB for origins without explicit persistent-storage permission.
// IndexedDB is kept as a fallback so existing cached copies still work.
//
// Cache name encodes the model version so stale caches are automatically
// bypassed when the version string changes (no manual invalidation needed).

const CACHE_NAME_PREFIX = 'maia-model-'   // + modelVersion, e.g. 'maia-model-3'

// ── Cache API helpers ─────────────────────────────────────────────────────────

async function getFromCacheApi(modelUrl, modelVersion) {
  if (typeof self.caches === 'undefined') return null
  try {
    const cache  = await self.caches.open(CACHE_NAME_PREFIX + modelVersion)
    const match  = await cache.match(modelUrl)
    if (!match) return null
    return await match.arrayBuffer()
  } catch (e) {
    return null
  }
}

async function storeInCacheApi(modelUrl, modelVersion, buffer) {
  if (typeof self.caches === 'undefined') return
  try {
    const cache    = await self.caches.open(CACHE_NAME_PREFIX + modelVersion)
    const response = new Response(buffer.slice(0), {   // slice = copy, keeps original intact
      headers: { 'Content-Type': 'application/octet-stream' }
    })
    await cache.put(modelUrl, response)
  } catch (e) {
    // Cache API unavailable or quota exceeded — IndexedDB copy is the fallback
  }
}

// ── IndexedDB storage (fallback / legacy) ─────────────────────────────────────

const DB_NAME = 'MaiaModels'
const STORE_NAME = 'models'
const MODEL_KEY = 'maia-rapid-model'

function isCompatibleModelCache(data, expectedUrl, expectedVersion) {
  return data.url === expectedUrl && data.version === expectedVersion
}

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
    request.onupgradeneeded = (event) => {
      const db = event.target.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' })
      }
    }
  })
}

async function getFromIndexedDB(modelUrl, modelVersion) {
  try {
    const db    = await openDB()
    const tx    = db.transaction([STORE_NAME], 'readonly')
    const store = tx.objectStore(STORE_NAME)

    const data = await new Promise((resolve, reject) => {
      const req = store.get(MODEL_KEY)
      req.onsuccess = () => resolve(req.result || null)
      req.onerror  = () => reject(req.error)
    })

    if (!data) return null

    if (!isCompatibleModelCache(data, modelUrl, modelVersion)) {
      // Version mismatch — delete stale entry and report miss
      try {
        const rwTx = db.transaction([STORE_NAME], 'readwrite')
        rwTx.objectStore(STORE_NAME).delete(MODEL_KEY)
      } catch (_) {}
      return null
    }

    // Support both ArrayBuffer (current format) and Blob (legacy cache entries)
    const raw = data.data
    if (raw instanceof ArrayBuffer) return raw
    try { return await raw.arrayBuffer() } catch (e) { return null }
  } catch (e) {
    return null
  }
}

async function storeInIndexedDB(modelUrl, modelVersion, buffer) {
  try {
    const db    = await openDB()
    const tx    = db.transaction([STORE_NAME], 'readwrite')
    const store = tx.objectStore(STORE_NAME)

    await new Promise((resolve, reject) => {
      const req = store.put({
        id: MODEL_KEY,
        url: modelUrl,
        version: modelVersion,
        data: buffer,
        timestamp: Date.now(),
        size: buffer.byteLength,
      })
      req.onsuccess = () => resolve()
      req.onerror   = () => reject(req.error)
    })
  } catch (e) {
    // IndexedDB unavailable or quota exceeded
  }
}

// ── Unified cache read/write ──────────────────────────────────────────────────

async function getCachedModel(modelUrl, modelVersion) {
  // 1. Try Cache API (primary — more persistent for large assets)
  const cacheBuffer = await getFromCacheApi(modelUrl, modelVersion)
  if (cacheBuffer) return cacheBuffer

  // 2. Fall back to IndexedDB (existing installs, or if Cache API is unavailable)
  const idbBuffer = await getFromIndexedDB(modelUrl, modelVersion)
  if (idbBuffer) {
    // Opportunistically promote to Cache API so future loads use the faster path
    storeInCacheApi(modelUrl, modelVersion, idbBuffer).catch(() => {})
  }
  return idbBuffer
}

async function storeModel(modelUrl, modelVersion, buffer) {
  // Write to both stores in parallel; failures are silent (the other store is the safety net)
  await Promise.allSettled([
    storeInCacheApi(modelUrl, modelVersion, buffer),
    storeInIndexedDB(modelUrl, modelVersion, buffer),
  ])
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
