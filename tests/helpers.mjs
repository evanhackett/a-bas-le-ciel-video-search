// Test harness for main.js.
//
// main.js is a browser module: it reads the DOM at import time (init() runs on
// the last line). So before importing it we build a window from the real
// index.html and expose it as the globals the module expects.
//
// Each call re-imports main.js under a fresh query string, because ES modules are
// cached per-URL and main.js holds module-level state (videos, currentPage, ...).
// Without the cache-buster every test would share one instance.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

import { FakeIndexedDB } from './fake-indexeddb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const MAIN_JS_URL = pathToFileURL(path.join(ROOT, 'main.js')).href;

/** Yield to the macrotask queue, letting pending promise chains settle. */
export const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Poll until `predicate` holds. Used to wait out the async work init() starts
 * without hard-coding how many microtask hops it happens to take.
 */
async function waitUntil(predicate, description, attempts = 50) {
    for (let i = 0; i < attempts; i++) {
        if (predicate()) return;
        await tick();
    }
    throw new Error(`timed out waiting for ${description}`);
}

/** Stands in for XMLHttpRequest: records calls, never touches the network. */
export class FakeXHR {
    static instances = [];

    constructor() {
        this.status = 0;
        this.responseText = '';
        this.sent = false;
        FakeXHR.instances.push(this);
    }

    open(method, url) {
        this.method = method;
        this.url = url;
    }

    send() {
        this.sent = true;
    }

    /** Fire onprogress. Defaults mimic a server that sent Content-Length. */
    progress(loaded, total, lengthComputable = true) {
        this.onprogress?.({ loaded, total, lengthComputable });
    }

    /** Finish successfully, delivering `body` as the response. */
    succeed(body, status = 200) {
        this.status = status;
        this.responseText = typeof body === 'string' ? body : JSON.stringify(body);
        this.onload?.();
    }

    /** Finish with an HTTP error status. */
    httpError(status = 404) {
        this.status = status;
        this.responseText = '';
        this.onload?.();
    }

    /** Fail at the transport level (offline, DNS, CORS). */
    networkError() {
        this.onerror?.();
    }

    static get last() {
        return FakeXHR.instances[FakeXHR.instances.length - 1];
    }

    static reset() {
        FakeXHR.instances = [];
    }
}

let importCounter = 0;

/**
 * Build a fresh window from index.html and import main.js against it.
 * Importing runs init(), which wires events and kicks off loadVideoData().
 *
 * Options:
 *   versionMeta -- what version.json returns. null (the default) makes the
 *                  request 404, which is the state of a checkout where
 *                  write-version.py has not run: no caching, and the progress
 *                  bar falls back to EXPECTED_BYTES.
 *   cached      -- an archive to pre-load into the fake IndexedDB under
 *                  versionMeta.version, standing in for a previous visit.
 *   failOpen    -- make every indexedDB.open() fail, as in a private window.
 *   failWrites  -- make every write abort, as when the quota is full.
 *
 * Returns once the load has either issued its XHR or rendered from cache, so a
 * test can reach straight for FakeXHR.last the way it always has.
 */
export async function loadApp({
    versionMeta = null,
    cached = null,
    failOpen = false,
    failWrites = false,
} = {}) {
    FakeXHR.reset();

    const dom = new JSDOM(INDEX_HTML, { url: 'https://example.com/' });
    const { window } = dom;
    const alerts = [];
    const warnings = [];
    const fetched = [];

    const idb = new FakeIndexedDB();
    idb.failOpen = failOpen;
    idb.failWrites = failWrites;

    if (cached) {
        // Seed the store directly rather than through a transaction: this is
        // meant to look like the state a previous visit left behind.
        idb.stores.set('datasets', new Map([[versionMeta.version, cached]]));
        idb._initialised = true;
    }

    // main.js resolves these off the global scope
    globalThis.window = window;
    globalThis.document = window.document;
    globalThis.XMLHttpRequest = FakeXHR;
    globalThis.indexedDB = idb;
    globalThis.alert = (message) => alerts.push(message);
    window.alert = globalThis.alert;
    window.scrollTo = () => {}; // jsdom has no layout; silence "not implemented"

    globalThis.fetch = async (url, options) => {
        fetched.push({ url, options });
        if (String(url).endsWith('version.json') && versionMeta) {
            return {
                ok: true,
                status: 200,
                json: async () => structuredClone(versionMeta),
            };
        }
        return { ok: false, status: 404, json: async () => ({}) };
    };

    // The cache paths warn on every miss and every failure by design. Capturing
    // them keeps the test output readable and lets tests assert on them.
    const realWarn = console.warn;
    console.warn = (...args) => warnings.push(args.map(String).join(' '));

    const app = await import(`${MAIN_JS_URL}?t=${++importCounter}`);

    const $ = (selector) => window.document.querySelector(selector);
    const $$ = (selector) => [...window.document.querySelectorAll(selector)];

    await waitUntil(
        () => FakeXHR.last?.sent || $('#search-container').style.display === 'block',
        'the archive load to reach the network or render from cache',
    );

    return {
        dom,
        window,
        document: window.document,
        alerts,
        warnings,
        fetched,
        idb,
        app,
        $,
        $$,

        /**
         * Deliver a dataset through the pending loadVideoData() request, and
         * wait for the page to render it.
         *
         * Must be awaited. The load is a promise chain now, so the response no
         * longer renders inside succeed() the way it did when xhr.onload wrote
         * to the DOM directly. The second tick covers the cache write, which
         * main.js deliberately does not await.
         */
        async deliverVideos(list) {
            FakeXHR.last.succeed(JSON.stringify(list));
            await tick();
            await tick();
        },

        /** Set the search box and options, then run a search.
         *  mode is 'exact', 'any' or 'all', matching the radios in index.html. */
        search(text, { mode = 'exact', title = true, description = true, transcript = true } = {}) {
            $('#search-input').value = text;
            $('#option1').checked = mode === 'exact';
            $('#option2').checked = mode === 'any';
            $('#option3').checked = mode === 'all';
            $('#titleCheckbox').checked = title;
            $('#descriptionCheckbox').checked = description;
            $('#transcriptCheckbox').checked = transcript;
            app.searchVideos();
        },

        /** Rendered result cards. */
        cards() {
            return $$('#results .result-item');
        },

        /** Title text of each rendered card. */
        cardTitles() {
            return $$('#results .result-left h3').map((h) => h.textContent);
        },

        pageInfo() {
            return $('#pagination-top .page-info').textContent;
        },

        cleanup() {
            console.warn = realWarn;
            window.close();
        },
    };
}

/** A minimal valid video record; override any field. */
export function makeVideo(overrides = {}) {
    const id = overrides.id ?? 'aaaaaaaaaaa';
    return {
        id,
        url: `https://www.youtube.com/watch?v=${id}`,
        title: 'A title',
        description: 'A description',
        upload_date: '20240101120000',
        transcript: 'some spoken words',
        thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        ...overrides,
    };
}

/** N distinct videos, titled "Video 1".."Video N". */
export function makeVideos(count) {
    return Array.from({ length: count }, (_, i) =>
        makeVideo({ id: `video${String(i + 1).padStart(6, '0')}`, title: `Video ${i + 1}` }),
    );
}
