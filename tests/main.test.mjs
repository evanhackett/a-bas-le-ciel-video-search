// Tests for main.js: dataset loading, rendering, pagination and event wiring.
// Each test gets its own jsdom window; see helpers.mjs.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';

import { loadApp, FakeXHR, makeVideo, makeVideos } from './helpers.mjs';

/** Let pending promise callbacks (the loadVideoData catch chain) run. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

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

    test('reveals the search UI once data arrives', () => {
        app.deliverVideos(makeVideos(2));
        assert.equal(app.$('#search-container').style.display, 'block');
    });

    test('hides the progress bar when the load finishes', () => {
        app.deliverVideos(makeVideos(2));
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

describe('searching', () => {
    beforeEach(() => {
        app.deliverVideos([
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
        app.search('ab');
        assert.equal(app.alerts.length, 1);
        assert.match(app.alerts[0], /at least 3 characters/);
        assert.equal(app.cards().length, 0);
    });

    test('alerts when an any-word query contains a short word', () => {
        app.search('ab ecology', { mode: 'any' });
        assert.equal(app.alerts.length, 1);
        assert.match(app.alerts[0], /each word needs to be at least 3/);
    });
});

describe('pagination', () => {
    // 25 videos titled "Video 1".."Video 25"; searching "video" matches all of them.
    beforeEach(() => {
        app.deliverVideos(makeVideos(25));
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

describe('escaping in rendered cards', () => {
    const render = (overrides) => {
        app.deliverVideos([makeVideo({ title: 'Ecology', ...overrides })]);
        app.search('Ecology');
    };

    test('markup in a title arrives as text, not as elements', () => {
        render({ title: 'Ecology <img src=x onerror="boom()">' });

        assert.equal(app.$$('#results .result-left h3 img').length, 0);
        assert.match(app.cardTitles()[0], /<img src=x onerror="boom\(\)">/);
    });

    test('markup in a transcript arrives as text', () => {
        render({ transcript: 'Ecology <script>boom()</script>' });

        assert.equal(app.$$('#results .result-right script').length, 0);
        assert.match(app.$('#results .result-right p').textContent, /<script>/);
    });

    test('a quote in an attribute cannot break out of it', () => {
        render({ thumbnail: 'x" onerror="boom()' });

        const img = app.$('#results .result-left img');
        assert.equal(img.getAttribute('onerror'), null);
        assert.equal(img.getAttribute('src'), 'x" onerror="boom()');
    });

    test('the link href is escaped but still usable', () => {
        render({ url: 'https://youtu.be/a?b=1&c=2' });

        assert.equal(app.$('#results .result-left a').getAttribute('href'),
                     'https://youtu.be/a?b=1&c=2');
    });

    test('description line breaks still become paragraph breaks', () => {
        render({ description: 'first line\n\nsecond line' });

        const paragraphs = app.$$('#results .result-left p');
        assert.match(paragraphs[1].innerHTML, /first line<br><br><br><br>second line/);
    });

    test('highlighting still works on ordinary text', () => {
        render({});
        assert.equal(app.$$('#results .result-left h3 .highlight').length, 1);
    });
});

describe('search progress', () => {
    beforeEach(() => {
        app.deliverVideos(makeVideos(5));
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
    beforeEach(() => {
        app.deliverVideos(makeVideos(25));
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
        app.$('#search-input').value = 'Video 3';
        app.$('#search-input').dispatchEvent(
            new app.window.KeyboardEvent('keypress', { key: 'a', bubbles: true }),
        );
        assert.equal(app.cards().length, 0);
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
