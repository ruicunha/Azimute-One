type CacheEntry = {
  key: string;
  value: unknown;
  savedAt: number;
};

type RequestMessage =
  | { id: number; type: 'get'; key: string }
  | { id: number; type: 'set'; key: string; value: unknown }
  | { id: number; type: 'clear' };

const DB_NAME = 'azimute-one-cm93-cache';
const DB_VERSION = 1;
const STORE_NAME = 'quilt-results';
const MAX_ENTRIES = 8;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open the CM93 browser cache.'));
  });
}

async function readEntry(key: string): Promise<unknown | null> {
  const database = await openDatabase();
  try {
    const entry = await new Promise<CacheEntry | undefined>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(key) as IDBRequest<CacheEntry | undefined>;
      request.onsuccess = () => {
        const value = request.result;
        if (value) store.put({ ...value, savedAt: Date.now() });
        resolve(value);
      };
      request.onerror = () => reject(request.error);
    });
    return entry?.value ?? null;
  } finally {
    database.close();
  }
}

async function writeEntry(key: string, value: unknown): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      store.put({ key, value, savedAt: Date.now() } satisfies CacheEntry);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not persist the CM93 quilt cache.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('CM93 quilt cache write was aborted.'));
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAllKeys();
      request.onsuccess = () => {
        const keys = request.result as string[];
        const entriesRequest = store.getAll() as IDBRequest<CacheEntry[]>;
        entriesRequest.onsuccess = () => {
          const entries = entriesRequest.result.sort((a, b) => b.savedAt - a.savedAt);
          for (const entry of entries.slice(MAX_ENTRIES)) store.delete(entry.key);
          resolve();
        };
        entriesRequest.onerror = () => reject(entriesRequest.error);
      };
      request.onerror = () => reject(request.error);
    });
  } finally {
    database.close();
  }
}

self.addEventListener('message', (event: MessageEvent<RequestMessage>) => {
  const request = event.data;
  const reply = (ok: boolean, value?: unknown, error?: string) => {
    self.postMessage({ id: request.id, ok, value, error });
  };
  const operation = request.type === 'get'
    ? readEntry(request.key).then((value) => reply(true, value))
    : request.type === 'set'
      ? writeEntry(request.key, request.value).then(() => reply(true))
      : Promise.resolve().then(async () => {
        const database = await openDatabase();
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
