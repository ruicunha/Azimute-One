import type { Cm93PolygonClippingEngine } from './cm93-quilt-geometry.ts';
import type { Cm93ScaleCode } from './cm93-quilt.ts';

export type Cm93CacheTimings = { indexedDbReadMs?: number; workerProcessingMs?: number; workerRoundTripMs?: number; workerOverheadMs?: number; telemetryMs?: number; geometryBuildMs?: number; persistMs?: number; serializedPayloadBytes?: number; compressedPayloadBytes?: number; serializeMs?: number; compressMs?: number; decompressMs?: number; deserializeMs?: number; cacheCompression?: 'gzip' | 'none'; cacheTransferMode?: 'arraybuffer-transfer' | 'structured-clone' };

export type Cm93CacheTelemetry = {
  hits: number;
  misses: number;
  readErrors: number;
  writes: number;
  writeErrors: number;
  evictions: number;
  skippedOversized: number;
  entries: number;
  estimatedBytes: number;
  budgetBytes: number;
};

type WorkerReply = { id?: number; type?: string; ok?: boolean; value?: unknown; error?: string; telemetry?: Cm93CacheTelemetry; timings?: Cm93CacheTimings };
type WorkerRequest = { id: number; type: string; [key: string]: unknown };
type PendingRequest = { resolve: (value: unknown) => void; reject: (error: Error) => void };
let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, PendingRequest>();
let telemetryListener: ((telemetry: Cm93CacheTelemetry, timings?: Cm93CacheTimings) => void) | null = null;

export function onCm93CacheTelemetry(listener: (telemetry: Cm93CacheTelemetry, timings?: Cm93CacheTimings) => void): () => void {
  telemetryListener = listener;
  return () => { if (telemetryListener === listener) telemetryListener = null; };
}

function getWorker(): Worker | null {
  if (typeof Worker === 'undefined' || typeof indexedDB === 'undefined') return null;
  if (!worker) {
    try {
      worker = new Worker(new URL('./cm93-quilt-cache.worker.ts', import.meta.url), { type: 'module' });
      worker.addEventListener('message', (event: MessageEvent<WorkerReply>) => {
        if (event.data.type === 'telemetry' && event.data.telemetry) {
          telemetryListener?.(event.data.telemetry, event.data.timings);
          return;
        }
        if (typeof event.data.id !== 'number') return;
        const request = pending.get(event.data.id);
        if (!request) return;
        pending.delete(event.data.id);
        if (event.data.ok) request.resolve(event.data.value);
        else request.reject(new Error(event.data.error ?? 'CM93 browser cache operation failed.'));
      });
      worker.addEventListener('error', () => {
        for (const request of pending.values()) request.reject(new Error('CM93 browser cache worker failed.'));
        pending.clear();
        worker?.terminate();
        worker = null;
      });
    } catch {
      return null;
    }
  }
  return worker;
}

function sendRequest(activeWorker: Worker, message: Omit<WorkerRequest, 'id'>): Promise<unknown> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    // Cache lookup deliberately sends only the key. Decoded GeoJSON is sent
    // in a separate build request only after the worker confirms a miss.
    activeWorker.postMessage({ ...message, id });
  });
}

export async function lookupCm93CachedQuilt<T>(
  key: string,
): Promise<
  | { value: T; cacheHit: true; telemetry?: Cm93CacheTelemetry; timings?: Cm93CacheTimings }
  | { cacheHit: false; telemetry?: Cm93CacheTelemetry; timings?: Cm93CacheTimings }
  | null
> {
  const activeWorker = getWorker();
  if (!activeWorker) return null;

  try {
    const lookupStartedAt = performance.now();
    const lookup = await sendRequest(activeWorker, { type: 'lookup', key }) as
      | { value: T; serializedPayload?: ArrayBuffer; payloadEncoding?: 'gzip' | 'json'; cacheHit: true; telemetry?: Cm93CacheTelemetry; timings?: Cm93CacheTimings }
      | { cacheHit: false; telemetry?: Cm93CacheTelemetry; timings?: Cm93CacheTimings };
    const workerRoundTripMs = performance.now() - lookupStartedAt;
    const workerProcessingMs = lookup.timings?.workerProcessingMs;
    const baseTimings = { ...lookup.timings, workerRoundTripMs, workerOverheadMs: workerProcessingMs === undefined ? undefined : Math.max(0, workerRoundTripMs - workerProcessingMs) };
    if (lookup.cacheHit && lookup.serializedPayload instanceof ArrayBuffer) {
      const payload = lookup.serializedPayload;
      const decompressStartedAt = performance.now();
      let serializedPayload = payload;
      let decompressMs = 0;
      try {
        if (lookup.payloadEncoding === 'gzip') {
          if (typeof DecompressionStream === 'undefined') throw new Error('Gzip decompression is unavailable.');
          const stream = new Blob([payload]).stream().pipeThrough(new DecompressionStream('gzip'));
          serializedPayload = await new Response(stream).arrayBuffer();
          decompressMs = performance.now() - decompressStartedAt;
        }
        const deserializeStartedAt = performance.now();
        const value = JSON.parse(new TextDecoder().decode(serializedPayload)) as T;
        return {
          cacheHit: true,
          value,
          telemetry: lookup.telemetry,
          timings: {
            ...baseTimings,
            serializedPayloadBytes: serializedPayload.byteLength,
            compressedPayloadBytes: payload.byteLength,
            decompressMs,
            deserializeMs: performance.now() - deserializeStartedAt,
            cacheCompression: lookup.payloadEncoding === 'gzip' ? 'gzip' : 'none',
            cacheTransferMode: 'arraybuffer-transfer',
          },
        };
      } catch {
        // Treat an unreadable serialized entry as a cache miss so the caller
        // can rebuild it through the established decode/build path.
        return { cacheHit: false, telemetry: lookup.telemetry, timings: { ...baseTimings, compressedPayloadBytes: payload.byteLength, cacheCompression: lookup.payloadEncoding === 'gzip' ? 'gzip' : 'none', cacheTransferMode: 'arraybuffer-transfer' } };
      }
    }
    return {
      ...lookup,
      timings: { ...baseTimings, cacheTransferMode: lookup.cacheHit ? 'structured-clone' : undefined },
    };
  } catch {
    // Worker/cache failures fall back to the original CPU processing path.
    return null;
  }
}

export async function buildCm93CachedQuilt<T>(
  key: string,
  features: GeoJSON.Feature[],
  scale: Cm93ScaleCode,
  engine: Cm93PolygonClippingEngine,
): Promise<{ value: T; cacheHit: false; telemetry?: Cm93CacheTelemetry; timings?: Cm93CacheTimings } | null> {
  const activeWorker = getWorker();
  if (!activeWorker) return null;

  try {
    // Called only after a cache miss, so decoded features are transferred once
    // and expensive quilt geometry remains off the UI thread.
    const buildStartedAt = performance.now();
    const built = await sendRequest(activeWorker, { type: 'build', key, features, scale, engine }) as
      { value: T; cacheHit: false; telemetry?: Cm93CacheTelemetry; timings?: Cm93CacheTimings };
    return { ...built, timings: { ...built.timings, workerRoundTripMs: performance.now() - buildStartedAt } };
  } catch {
    return null;
  }
}

export async function getOrBuildCm93CachedQuilt<T>(
  key: string,
  features: GeoJSON.Feature[],
  scale: Cm93ScaleCode,
  engine: Cm93PolygonClippingEngine,
): Promise<{ value: T; cacheHit: boolean; telemetry?: Cm93CacheTelemetry; timings?: Cm93CacheTimings } | null> {
  const lookup = await lookupCm93CachedQuilt<T>(key);
  if (!lookup) return null;
  if (lookup.cacheHit) return { value: lookup.value as T, cacheHit: true, telemetry: lookup.telemetry, timings: lookup.timings };
  const built = await buildCm93CachedQuilt<T>(key, features, scale, engine);
  return built ? { ...built, timings: { ...lookup.timings, ...built.timings } } : null;
}

export function cm93QuiltCacheKey(scale: string, clippingEngine: string, files: File[]): string {
  const identity = files.map((file) => [
    (file.webkitRelativePath || file.name).toLowerCase(),
    file.size,
    file.lastModified,
  ].join(':')).sort().join('|');
  // Bump this version whenever CM93 quilt geometry semantics change.
  return 'cm93-quilt-v2:' + scale + ':' + clippingEngine + ':' + identity;
}
