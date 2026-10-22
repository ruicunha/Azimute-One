import { buildCm93CoverageQuiltFeatures, type Cm93PolygonClippingEngine } from './cm93-quilt-geometry.ts';
import type { Cm93ScaleCode } from './cm93-quilt.ts';

type CacheEntry = {
  key: string;
  value: unknown;
  savedAt: number;
  lastAccessedAt: number;
  sizeBytes: number;
};
type RequestMessage =
  | { id: number; type: 'lookup'; key: string }
  | { id: number; type: 'build'; key: string; features: GeoJSON.Feature[]; scale: Cm93ScaleCode; engine: Cm93PolygonClippingEngine }
  | { id: number; type: 'clear' };

const DB_NAME = 'azimute-one-cm93-cache';
const DB_VERSION = 2;
const STORE_NAME = 'quilt-results';
const CACHE_BUDGET_BYTES = 250 * 1024 * 1024;

type CacheTelemetry = {
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

const counters = { hits: 0, misses: 0, readErrors: 0, writes: 0, writeErrors: 0, evictions: 0, skippedOversized: 0 };
let lastTelemetry: CacheTelemetry | null = null;

async function getTelemetry(): Promise<CacheTelemetry> {
  const database = await openDatabase();
  try {
    const entries = await new Promise<CacheEntry[]>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readonly');
      const request = transaction.objectStore(STORE_NAME).getAll() as IDBRequest<CacheEntry[]>;
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Could not inspect CM93 cache statistics.'));
    });
    lastTelemetry = {
      ...counters,
      entries: entries.length,
      estimatedBytes: entries.reduce((total, entry) =>
        total + (typeof entry.sizeBytes === 'number' ? entry.sizeBytes : estimateSizeBytes(entry.value)), 0),
      budgetBytes: CACHE_BUDGET_BYTES,
    };
    return lastTelemetry;
  } finally {
    database.close();
  }
}

function estimateSizeBytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  return new TextEncoder().encode(serialized ?? 'null').byteLength;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const database = request.result;
      const transaction = request.transaction;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
      if ((event as IDBVersionChangeEvent).oldVersion < 2 && transaction) {
        const store = transaction.objectStore(STORE_NAME);
        const cursorRequest = store.openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          const entry = cursor.value as Partial<CacheEntry> & { value: unknown; key: string };
          const savedAt = typeof entry.savedAt === 'number' ? entry.savedAt : 0;
          cursor.update({
            ...entry,
            savedAt,
            lastAccessedAt: typeof entry.lastAccessedAt === 'number' ? entry.lastAccessedAt : savedAt,
            sizeBytes: typeof entry.sizeBytes === 'number' ? entry.sizeBytes : estimateSizeBytes(entry.value),
          } satisfies CacheEntry);
          cursor.continue();
        };
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open the CM93 browser cache.'));
  });
}

async function readEntry(key: string): Promise<unknown | null> {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(key) as IDBRequest<CacheEntry | undefined>;
      let value: unknown | null = null;
      request.onsuccess = () => {
        const entry = request.result;
        if (!entry) return;
        value = entry.value ?? null;
        store.put({
          ...entry,
          sizeBytes: typeof entry.sizeBytes === 'number' ? entry.sizeBytes : estimateSizeBytes(entry.value),
          lastAccessedAt: Date.now(),
        } satisfies CacheEntry);
      };
      transaction.oncomplete = () => resolve(value);
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not read the CM93 browser cache.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('CM93 cache read was aborted.'));
    });
  } finally {
    database.close();
  }
}

async function writeEntry(key: string, value: unknown): Promise<boolean> {
  const sizeBytes = estimateSizeBytes(value);
  if (sizeBytes > CACHE_BUDGET_BYTES) { counters.skippedOversized++; return false; }
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const now = Date.now();
      store.put({ key, value, savedAt: now, lastAccessedAt: now, sizeBytes } satisfies CacheEntry);
      const entriesRequest = store.getAll() as IDBRequest<CacheEntry[]>;
      entriesRequest.onsuccess = () => {
        const entries = entriesRequest.result;
        let totalBytes = entries.reduce((total, entry) =>
          total + (typeof entry.sizeBytes === 'number' ? entry.sizeBytes : estimateSizeBytes(entry.value)), 0);
        const oldestFirst = entries
          .filter((entry) => entry.key !== key)
          .sort((a, b) => (a.lastAccessedAt ?? a.savedAt ?? 0) - (b.lastAccessedAt ?? b.savedAt ?? 0));
        for (const entry of oldestFirst) {
          if (totalBytes <= CACHE_BUDGET_BYTES) break;
          store.delete(entry.key);
          counters.evictions++;
          totalBytes -= typeof entry.sizeBytes === 'number' ? entry.sizeBytes : estimateSizeBytes(entry.value);
        }
      };
      entriesRequest.onerror = () => reject(entriesRequest.error ?? new Error('Could not inspect CM93 cache size.'));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not persist the CM93 quilt cache.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('CM93 quilt cache write was aborted.'));
    });
    return true;
  } finally {
    database.close();
  }
}

async function lookup(request: Extract<RequestMessage, { type: 'lookup' }>) {
  let cached: unknown | null = null;
  try {
    cached = await readEntry(request.key);
  } catch {
    counters.readErrors++;
  }
  if (cached) {
    counters.hits++;
    // This first-hit telemetry snapshot still scans the persistent store.
    // Avoid doing that on the hot path; diagnostics can be refreshed after a
    // cold build/write instead. We return known counters if no snapshot exists.
    if (!lastTelemetry) {
      return { cacheHit: true, value: cached, telemetry: undefined };
    }
    return { cacheHit: true, value: cached, telemetry: { ...lastTelemetry, ...counters } };
  }

  counters.misses++;
  return { cacheHit: false };
}

async function build(request: Extract<RequestMessage, { type: 'build' }>) {
  const value = buildCm93CoverageQuiltFeatures(request.features, request.scale, request.engine);
  try {
    if (await writeEntry(request.key, value)) counters.writes++;
  } catch {
    counters.writeErrors++;
  }
  let telemetry: CacheTelemetry | undefined;
  try { telemetry = await getTelemetry(); } catch { /* Stats are diagnostic only. */ }
  return { value, cacheHit: false, telemetry };
}

const workerScope = self as unknown as {
  addEventListener(type: string, listener: (event: MessageEvent<RequestMessage>) => void): void;
  postMessage(message: unknown): void;
};

workerScope.addEventListener('message', (event: MessageEvent<RequestMessage>) => {
  const request = event.data;
  const reply = (ok: boolean, value?: unknown, error?: string) => workerScope.postMessage({ id: request.id, ok, value, error });
  const operation = request.type === 'lookup'
    ? lookup(request).then((value) => reply(true, value))
    : request.type === 'build'
      ? build(request).then((value) => reply(true, value))
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
