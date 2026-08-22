// Tests for main.js: dataset loading, rendering, pagination and event wiring.
// Each test gets its own jsdom window; see helpers.mjs.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';

import { loadApp, FakeXHR, makeVideo, makeVideos, tick } from './helpers.mjs';

let app;

beforeEach(async () => {
    app = await loadApp();
});

afterEach(() => {
    app?.cleanup();
});

describe('loading the dataset', () => {
    test('requests videos.json on startup', () => {
        assert.equal(FakeXHR.last.method, 'GET');
        assert.equal(FakeXHR.last.url, 'videos.json');
        assert.ok(FakeXHR.last.sent);
    });

    test('keeps the search UI hidden until data arrives', () => {
        assert.equal(app.$('#search-container').style.display, 'none');
    });

    test('reveals the search UI once data arrives', async () => {
        await app.deliverVideos(makeVideos(2));
        assert.equal(app.$('#search-container').style.display, 'block');
    });

    test('hides the progress bar when the load finishes', async () => {
        await app.deliverVideos(makeVideos(2));
        assert.equal(app.$('#progress-bar-container').style.display, 'none');
    });

    test('shows an error banner on an HTTP error', async () => {
        FakeXHR.last.httpError(404);
        await tick();
        assert.match(app.document.body.firstChild.textContent, /Failed to load video data/);
    });

    test('shows an error banner when the JSON is malformed', async () => {
        FakeXHR.last.succeed('{ not valid json');
        await tick();
        assert.match(app.document.body.firstChild.textContent, /Failed to load video data/);
    });

    test('shows an error banner on a network failure', async () => {
        FakeXHR.last.networkError();
        await tick();
        assert.match(app.document.body.firstChild.textContent, /Failed to load video data/);
    });

    test('leaves the search UI hidden when the load fails', async () => {
        FakeXHR.last.httpError(500);
        await tick();
        assert.equal(app.$('#search-container').style.display, 'none');
    });
});

describe('load progress bar', () => {
    const MB = 1048576;
    // What GitHub Pages actually reported for videos.json, verified with curl:
    // content-encoding gzip, content-length 17969259 against 52258072 uncompressed.
    const COMPRESSED_TOTAL = 17_969_259;

    test('grows the bar as bytes arrive', () => {
        FakeXHR.last.progress(app.app.EXPECTED_BYTES / 4, COMPRESSED_TOTAL);
        assert.equal(app.$('#progress-bar').style.width, '25%');
        assert.equal(app.$('#progress-bar-container').style.display, 'block');
    });

    // The bug this whole approach exists to kill. Measured against the compressed
    // content-length, a half-finished download reads as 155% and the bar snaps to
    // full a third of the way in.
    test('ignores the compressed length the server reports', () => {
        FakeXHR.last.progress(app.app.EXPECTED_BYTES / 2, COMPRESSED_TOTAL);
        assert.equal(app.$('#progress-bar').style.width, '50%');
    });

    test('caps the bar at 100% once the dataset outgrows the constant', () => {
        FakeXHR.last.progress(app.app.EXPECTED_BYTES * 1.1, COMPRESSED_TOTAL);
        assert.equal(app.$('#progress-bar').style.width, '100%');
    });

    test('reports progress even without a computable length', () => {
        // Nothing reads event.total any more, so a response with no Content-Length
        // is no longer a reason to freeze the bar.
        FakeXHR.last.progress(app.app.EXPECTED_BYTES / 2, 0, false);
        assert.equal(app.$('#progress-bar').style.width, '50%');
    });

    test('shows how many bytes have arrived', () => {
        FakeXHR.last.progress(24 * MB, COMPRESSED_TOTAL);
        assert.equal(
            app.$('#progress-text').textContent,
            `24.0 MB of ${(app.app.EXPECTED_BYTES / MB).toFixed(1)} MB`,
        );
    });

    // The guard that makes the constant safe to rely on: growth fails here with the
    // number to paste in, rather than quietly skewing the bar.
    test('EXPECTED_BYTES still matches videos.json', () => {
        const actual = statSync(new URL('../videos.json', import.meta.url)).size;
        const drift = Math.abs(actual - app.app.EXPECTED_BYTES) / actual;
        assert.ok(
            drift < 0.05,
            `EXPECTED_BYTES is ${app.app.EXPECTED_BYTES} but videos.json is ${actual} `
            + `(${(drift * 100).toFixed(1)}% out) -- set it to ${actual}`,
        );
    });
});

describe('the archive cache', () => {
    // What version.json holds. `count` has to match the fixture, or main.js
    // refuses the write -- that refusal is itself tested below.
    const META = { version: 'abc123', bytes: 4096, count: 3 };
    const ARCHIVE = makeVideos(3);

    /** Replace the app the outer beforeEach built with one configured here. */
    async function reload(options) {
        app.cleanup();
        app = await loadApp(options);
        return app;
    }

    describe('on a repeat visit', () => {
        beforeEach(async () => {
            await reload({ versionMeta: META, cached: ARCHIVE });
        });

        test('renders from the cache without downloading the archive', () => {
            assert.equal(FakeXHR.instances.length, 0, 'videos.json was requested anyway');
            assert.equal(app.$('#search-container').style.display, 'block');
            assert.equal(app.cards().length, 3);
        });

        test('never shows the progress bar, since nothing is downloading', () => {
            assert.equal(app.$('#progress-bar-container').style.display, 'none');
            assert.equal(app.$('#progress-text').textContent, '');
        });

        test('still checks the fingerprint, and forces it to revalidate', () => {
            const request = app.fetched.find((f) => String(f.url).endsWith('version.json'));
            assert.ok(request, 'version.json was not fetched');
            // Without this the 600-second max-age would let a stale fingerprint
            // send the visitor to a cache entry for a dataset since replaced.
            assert.equal(request.options?.cache, 'no-cache');
        });

        test('the cached archive is searchable like any other', () => {
            app.search('Video 2');
            assert.deepEqual(app.cardTitles(), ['Video 2']);
        });
    });

    describe('on a first visit', () => {
        beforeEach(async () => {
            await reload({ versionMeta: META });
        });

        test('downloads the archive when the version is not cached', () => {
            assert.equal(FakeXHR.last.url, 'videos.json');
        });

        test('stores the archive under the fingerprint', async () => {
            await app.deliverVideos(ARCHIVE);

            assert.deepEqual(app.idb.keys('datasets'), [META.version]);
            assert.equal(app.idb.dump('datasets')[META.version].length, 3);
        });

        test('measures progress against the size version.json reports', () => {
            FakeXHR.last.progress(META.bytes / 2, 0);
            assert.equal(app.$('#progress-bar').style.width, '50%');
        });
    });

    describe('evicting the previous dataset', () => {
        test('ends a new-dataset load holding only the new one', async () => {
            await reload({ versionMeta: META, seed: { 'older-version': makeVideos(2) } });
            await app.deliverVideos(ARCHIVE);

            assert.deepEqual(app.idb.keys('datasets'), [META.version]);
        });

        // Ordering, not just the end state. Evicting as part of the write would
        // leave both archives live until the transaction committed -- 110 MB for
        // this dataset -- which is exactly when a tight quota refuses it.
        test('frees the old copy before the download, not after', async () => {
            await reload({ versionMeta: META, seed: { 'older-version': makeVideos(2) } });

            // loadApp() returns once the XHR is away and nothing has been
            // delivered yet, so this is the state during the download.
            assert.ok(FakeXHR.last.sent, 'the download had not started');
            assert.deepEqual(app.idb.keys('datasets'), [],
                             'the stale archive was still held during the download');
        });

        test('clears up even when the download is never cached', async () => {
            // A torn fingerprint/archive pair skips the write entirely, so
            // eviction is the only thing that reclaims the space.
            await reload({ versionMeta: META, seed: { 'older-version': makeVideos(2) } });
            await app.deliverVideos(makeVideos(2));   // META.count says 3

            assert.deepEqual(app.idb.keys('datasets'), []);
        });

        test('clears up even when the write fails', async () => {
            await reload({
                versionMeta: META,
                seed: { 'older-version': makeVideos(2) },
                failWrites: true,
            });
            await app.deliverVideos(ARCHIVE);

            // The eviction aborts with everything else, so the stale copy
            // survives -- but it is never served, and the page still works.
            assert.equal(app.cards().length, 3);
        });

        // A blip on version.json must not cost the stored archive as well: with
        // no fingerprint there is no way to tell what is stale.
        test('leaves the cache alone when the fingerprint cannot be read', async () => {
            await reload({ seed: { 'some-version': ARCHIVE } });
            await app.deliverVideos(ARCHIVE);

            assert.deepEqual(app.idb.keys('datasets'), ['some-version']);
        });
    });

    // The CDN skew this guards against is real: version.json and videos.json are
    // independent objects with independent 600-second lifetimes, so a visitor
    // arriving mid-deploy can get the new fingerprint with the old archive.
    test('refuses to cache a download that disagrees with the fingerprint', async () => {
        await reload({ versionMeta: META });
        await app.deliverVideos(makeVideos(2));   // META.count says 3

        assert.deepEqual(app.idb.keys('datasets'), [], 'a torn pair was cached');
        // The visitor still gets a working page out of it.
        assert.equal(app.cards().length, 2);
    });

    describe('when the cache is unusable', () => {
        test('a browser without IndexedDB still loads the archive', async () => {
            await reload({ versionMeta: META, failOpen: true });
            await app.deliverVideos(ARCHIVE);

            assert.equal(app.cards().length, 3);
            assert.ok(app.warnings.some((w) => /read failed/.test(w)));
        });

        test('a failed write leaves the page working', async () => {
            await reload({ versionMeta: META, failWrites: true });
            await app.deliverVideos(ARCHIVE);

            assert.equal(app.cards().length, 3);
            assert.deepEqual(app.idb.keys('datasets'), []);
            assert.ok(app.warnings.some((w) => /write failed/.test(w)));
        });

        test('a missing version.json falls back to a plain download', async () => {
            // The default: loadApp() serves version.json as a 404, which is the
            // state of a checkout where write-version.py has not been run.
            await reload({});
            await app.deliverVideos(ARCHIVE);

            assert.equal(app.cards().length, 3);
            assert.deepEqual(app.idb.keys('datasets'), [], 'cached without a fingerprint');
            assert.ok(app.warnings.some((w) => /version check failed/.test(w)));
        });

        test('an HTTP error still reports failure rather than a stale render', async () => {
            await reload({ versionMeta: META });
            FakeXHR.last.httpError(500);
            await tick();

            assert.match(app.document.body.firstChild.textContent, /Failed to load video data/);
            assert.equal(app.$('#search-container').style.display, 'none');
        });
    });

    test('version.json on disk describes the shipped videos.json', () => {
        // write-version.py has to be re-run after every promotion; forgetting
        // means every visitor re-downloads on every deploy, silently.
        const meta = JSON.parse(readFileSync(new URL('../version.json', import.meta.url), 'utf8'));
        const actual = statSync(new URL('../videos.json', import.meta.url)).size;

        assert.equal(
            meta.bytes, actual,
            `version.json is stale (says ${meta.bytes} bytes, videos.json is ${actual})`
            + ' -- run: python3 write-version.py',
        );
    });
});

describe('searching', () => {
    beforeEach(async () => {
        await app.deliverVideos([
            makeVideo({ id: 'a', title: 'Antinatalism', description: 'a discussion of ethics', transcript: 'spoken words' }),
            makeVideo({ id: 'b', title: 'Chromebook', description: 'a discussion of hardware', transcript: 'other words' }),
            makeVideo({ id: 'c', title: 'Ecology', description: 'a discussion of nature', transcript: 'green things' }),
        ]);
    });

    test('renders one card per match', () => {
        app.search('Antinatalism');
        assert.equal(app.cards().length, 1);
        assert.deepEqual(app.cardTitles(), ['Antinatalism']);
    });

    test('all-words mode requires every word, across fields', () => {
        // every video has "discussion"; only one also has "antinatalism"
        app.search('discussion antinatalism', { mode: 'all' });
        assert.deepEqual(app.cardTitles(), ['Antinatalism']);
    });

    test('all-words mode is narrower than any-word mode', () => {
        app.search('discussion antinatalism', { mode: 'any' });
        assert.equal(app.cards().length, 3);

        app.search('discussion antinatalism', { mode: 'all' });
        assert.equal(app.cards().length, 1);
    });

    test('all-words mode finds nothing when one word is absent', () => {
        app.search('discussion zebra', { mode: 'all' });
        assert.equal(app.cards().length, 0);
    });

    test('reports the number of results', () => {
        app.search('discussion');
        assert.equal(app.$('#result-count').textContent, 'Found 3 result(s)');
    });

    test('renders nothing when there is no match', () => {
        app.search('zebra');
        assert.equal(app.cards().length, 0);
        assert.equal(app.$('#result-count').textContent, 'Found 0 result(s)');
    });

    test('exact mode requires the whole phrase', () => {
        app.search('ecology antinatalism', { mode: 'exact' });
        assert.equal(app.cards().length, 0);
    });

    test('any-word mode matches either token', () => {
        app.search('ecology antinatalism', { mode: 'any' });
        assert.equal(app.cards().length, 2);
    });

    test('honours the field checkboxes', () => {
        app.search('ethics', { title: true, description: false, transcript: false });
        assert.equal(app.cards().length, 0);

        app.search('ethics', { title: true, description: true, transcript: false });
        assert.equal(app.cards().length, 1);
    });

    test('searches transcripts', () => {
        app.search('green things');
        assert.deepEqual(app.cardTitles(), ['Ecology']);
    });

    test('highlights the matched text', () => {
        app.search('Ecology');
        assert.match(app.cards()[0].innerHTML, /<span class="highlight">Ecology<\/span>/);
    });

    test('renders the thumbnail and a link to the video', () => {
        app.search('Ecology');
        const card = app.cards()[0];
        assert.ok(card.querySelector('img').src.includes('/vi/c/'));
        assert.equal(card.querySelector('a').href, 'https://www.youtube.com/watch?v=c');
    });

    test('shows the formatted upload date', () => {
        app.search('Ecology');
        assert.match(app.cards()[0].textContent, /01 January 2024/);
    });

    test('replaces results from the previous search', () => {
        app.search('Antinatalism');
        assert.equal(app.cards().length, 1);
        app.search('zebra');
        assert.equal(app.cards().length, 0);
    });

    test('alerts and searches nothing when the query is too short', () => {
        const before = app.cardTitles();
        app.search('ab');

        assert.equal(app.alerts.length, 1);
        assert.match(app.alerts[0], /at least 3 characters/);
        // The search is refused, so the landing list stands. Asserting it is
        // unchanged says that directly; asserting it is empty only worked while
        // the page happened to start with nothing rendered.
        assert.deepEqual(app.cardTitles(), before);
    });

    test('alerts when an any-word query contains a short word', () => {
        app.search('ab ecology', { mode: 'any' });
        assert.equal(app.alerts.length, 1);
        assert.match(app.alerts[0], /each word needs to be at least 3/);
    });
});

describe('pagination', () => {
    // 25 videos titled "Video 1".."Video 25"; searching "video" matches all of them.
    beforeEach(async () => {
        await app.deliverVideos(makeVideos(25));
        app.search('video');
    });

    test('splits results into pages of ten', () => {
        assert.equal(app.cards().length, 10);
        assert.equal(app.pageInfo(), 'Page 1 of 3');
    });

    test('shows the pagination controls', () => {
        // Empty, not 'block': an inline display would override .pagination's
        // `display: flex` and with it the centring and the small-screen wrapping.
        assert.equal(app.$('#pagination-top').style.display, '');
        assert.equal(app.$('#pagination-bottom').style.display, '');
    });

    test('disables first/previous on the opening page', () => {
        assert.ok(app.$('.first-button').disabled);
        assert.ok(app.$('.prev-button').disabled);
        assert.ok(!app.$('.next-button').disabled);
    });

    test('next advances one page', () => {
        app.app.nextPage();
        assert.equal(app.pageInfo(), 'Page 2 of 3');
        assert.deepEqual(app.cardTitles()[0], 'Video 11');
    });

    test('previous goes back one page', () => {
        app.app.nextPage();
        app.app.prevPage();
        assert.equal(app.pageInfo(), 'Page 1 of 3');
        assert.equal(app.cardTitles()[0], 'Video 1');
    });

    test('last jumps to the final page, which holds the remainder', () => {
        app.app.lastPage();
        assert.equal(app.pageInfo(), 'Page 3 of 3');
        assert.equal(app.cards().length, 5);
        assert.equal(app.cardTitles().at(-1), 'Video 25');
    });

    test('first jumps back to the opening page', () => {
        app.app.lastPage();
        app.app.firstPage();
        assert.equal(app.pageInfo(), 'Page 1 of 3');
    });

    test('disables next/last on the final page', () => {
        app.app.lastPage();
        assert.ok(app.$('.next-button').disabled);
        assert.ok(app.$('.last-button').disabled);
    });

    test('does not advance past the final page', () => {
        app.app.lastPage();
        app.app.nextPage();
        assert.equal(app.pageInfo(), 'Page 3 of 3');
    });

    test('does not retreat before the first page', () => {
        app.app.prevPage();
        assert.equal(app.pageInfo(), 'Page 1 of 3');
    });

    test('hides the bottom controls when everything fits on one page', () => {
        app.search('Video 7'); // matches only "Video 7"
        assert.equal(app.$('#pagination-bottom').style.display, 'none');
    });

    test('changing results per page resizes and returns to page 1', () => {
        app.app.lastPage();
        app.$('#results-per-page').value = '20';
        app.$('#results-per-page').dispatchEvent(new app.window.Event('change'));

        assert.equal(app.cards().length, 20);
        assert.equal(app.pageInfo(), 'Page 1 of 2');
    });

    // Regression: with no results totalPages was 0, so currentPage (1) never
    // equalled it and next/last stayed live on an empty list.
    test('disables next/last when there are no results', () => {
        app.search('zebra');
        assert.ok(app.$('.next-button').disabled);
        assert.ok(app.$('.last-button').disabled);
    });

    test('disables prev/first when there are no results too', () => {
        app.search('zebra');
        assert.ok(app.$('.prev-button').disabled);
        assert.ok(app.$('.first-button').disabled);
    });

    test('reads "Page 1 of 1" rather than "Page 1 of 0" when empty', () => {
        app.search('zebra');
        assert.equal(app.pageInfo(), 'Page 1 of 1');
    });

    test('lastPage stays on page 1 when there are no results', () => {
        // totalPages of 0 used to send currentPage to 0
        app.search('zebra');
        app.app.lastPage();
        assert.equal(app.pageInfo(), 'Page 1 of 1');
    });
});

describe('static page markup', () => {
    // Regression: neither page declared a charset, so browsers guessed and the
    // em dashes in help.html rendered as "a with a hat" mojibake.
    for (const page of ['index.html', 'help.html']) {
        test(`${page} declares utf-8`, () => {
            const html = readFileSync(new URL(`../${page}`, import.meta.url), 'utf8');
            assert.match(html, /<meta\s+charset="utf-8">/i);

            // The declaration only counts if it is early enough for the browser to
            // act on it, and it must come before any non-ASCII byte.
            const at = html.search(/<meta\s+charset=/i);
            assert.ok(at < 1024, `charset declared at byte ${at}`);
            const firstNonAscii = [...html].findIndex(ch => ch.charCodeAt(0) > 127);
            assert.ok(firstNonAscii === -1 || at < firstNonAscii, 'non-ASCII before charset');
        });
    }
});

describe('the landing state', () => {
    test('renders the archive without anyone searching', async () => {
        await app.deliverVideos(makeVideos(25));
        assert.equal(app.cards().length, 10);   // one page of it
    });

    test('keeps the order the dataset is in, which is newest first', async () => {
        await app.deliverVideos([
            makeVideo({ id: 'new', title: 'Newest', upload_date: '20260101000000' }),
            makeVideo({ id: 'mid', title: 'Middle', upload_date: '20250101000000' }),
            makeVideo({ id: 'old', title: 'Oldest', upload_date: '20240101000000' }),
        ]);

        assert.deepEqual(app.cardTitles(), ['Newest', 'Middle', 'Oldest']);
    });

    test('says what is being shown rather than claiming a search found it', async () => {
        await app.deliverVideos(makeVideos(25));

        const text = app.$('#result-count').textContent;
        assert.match(text, /Showing all 25 videos/);
        assert.doesNotMatch(text, /Found/);
    });

    test('highlights nothing, because nothing has been searched for', async () => {
        await app.deliverVideos(makeVideos(3));
        assert.equal(app.$$('#results .highlight').length, 0);
    });

    test('paginates the whole archive', async () => {
        await app.deliverVideos(makeVideos(25));
        assert.equal(app.pageInfo(), 'Page 1 of 3');
    });

    test('a search then narrows it', async () => {
        await app.deliverVideos(makeVideos(25));
        assert.equal(app.cards().length, 10);

        app.search('Video 3');
        assert.ok(app.cards().length < 10);
        assert.match(app.$('#result-count').textContent, /Found/);
    });

    test('an HTTP error renders nothing rather than an empty archive', () => {
        FakeXHR.last.httpError(404);

        assert.equal(app.cards().length, 0);
        assert.doesNotMatch(app.$('#result-count').textContent, /Showing all/);
    });

    test('a network error renders nothing either', () => {
        FakeXHR.last.networkError();

        assert.equal(app.cards().length, 0);
        assert.doesNotMatch(app.$('#result-count').textContent, /Showing all/);
    });
});

describe('an empty search', () => {
    beforeEach(async () => {
        await app.deliverVideos(makeVideos(25));
    });

    test('shows the whole archive instead of complaining', () => {
        app.search('Video 3');
        assert.ok(app.cards().length < 10);

        app.search('');

        assert.equal(app.alerts.length, 0);
        assert.equal(app.cards().length, 10);
        assert.match(app.$('#result-count').textContent, /Showing all 25 videos/);
    });

    test('whitespace alone counts as empty', () => {
        app.search('   ');

        assert.equal(app.alerts.length, 0);
        assert.equal(app.cards().length, 10);
    });

    test('returns to page 1 of the whole archive', () => {
        app.app.lastPage();
        app.search('');

        assert.equal(app.pageInfo(), 'Page 1 of 3');
    });

    test('highlights nothing, since there is nothing to highlight', () => {
        app.search('Video');
        assert.ok(app.$$('#results .highlight').length > 0);

        app.search('');
        assert.equal(app.$$('#results .highlight').length, 0);
    });

    test('a query that is short but not empty is still refused', () => {
        // The three-character rule still means something; "" is simply not a
        // short search, it is no search.
        app.search('ab');

        assert.equal(app.alerts.length, 1);
        assert.match(app.alerts[0], /at least 3 characters/);
    });
});

describe('escaping in rendered cards', () => {
    const render = async (overrides) => {
        await app.deliverVideos([makeVideo({ title: 'Ecology', ...overrides })]);
        app.search('Ecology');
    };

    test('markup in a title arrives as text, not as elements', async () => {
        await render({ title: 'Ecology <img src=x onerror="boom()">' });

        assert.equal(app.$$('#results .result-left h3 img').length, 0);
        assert.match(app.cardTitles()[0], /<img src=x onerror="boom\(\)">/);
    });

    test('markup in a transcript arrives as text', async () => {
        await render({ transcript: 'Ecology <script>boom()</script>' });

        assert.equal(app.$$('#results .result-right script').length, 0);
        assert.match(app.$('#results .result-right p').textContent, /<script>/);
    });

    test('a quote in an attribute cannot break out of it', async () => {
        await render({ thumbnail: 'x" onerror="boom()' });

        const img = app.$('#results .result-left img');
        assert.equal(img.getAttribute('onerror'), null);
        assert.equal(img.getAttribute('src'), 'x" onerror="boom()');
    });

    test('the link href is escaped but still usable', async () => {
        await render({ url: 'https://youtu.be/a?b=1&c=2' });

        assert.equal(app.$('#results .result-left a').getAttribute('href'),
                     'https://youtu.be/a?b=1&c=2');
    });

    test('a newline becomes one line break, not two', async () => {
        // Descriptions put consecutive URLs on their own lines separated by a
        // single newline; doubling dropped a blank line between them.
        await render({ description: 'first line\nsecond line' });

        const paragraphs = app.$$('#results .result-left p');
        assert.match(paragraphs[1].innerHTML, /first line<br>second line/);
    });

    test('a blank line still reads as a paragraph gap', async () => {
        await render({ description: 'first para\n\nsecond para' });

        const paragraphs = app.$$('#results .result-left p');
        assert.match(paragraphs[1].innerHTML, /first para<br><br>second para/);
    });

    test('highlighting still works on ordinary text', async () => {
        await render({});
        assert.equal(app.$$('#results .result-left h3 .highlight').length, 1);
    });
});

describe('search progress', () => {
    beforeEach(async () => {
        await app.deliverVideos(makeVideos(5));
    });

    test('clears the byte readout, which means nothing for a search', () => {
        app.search('Video');
        assert.equal(app.$('#progress-text').textContent, '');
    });

    test('hides the bar again when the search finishes', () => {
        app.search('Video');
        assert.equal(app.$('#progress-bar-container').style.display, 'none');
    });
});

describe('help link', () => {
    test('points at the help page', () => {
        const link = app.$('.help-link a');
        assert.ok(link, 'no help link in the search options');
        assert.equal(link.getAttribute('href'), 'help.html');
    });

    test('opens in a new tab so the loaded dataset is not thrown away', () => {
        // index.html holds the whole archive in memory; navigating away and back
        // would re-download it.
        const link = app.$('.help-link a');
        assert.equal(link.getAttribute('target'), '_blank');
        assert.match(link.getAttribute('rel') ?? '', /noopener/);
    });

    test('each mode label emphasises the word that distinguishes it', () => {
        for (const [id, word] of [['option1', 'exact'], ['option2', 'any'], ['option3', 'all']]) {
            const strong = app.$(`label[for="${id}"] strong`);
            assert.ok(strong, `no <strong> in the ${id} label`);
            assert.equal(strong.textContent, word);
        }
    });
});

describe('event wiring', () => {
    beforeEach(async () => {
        await app.deliverVideos(makeVideos(25));
    });

    test('the search button runs a search', () => {
        app.$('#search-input').value = 'Video 3';
        app.$('#search-button').click();
        assert.ok(app.cards().length > 0);
    });

    test('pressing Enter in the search box runs a search', () => {
        app.$('#search-input').value = 'Video 3';
        app.$('#search-input').dispatchEvent(
            new app.window.KeyboardEvent('keypress', { key: 'Enter', bubbles: true }),
        );
        assert.ok(app.cards().length > 0);
    });

    test('another key does not run a search', () => {
        const before = app.cardTitles();
        app.$('#search-input').value = 'Video 3';
        app.$('#search-input').dispatchEvent(
            new app.window.KeyboardEvent('keypress', { key: 'a', bubbles: true }),
        );
        assert.deepEqual(app.cardTitles(), before);
    });

    test('the next button advances the page', () => {
        app.search('video');
        app.$('#pagination-top .next-button').click();
        assert.equal(app.pageInfo(), 'Page 2 of 3');
    });

    test('the bottom pagination buttons are wired too', () => {
        app.search('video');
        app.$('#pagination-bottom .next-button').click();
        assert.equal(app.pageInfo(), 'Page 2 of 3');
    });
});
