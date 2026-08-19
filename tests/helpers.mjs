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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const MAIN_JS_URL = pathToFileURL(path.join(ROOT, 'main.js')).href;

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
 */
export async function loadApp() {
    FakeXHR.reset();

    const dom = new JSDOM(INDEX_HTML, { url: 'https://example.com/' });
    const { window } = dom;
    const alerts = [];

    // main.js resolves these off the global scope
    globalThis.window = window;
    globalThis.document = window.document;
    globalThis.XMLHttpRequest = FakeXHR;
    globalThis.alert = (message) => alerts.push(message);
    window.alert = globalThis.alert;
    window.scrollTo = () => {}; // jsdom has no layout; silence "not implemented"

    const app = await import(`${MAIN_JS_URL}?t=${++importCounter}`);

    const $ = (selector) => window.document.querySelector(selector);
    const $$ = (selector) => [...window.document.querySelectorAll(selector)];

    return {
        dom,
        window,
        document: window.document,
        alerts,
        app,
        $,
        $$,

        /** Deliver a dataset through the pending loadVideoData() request. */
        deliverVideos(list) {
            FakeXHR.last.succeed(JSON.stringify(list));
        },

        /** Set the search box and options, then run a search. */
        search(text, { exact = true, title = true, description = true, transcript = true } = {}) {
            $('#search-input').value = text;
            $('#option1').checked = exact;   // "contains exact search phrase"
            $('#option2').checked = !exact;  // "contains any word"
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
