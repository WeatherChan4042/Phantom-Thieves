// Demo storage in the browser's IndexedDB. Entries are documents (with the original file)
// or notes: { id, type, title, category, createdAt, mime, size, fileBlob, ocrText }.
const DB_NAME = "linaw";
const STORE_NAME = "entries";
let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        dbPromise = null;
        reject(request.error);
      };
    });
  }
  return dbPromise;
}

// Run one request inside a transaction and resolve with its result.
async function runRequest(mode, action) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode);
    const request = action(transaction.objectStore(STORE_NAME));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

const store = {
  add: entry => runRequest("readwrite", s => s.add({ ...entry, createdAt: Date.now() })),
  update: entry => runRequest("readwrite", s => s.put(entry)),
  get: id => runRequest("readonly", s => s.get(id)),
  remove: id => runRequest("readwrite", s => s.delete(id)),
  count: () => runRequest("readonly", s => s.count()),
  // Newest first.
  async all() {
    const entries = await runRequest("readonly", s => s.getAll());
    return entries.sort((a, b) => b.createdAt - a.createdAt);
  }
};
