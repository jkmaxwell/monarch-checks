// IndexedDB stores for check images (ES module). Keeps binary out of
// chrome.storage; both stores keyed by checkNumber.
//   strips — the cropped payee strip (PNG), sent to the vision API for extraction
//   fulls  — the full front-check image (JPEG), kept LOCAL for manual review when
//            a crop misses; never sent off-device.
const DB = 'allychecks';
const STORE = 'strips';
const FULLS = 'fulls';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains(FULLS)) db.createObjectStore(FULLS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode, store = STORE) {
  return db.transaction(store, mode).objectStore(store);
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

// --- full front-check images (local-only recovery for bad crops) ---
export async function putFull(checkNumber, blob) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const r = tx(db, 'readwrite', FULLS).put(blob, String(checkNumber));
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

export async function getFull(checkNumber) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const r = tx(db, 'readonly', FULLS).get(String(checkNumber));
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  });
}

// All full images as { checkNumber: Blob } — used by backup export.
export async function allFulls() {
  const db = await open();
  return new Promise((resolve, reject) => {
    const store = tx(db, 'readonly', FULLS);
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

export async function clearFulls() {
  const db = await open();
  return new Promise((resolve, reject) => {
    const r = tx(db, 'readwrite', FULLS).clear();
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}
