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

function request(type: 'get', key: string): Promise<unknown | null>;
function request(type: 'set', key: string, value: unknown): Promise<unknown>;
function request(type: 'get' | 'set', key: string, value?: unknown): Promise<unknown> {
  const activeWorker = getWorker();
  if (!activeWorker) return Promise.resolve(type === 'get' ? null : undefined);
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    activeWorker.postMessage({ id, type, key, value });
  });
}

export async function getCm93CachedQuilt<T>(key: string): Promise<T | null> {
  try {
    return await request('get', key) as T | null;
  } catch {
    // The cache is an optimization only; quota or browser storage failures
    // must never prevent the chart from being rendered.
    return null;
  }
}

export async function setCm93CachedQuilt(key: string, value: unknown): Promise<void> {
  try {
    await request('set', key, value);
  } catch {
    // IndexedDB may be unavailable or full. Rendering remains unaffected.
  }
}

export function cm93QuiltCacheKey(
  scale: string,
  clippingEngine: string,
  files: File[],
): string {
  const identity = files
    .map((file) => [
      (file.webkitRelativePath || file.name).toLowerCase(),
      file.size,
      file.lastModified,
    ].join(':'))
    .sort()
    .join('|');
  // The version is deliberately part of the key so changes to the geometry
  // pipeline can invalidate old cached results without clearing browser data.
  return 'cm93-quilt-v1:' + scale + ':' + clippingEngine + ':' + identity;
}
