import { buildCm93CoverageQuiltFeatures, type Cm93PolygonClippingEngine } from './cm93-quilt-geometry.ts';
import type { Cm93ScaleCode } from './cm93-quilt.ts';

type CacheEntry = { key: string; value: unknown; savedAt: number };
type RequestMessage =
  | { id: number; type: 'build'; key: string; features: GeoJSON.Feature[]; scale: Cm93ScaleCode; engine: Cm93PolygonClippingEngine }
  | { id: number; type: 'clear' };

const DB_NAME = 'azimute-one-cm93-cache';
const DB_VERSION = 1;
const STORE_NAME = 'quilt-results';
const MAX_ENTRIES = 4;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open the CM93 browser cache.'));
  });
}

async function readEntry(key: string): Promise<unknown | null> {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readonly');
      const request = transaction.objectStore(STORE_NAME).get(key) as IDBRequest<CacheEntry | undefined>;
      request.onsuccess = () => resolve(request.result?.value ?? null);
      request.onerror = () => reject(request.error);
    });
  } finally {
    database.close();
  }
}

async function writeEntry(key: string, value: unknown): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put({ key, value, savedAt: Date.now() } satisfies CacheEntry);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not persist the CM93 quilt cache.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('CM93 quilt cache write was aborted.'));
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAll() as IDBRequest<CacheEntry[]>;
      request.onsuccess = () => {
        const entries = request.result.sort((a, b) => b.savedAt - a.savedAt);
        for (const entry of entries.slice(MAX_ENTRIES)) store.delete(entry.key);
      };
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

async function buildOrRead(request: Extract<RequestMessage, { type: 'build' }>) {
  try {
    const cached = await readEntry(request.key);
    if (cached) return { value: cached, cacheHit: true };
  } catch {
    // A failed cache read falls back to building the quilt in this worker.
  }

  const value = buildCm93CoverageQuiltFeatures(request.features, request.scale, request.engine);
  try {
    await writeEntry(request.key, value);
  } catch {
    // Quota/storage failures must not prevent chart rendering.
  }
  return { value, cacheHit: false };
}

self.addEventListener('message', (event: MessageEvent<RequestMessage>) => {
  const request = event.data;
  const reply = (ok: boolean, value?: unknown, error?: string) => self.postMessage({ id: request.id, ok, value, error });
  const operation = request.type === 'build'
    ? buildOrRead(request).then((value) => reply(true, value))
    : openDatabase().then(async (database) => {
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = database.transaction(STORE_NAME, 'readwrite');
          transaction.objectStore(STORE_NAME).clear();
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
        });
        reply(true);
      } finally {
        database.close();
      }
    });
  void operation.catch((error: unknown) => reply(false, undefined, error instanceof Error ? error.message : String(error)));
});
