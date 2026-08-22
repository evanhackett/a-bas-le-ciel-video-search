// A local copy of the parsed archive, keyed by the videos.json content hash.
//
// Why this exists: GitHub Pages serves videos.json with `cache-control:
// max-age=600` and an ETag built from the file's mtime and size. Pages
// re-checks-out the whole repo on every deploy, so editing any file -- a line
// of help.html -- resets that mtime and invalidates the validator for a 55 MB
// file that did not change. Returning visitors then re-download the whole
// archive. Keying on the content hash instead means a download happens only
// when the dataset genuinely changed.
//
// Everything here is best-effort. IndexedDB is missing in some private windows,
// disabled by some privacy settings, and will refuse a 55 MB write against a
// tight quota. Every failure resolves to "not cached" rather than throwing, and
// main.js treats that as a plain cache miss and goes to the network.

const DB_NAME = 'abas-archive';
const STORE = 'datasets';

/** Wrap an IDBRequest as a promise. Callers add their own try/catch. */
function promisifyRequest(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function openDb() {
    if (typeof indexedDB === 'undefined') {
        throw new Error('IndexedDB unavailable');
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
        // Out-of-line keys: the value is the raw archive array, and it carries
        // no field we would want to key on.
        request.result.createObjectStore(STORE);
    };
    return promisifyRequest(request);
}

/**
 * The archive stored under `version`, or null if this build is not cached.
 *
 * A miss and a failure are deliberately the same answer. The caller's next move
 * is identical either way, and distinguishing them would only invite a code
 * path that treats a broken database as fatal.
 */
export async function idbGet(version) {
    try {
        const db = await openDb();
        try {
            const store = db.transaction(STORE, 'readonly').objectStore(STORE);
            return (await promisifyRequest(store.get(version))) ?? null;
        } finally {
            db.close();
        }
    } catch (error) {
        console.warn('archive cache: read failed, falling back to network', error);
        return null;
    }
}

/**
 * Store the archive under `version`, dropping every other key.
 *
 * The old keys are dead the moment a new dataset ships -- nothing will ask for
 * them again -- and each one is another ~55 MB held against the origin's quota,
 * so leaving them would make the next write the one that fails.
 *
 * Resolves either way. The page has already rendered from the network response
 * by the time this runs, so a failed write costs nothing today; it only means
 * the next visit pays for the download again.
 */
export async function idbPut(version, videos) {
    try {
        const db = await openDb();
        try {
            await new Promise((resolve, reject) => {
                const tx = db.transaction(STORE, 'readwrite');
                const store = tx.objectStore(STORE);

                store.put(videos, version);

                // Issued inside the same transaction so the eviction cannot be
                // interleaved with another tab's write, and so a quota failure
                // on the put rolls the deletes back with it.
                const keys = store.getAllKeys();
                keys.onsuccess = () => {
                    for (const key of keys.result) {
                        if (key !== version) store.delete(key);
                    }
                };

                tx.oncomplete = resolve;
                // QuotaExceededError surfaces here rather than on the put call:
                // the write is only attempted when the transaction commits.
                tx.onerror = () => reject(tx.error);
                tx.onabort = () => reject(tx.error);
            });
        } finally {
            db.close();
        }
    } catch (error) {
        console.warn('archive cache: write failed, the next visit will re-download', error);
    }
}

/**
 * Forget everything cached. Not called by the page -- it is here for the
 * console, when a developer wants to watch a cold load without clearing the
 * whole origin's storage from devtools.
 */
export async function idbClear() {
    try {
        const db = await openDb();
        try {
            await new Promise((resolve, reject) => {
                const tx = db.transaction(STORE, 'readwrite');
                tx.objectStore(STORE).clear();
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
                tx.onabort = () => reject(tx.error);
            });
        } finally {
            db.close();
        }
    } catch (error) {
        console.warn('archive cache: clear failed', error);
    }
}
