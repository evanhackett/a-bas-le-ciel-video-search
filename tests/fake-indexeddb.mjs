// A minimal in-memory stand-in for IndexedDB, covering exactly the surface
// idb-cache.js uses: open/createObjectStore, and get/put/delete/getAllKeys/clear
// inside a transaction.
//
// Hand-rolled rather than pulled from npm because the project has one dev
// dependency and this is a hundred lines. The trade-off is real and worth
// naming: these tests check idb-cache.js against *this* model of IndexedDB, so
// they catch logic errors but not a misreading of the spec. The behaviours that
// the cache code actually leans on are modelled deliberately:
//
//   - callbacks fire asynchronously, never during the call that queued them
//   - a request issued from inside another request's onsuccess joins the same
//     transaction, and oncomplete waits for it (idbPut deletes stale keys from
//     inside getAllKeys' callback)
//   - a readwrite transaction stages its writes and only commits on completion,
//     so an abort rolls the whole thing back
//   - values are structured-cloned in and out, so a caller cannot mutate the
//     store by holding on to what it stored
//
// Anything outside that surface -- indexes, cursors, versionchange, key ranges
// -- is not implemented, because the cache does not use it.

/** Thrown on commit when `failWrites` is set, mimicking a full quota. */
class QuotaExceededError extends Error {
    constructor() {
        super('The quota has been exceeded.');
        this.name = 'QuotaExceededError';
    }
}

class FakeRequest {
    constructor() {
        this.result = undefined;
        this.error = null;
        this.onsuccess = null;
        this.onerror = null;
        this.onupgradeneeded = null;
    }
}

class FakeObjectStore {
    constructor(tx, data) {
        this._tx = tx;
        this._data = data;   // the staged Map for this transaction
    }

    get(key) {
        return this._tx._enqueue((request) => {
            const value = this._data.get(key);
            request.result = value === undefined ? undefined : structuredClone(value);
        });
    }

    getAllKeys() {
        return this._tx._enqueue((request) => {
            request.result = [...this._data.keys()];
        });
    }

    put(value, key) {
        this._tx._assertWritable();
        return this._tx._enqueue((request) => {
            this._data.set(key, structuredClone(value));
            request.result = key;
        });
    }

    delete(key) {
        this._tx._assertWritable();
        return this._tx._enqueue((request) => {
            this._data.delete(key);
            request.result = undefined;
        });
    }

    clear() {
        this._tx._assertWritable();
        return this._tx._enqueue((request) => {
            this._data.clear();
            request.result = undefined;
        });
    }
}

class FakeTransaction {
    constructor(db, storeName, mode) {
        this._db = db;
        this._storeName = storeName;
        this._mode = mode;
        this._queue = [];
        this._draining = false;
        this._settled = false;

        // Readwrite works on a copy and commits at the end, so an abort leaves
        // the store as it was.
        const live = db._stores.get(storeName);
        this._data = mode === 'readwrite' ? new Map(live) : live;

        this.error = null;
        this.oncomplete = null;
        this.onerror = null;
        this.onabort = null;

        // Nothing has been queued yet; a transaction with no requests still
        // completes, which is what a real one does.
        this._schedule();
    }

    objectStore(name) {
        if (name !== this._storeName) {
            throw new Error(`store ${name} is not in this transaction's scope`);
        }
        return new FakeObjectStore(this, this._data);
    }

    _assertWritable() {
        if (this._mode !== 'readwrite') {
            throw new Error('cannot write in a readonly transaction');
        }
    }

    _enqueue(work) {
        const request = new FakeRequest();
        this._queue.push(() => {
            work(request);
            request.onsuccess?.({ target: request });
        });
        this._schedule();
        return request;
    }

    _schedule() {
        if (this._draining || this._settled) return;
        this._draining = true;
        queueMicrotask(() => this._drain());
    }

    _drain() {
        if (this._settled) return;

        const job = this._queue.shift();
        if (job) {
            try {
                job();
            } catch (error) {
                this._abort(error);
                return;
            }
            // A callback may have queued more work; keep going until it stops.
            queueMicrotask(() => this._drain());
            return;
        }

        this._draining = false;
        this._commit();
    }

    _commit() {
        if (this._settled) return;

        if (this._mode === 'readwrite') {
            if (this._db._idb.failWrites) {
                this._abort(new QuotaExceededError());
                return;
            }
            this._db._stores.set(this._storeName, this._data);
        }

        this._settled = true;
        this.oncomplete?.({ target: this });
    }

    _abort(error) {
        if (this._settled) return;
        this._settled = true;
        this.error = error;
        // Real IndexedDB fires both; idb-cache.js listens for either.
        this.onerror?.({ target: this });
        this.onabort?.({ target: this });
    }
}

class FakeDatabase {
    constructor(idb) {
        this._idb = idb;
        this._stores = idb.stores;
        this.closed = false;
    }

    createObjectStore(name) {
        if (!this._stores.has(name)) this._stores.set(name, new Map());
        return name;
    }

    transaction(storeName, mode = 'readonly') {
        if (this.closed) throw new Error('database is closed');
        if (!this._stores.has(storeName)) {
            throw new Error(`no object store named ${storeName}`);
        }
        return new FakeTransaction(this, storeName, mode);
    }

    close() {
        this.closed = true;
    }
}

/**
 * An indexedDB stand-in. Assign the instance to globalThis.indexedDB.
 *
 * Test knobs:
 *   failOpen   -- every open() errors, as when a private window forbids it
 *   failWrites -- every readwrite transaction aborts, as when the quota is full
 */
export class FakeIndexedDB {
    constructor() {
        this.stores = new Map();
        this.failOpen = false;
        this.failWrites = false;
        /** Every database this fake has handed out, so tests can assert on close(). */
        this.databases = [];
        /** Names passed to open(), in order. */
        this.opens = [];
    }

    open(name, _version) {
        this.opens.push(name);
        const request = new FakeRequest();
        const upgradeNeeded = !this._initialised;

        queueMicrotask(() => {
            if (this.failOpen) {
                request.error = new Error('IndexedDB is not available');
                request.onerror?.({ target: request });
                return;
            }

            const db = new FakeDatabase(this);
            this.databases.push(db);
            request.result = db;

            // Only on first open, matching a real version bump.
            if (upgradeNeeded) {
                this._initialised = true;
                request.onupgradeneeded?.({ target: request });
            }

            request.onsuccess?.({ target: request });
        });

        return request;
    }

    /** Contents of a store, as a plain object. For assertions. */
    dump(storeName) {
        return Object.fromEntries(this.stores.get(storeName) ?? new Map());
    }

    /** Keys held in a store, for assertions about eviction. */
    keys(storeName) {
        return [...(this.stores.get(storeName) ?? new Map()).keys()];
    }
}
