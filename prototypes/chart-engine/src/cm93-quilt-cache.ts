import type { Cm93PolygonClippingEngine } from './cm93-quilt-geometry.ts';
import type { Cm93ScaleCode } from './cm93-quilt.ts';

export type Cm93CacheTimings = { indexedDbReadMs?: number; workerRoundTripMs?: number; telemetryMs?: number; geometryBuildMs?: number; persistMs?: number };

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

export async function getOrBuildCm93CachedQuilt<T>(
  key: string,
  features: GeoJSON.Feature[],
  scale: Cm93ScaleCode,
  engine: Cm93PolygonClippingEngine,
): Promise<{ value: T; cacheHit: boolean; telemetry?: Cm93CacheTelemetry; timings?: Cm93CacheTimings } | null> {
  const activeWorker = getWorker();
  if (!activeWorker) return null;

  try {
    const lookupStartedAt = performance.now();
    const lookup = await sendRequest(activeWorker, { type: 'lookup', key }) as
      | { value: T; cacheHit: true; telemetry?: Cm93CacheTelemetry; timings?: Cm93CacheTimings }
      | { cacheHit: false; telemetry?: Cm93CacheTelemetry; timings?: Cm93CacheTimings };
    const lookupTimings = { ...lookup.timings, workerRoundTripMs: performance.now() - lookupStartedAt };
    if (lookup.cacheHit) return { ...lookup, timings: lookupTimings } as { value: T; cacheHit: boolean; telemetry?: Cm93CacheTelemetry; timings?: Cm93CacheTimings };

    // Only cold/missing entries transfer decoded features to the worker.
    // This avoids structured-cloning thousands of GeoJSON features on every hit.
    const buildStartedAt = performance.now();
    const built = await sendRequest(activeWorker, { type: 'build', key, features, scale, engine }) as
      { value: T; cacheHit: boolean; telemetry?: Cm93CacheTelemetry; timings?: Cm93CacheTimings };
    return { ...built, timings: { ...built.timings, workerRoundTripMs: performance.now() - buildStartedAt } };
  } catch {
    // Worker/cache failures fall back to the original CPU processing path.
    return null;
  }
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
