// IndexedDB store for cropped payee-strip blobs (ES module).
// Keeps binary out of chrome.storage; keyed by checkNumber.
const DB = 'allychecks';
const STORE = 'strips';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

export async function putStrip(checkNumber, blob) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const r = tx(db, 'readwrite').put(blob, String(checkNumber));
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

export async function getStrip(checkNumber) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const r = tx(db, 'readonly').get(String(checkNumber));
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  });
}

// All strips as { checkNumber: Blob } — used by backup export.
export async function allStrips() {
  const db = await open();
  return new Promise((resolve, reject) => {
    const store = tx(db, 'readonly');
    const out = {};
    const r = store.openCursor();
    r.onsuccess = () => {
      const cur = r.result;
      if (!cur) return resolve(out);
      out[cur.key] = cur.value;
      cur.continue();
    };
    r.onerror = () => reject(r.error);
  });
}

export async function clearStrips() {
  const db = await open();
  return new Promise((resolve, reject) => {
    const r = tx(db, 'readwrite').clear();
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}
