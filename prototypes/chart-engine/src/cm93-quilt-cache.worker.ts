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
const DB_VERSION = 5;
const STORE_NAME = 'quilt-results';
const ACCESS_STORE_NAME = 'quilt-access';
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

type CacheTimings = { indexedDbReadMs?: number; workerProcessingMs?: number; telemetryMs?: number; geometryBuildMs?: number; persistMs?: number; serializedPayloadBytes?: number; serializeMs?: number };

const counters = { hits: 0, misses: 0, readErrors: 0, writes: 0, writeErrors: 0, evictions: 0, skippedOversized: 0 };
let lastTelemetry: CacheTelemetry | null = null;

async function getTelemetry(): Promise<CacheTelemetry> {
  const database = await openDatabase();
  try {
    const inventory = await new Promise<{ entries: number; estimatedBytes: number }>((resolve, reject) => {
      const transaction = database.transaction([STORE_NAME, ACCESS_STORE_NAME], 'readonly');
      const cursorRequest = transaction.objectStore(STORE_NAME).index('sizeBytes').openKeyCursor();
      const accessRequest = transaction.objectStore(ACCESS_STORE_NAME).getAll() as IDBRequest<Array<{ key: string; sizeBytes?: number }>>;
      let entries = 0;
      let estimatedBytes = 0;
      let cursorDone = false;
      let accessDone = false;
      const finishIfReady = () => {
        if (cursorDone && accessDone) resolve({ entries, estimatedBytes });
      };
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) {
          cursorDone = true;
          finishIfReady();
          return;
        }
        const sizeBytes = Number(cursor.key);
        if (Number.isFinite(sizeBytes) && sizeBytes > 0) {
          entries++;
          estimatedBytes += sizeBytes;
        }
        cursor.continue();
      };
      accessRequest.onsuccess = () => {
        accessDone = true;
        finishIfReady();
      };
      cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error('Could not inspect CM93 cache sizes.'));
      accessRequest.onerror = () => reject(accessRequest.error ?? new Error('Could not inspect CM93 access metadata.'));
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not inspect CM93 cache statistics.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('CM93 cache statistics transaction was aborted.'));
    });
    lastTelemetry = {
      ...counters,
      entries: inventory.entries,
      estimatedBytes: inventory.estimatedBytes,
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
      if (!database.objectStoreNames.contains(ACCESS_STORE_NAME)) {
        database.createObjectStore(ACCESS_STORE_NAME, { keyPath: 'key' });
      }
      // A key cursor over this index exposes each entry's byte size without
      // cloning its multi-megabyte GeoJSON payload into the worker.
      const quiltStore = transaction?.objectStore(STORE_NAME);
      if (quiltStore && !quiltStore.indexNames.contains('sizeBytes')) {
        quiltStore.createIndex('sizeBytes', 'sizeBytes', { unique: false });
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
    let cachedSizeBytes = 0;
    const value = await new Promise<unknown | null>((resolve, reject) => {
      // Cache entries contain large GeoJSON payloads. Keep the payload store
      // read-only on hits; writing the entry back just to update its access
      // timestamp causes another structured clone and a large IndexedDB write.
      const transaction = database.transaction(STORE_NAME, 'readonly');
      const request = transaction.objectStore(STORE_NAME).get(key) as IDBRequest<CacheEntry | undefined>;
      let cachedValue: unknown | null = null;
      request.onsuccess = () => { cachedValue = request.result?.value ?? null; cachedSizeBytes = request.result?.sizeBytes ?? 0; };
      transaction.oncomplete = () => resolve(cachedValue);
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not read the CM93 browser cache.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('CM93 cache read was aborted.'));
    });

    if (value !== null) {
      // Keep LRU and size metadata separately so hits never rewrite the payload.
      const accessTransaction = database.transaction(ACCESS_STORE_NAME, 'readwrite');
      accessTransaction.objectStore(ACCESS_STORE_NAME).put({ key, lastAccessedAt: Date.now(), sizeBytes: cachedSizeBytes });
      accessTransaction.onerror = () => { /* Access metadata is diagnostic/eviction metadata only. */ };
    }
    return value;
  } finally {
    database.close();
  }
}

async function writeEntry(key: string, value: unknown): Promise<{ written: boolean; serializedPayloadBytes: number; serializeMs: number }> {
  // Persist a compact byte payload so cache hits can transfer ownership of the
  // buffer to the UI thread instead of structured-cloning thousands of objects.
  const serializeStartedAt = performance.now();
  const serialized = new TextEncoder().encode(JSON.stringify(value) ?? 'null');
  const serializeMs = performance.now() - serializeStartedAt;
  const serializedBuffer = serialized.buffer.slice(
    serialized.byteOffset,
    serialized.byteOffset + serialized.byteLength,
  ) as ArrayBuffer;
  const sizeBytes = serializedBuffer.byteLength;
  if (sizeBytes > CACHE_BUDGET_BYTES) { counters.skippedOversized++; return { written: false, serializedPayloadBytes: sizeBytes, serializeMs }; }
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction([STORE_NAME, ACCESS_STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const now = Date.now();
      store.put({ key, value: serializedBuffer, savedAt: now, lastAccessedAt: now, sizeBytes } satisfies CacheEntry);
      const accessStore = transaction.objectStore(ACCESS_STORE_NAME);
      accessStore.put({ key, lastAccessedAt: now });
      const entriesRequest = store.getAll() as IDBRequest<CacheEntry[]>;
      const accessRequest = accessStore.getAll() as IDBRequest<Array<{ key: string; lastAccessedAt: number }>>;
      let entries: CacheEntry[] | null = null;
      let accessEntries: Array<{ key: string; lastAccessedAt: number }> | null = null;
      const evictIfReady = () => {
        if (!entries || !accessEntries) return;
        const lastAccessedByKey = new Map(accessEntries.map((entry) => [entry.key, entry.lastAccessedAt]));
        let totalBytes = entries.reduce((total, entry) =>
          total + (typeof entry.sizeBytes === 'number' ? entry.sizeBytes : estimateSizeBytes(entry.value)), 0);
        const oldestFirst = entries
          .filter((entry) => entry.key !== key)
          .sort((a, b) =>
            (lastAccessedByKey.get(a.key) ?? a.lastAccessedAt ?? a.savedAt ?? 0) -
            (lastAccessedByKey.get(b.key) ?? b.lastAccessedAt ?? b.savedAt ?? 0));
        for (const entry of oldestFirst) {
          if (totalBytes <= CACHE_BUDGET_BYTES) break;
          store.delete(entry.key);
          accessStore.delete(entry.key);
          counters.evictions++;
          totalBytes -= typeof entry.sizeBytes === 'number' ? entry.sizeBytes : estimateSizeBytes(entry.value);
        }
      };
      entriesRequest.onsuccess = () => { entries = entriesRequest.result; evictIfReady(); };
      accessRequest.onsuccess = () => { accessEntries = accessRequest.result; evictIfReady(); };
      entriesRequest.onerror = () => reject(entriesRequest.error ?? new Error('Could not inspect CM93 cache size.'));
      accessRequest.onerror = () => reject(accessRequest.error ?? new Error('Could not inspect CM93 access metadata.'));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not persist the CM93 quilt cache.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('CM93 quilt cache write was aborted.'));
    });
    return { written: true, serializedPayloadBytes: sizeBytes, serializeMs };
  } finally {
    database.close();
  }
}

async function enforceCacheBudget(): Promise<boolean> {
  const database = await openDatabase();
  try {
    return await new Promise<boolean>((resolve, reject) => {
      const transaction = database.transaction([STORE_NAME, ACCESS_STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const accessStore = transaction.objectStore(ACCESS_STORE_NAME);
      const cursorRequest = store.index('sizeBytes').openKeyCursor();
      const accessRequest = accessStore.getAll() as IDBRequest<Array<{ key: string; lastAccessedAt?: number; sizeBytes?: number }>>;
      const entries: Array<{ key: string; sizeBytes: number }> = [];
      let accessEntries: Array<{ key: string; lastAccessedAt?: number; sizeBytes?: number }> | null = null;
      let cursorDone = false;
      let cleaned = false;
      let didEvict = false;
      const cleanIfReady = () => {
        if (!cursorDone || !accessEntries || cleaned) return;
        cleaned = true;
        const accessByKey = new Map(accessEntries.map((entry) => [entry.key, entry]));
        let totalBytes = entries.reduce((total, entry) => total + entry.sizeBytes, 0);
        const oldestFirst = entries.slice().sort((a, b) => {
          const aAccess = accessByKey.get(a.key)?.lastAccessedAt ?? 0;
          const bAccess = accessByKey.get(b.key)?.lastAccessedAt ?? 0;
          return aAccess - bAccess;
        });
        for (const entry of oldestFirst) {
          if (totalBytes <= CACHE_BUDGET_BYTES) break;
          store.delete(entry.key);
          accessStore.delete(entry.key);
          totalBytes -= entry.sizeBytes;
          counters.evictions++;
          didEvict = true;
        }
        // Access records created by earlier versions lack sizeBytes, but the
        // size index above still gives us accurate sizes for their payloads.
      };
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) {
          cursorDone = true;
          cleanIfReady();
          return;
        }
        const sizeBytes = Number(cursor.key);
        if (Number.isFinite(sizeBytes) && sizeBytes > 0) {
          entries.push({ key: String(cursor.primaryKey), sizeBytes });
        }
        cursor.continue();
      };
      accessRequest.onsuccess = () => {
        accessEntries = accessRequest.result;
        cleanIfReady();
      };
      cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error('Could not inspect CM93 cache sizes.'));
      accessRequest.onerror = () => reject(accessRequest.error ?? new Error('Could not inspect CM93 access metadata.'));
      transaction.oncomplete = () => resolve(didEvict);
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not enforce CM93 cache budget.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('CM93 cache budget transaction was aborted.'));
    });
  } finally {
    database.close();
  }
}

async function lookup(request: Extract<RequestMessage, { type: 'lookup' }>) {
  const workerStartedAt = performance.now();
  const readStartedAt = performance.now();
  let cached: unknown | null = null;
  try {
    cached = await readEntry(request.key);
  } catch {
    counters.readErrors++;
  }
  const indexedDbReadMs = performance.now() - readStartedAt;
  if (cached) {
    counters.hits++;
    // Do not block a cache hit on telemetry or budget maintenance. The inventory
    // uses key-only cursors and lightweight access metadata, not GeoJSON payloads.
    // Only open a write transaction when the last metadata-only inventory says
    // the budget is exceeded. The first inventory is also metadata-only and runs
    // in the background, so a cache hit never waits for maintenance.
    const refreshTelemetry = () => {
      void getTelemetry().then((telemetry) => {
        if (telemetry.estimatedBytes > CACHE_BUDGET_BYTES) {
          return enforceCacheBudget().then((didEvict) => didEvict ? getTelemetry() : telemetry);
        }
        return telemetry;
      }).then((telemetry) => {
        workerScope.postMessage({ type: 'telemetry', telemetry });
      }).catch(() => { /* Budget maintenance and statistics must not break rendering. */ });
    };
    if (lastTelemetry && lastTelemetry.estimatedBytes > CACHE_BUDGET_BYTES) {
      void enforceCacheBudget().then((didEvict) => didEvict ? getTelemetry() : null).then((telemetry) => {
        if (telemetry) workerScope.postMessage({ type: 'telemetry', telemetry });
      }).catch(() => { /* Budget maintenance and statistics must not break rendering. */ });
    } else if (!lastTelemetry) {
      refreshTelemetry();
    }
    const payload = cached instanceof ArrayBuffer
      ? { serializedPayload: cached }
      : { value: cached }; // Compatibility with entries created before the byte-payload format.
    return { cacheHit: true, ...payload, timings: { indexedDbReadMs, workerProcessingMs: performance.now() - workerStartedAt }, telemetry: lastTelemetry ? { ...lastTelemetry, ...counters } : undefined };
  }

  counters.misses++;
  return { cacheHit: false, timings: { indexedDbReadMs, workerProcessingMs: performance.now() - workerStartedAt } };
}

async function build(request: Extract<RequestMessage, { type: 'build' }>) {
  const buildStartedAt = performance.now();
  const value = buildCm93CoverageQuiltFeatures(request.features, request.scale, request.engine);
  const geometryBuildMs = performance.now() - buildStartedAt;
  const persistStartedAt = performance.now();
  let serializedPayloadBytes: number | undefined;
  let serializeMs: number | undefined;
  try {
    const writeResult = await writeEntry(request.key, value);
    if (writeResult.written) counters.writes++;
    serializedPayloadBytes = writeResult.serializedPayloadBytes;
    serializeMs = writeResult.serializeMs;
  } catch {
    counters.writeErrors++;
  }
  const persistMs = performance.now() - persistStartedAt;
  let telemetry: CacheTelemetry | undefined;
  const telemetryStartedAt = performance.now();
  try { telemetry = await getTelemetry(); } catch { /* Stats are diagnostic only. */ }
  return { value, cacheHit: false, telemetry, timings: { geometryBuildMs, persistMs, telemetryMs: performance.now() - telemetryStartedAt, serializedPayloadBytes, serializeMs } };
}

const workerScope = self as unknown as {
  addEventListener(type: string, listener: (event: MessageEvent<RequestMessage>) => void): void;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

workerScope.addEventListener('message', (event: MessageEvent<RequestMessage>) => {
  const request = event.data;
  const reply = (ok: boolean, value?: unknown, error?: string) => {
    const serializedPayload = value && typeof value === 'object'
      ? (value as { serializedPayload?: unknown }).serializedPayload
      : undefined;
    const transfer = serializedPayload instanceof ArrayBuffer ? [serializedPayload] : [];
    workerScope.postMessage({ id: request.id, ok, value, error }, transfer);
  };
  const operation = request.type === 'lookup'
    ? lookup(request).then((value) => reply(true, value))
    : request.type === 'build'
      ? build(request).then((value) => reply(true, value))
      : openDatabase().then(async (database) => {
        try {
          await new Promise<void>((resolve, reject) => {
            const transaction = database.transaction(STORE_NAME, 'readwrite');
            transaction.objectStore(STORE_NAME).clear();
            transaction.objectStore(ACCESS_STORE_NAME).clear();
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
