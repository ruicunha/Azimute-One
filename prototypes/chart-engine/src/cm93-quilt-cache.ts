import type { Cm93PolygonClippingEngine } from './cm93-quilt-geometry.ts';
import type { Cm93ScaleCode } from './cm93-quilt.ts';

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

type WorkerReply = { id: number; ok: boolean; value?: unknown; error?: string };
type PendingRequest = { resolve: (value: unknown) => void; reject: (error: Error) => void };
let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, PendingRequest>();

function getWorker(): Worker | null {
  if (typeof Worker === 'undefined' || typeof indexedDB === 'undefined') return null;
  if (!worker) {
    try {
      worker = new Worker(new URL('./cm93-quilt-cache.worker.ts', import.meta.url), { type: 'module' });
      worker.addEventListener('message', (event: MessageEvent<WorkerReply>) => {
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

function buildRequest(
  key: string,
  features: GeoJSON.Feature[],
  scale: Cm93ScaleCode,
  engine: Cm93PolygonClippingEngine,
): Promise<unknown> {
  const activeWorker = getWorker();
  if (!activeWorker) {
    // The worker is optional. Returning null signals the caller to use the
    // existing synchronous CPU path when Web Workers or IndexedDB are absent.
    return Promise.resolve(null);
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    activeWorker.postMessage({ id, type: 'build', key, features, scale, engine });
  });
}

export async function getOrBuildCm93CachedQuilt<T>(
  key: string,
  features: GeoJSON.Feature[],
  scale: Cm93ScaleCode,
  engine: Cm93PolygonClippingEngine,
): Promise<{ value: T; cacheHit: boolean; telemetry?: Cm93CacheTelemetry } | null> {
  try {
    return await buildRequest(key, features, scale, engine) as { value: T; cacheHit: boolean } | null;
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
