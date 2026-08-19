# a-bas-le-ciel Video Search

Full-text search over the [a-bas-le-ciel](https://www.youtube.com/channel/UCWPKJM4CT6ES2BrUz9wbELw)
YouTube channel, including **transcripts** — which is the part YouTube's own search
won't do for you.

**Live site:** https://evanhackett.com/a-bas-le-ciel-video-search/

## How it works

A static site with no build step and no server. The browser downloads the entire
dataset and searches it in memory. The JS is plain ES modules, which browsers load
natively — there is nothing to compile or bundle.

| File | Role |
| --- | --- |
| `index.html` | Markup. Loads `main.js` as `<script type="module">`. |
| `search.js` | Pure logic: matching, tokenizing, date formatting, highlighting. No DOM. |
| `main.js` | DOM: fetches `videos.json`, renders results, paginates, wires events. |
| `styles.css` | All styling. |
| `videos.json` | **The dataset.** ~52 MB, one object per video. |

`loadVideoData()` XHRs `videos.json` into a module-level array, then `searchVideos()`
filters it with plain substring matching over whichever of
title / description / transcript you've checked. There is no search index — it's a
linear scan over every video on every query. At the current dataset size that's
fast enough to feel instant.

The split exists so the matching logic can be tested without a browser. Keep
`search.js` free of DOM access; everything that touches the page belongs in
`main.js`. Event handlers are attached in `wireEvents()` — do not add inline
`onclick` attributes, as module scope is not global and they will not resolve.

**Previewing locally needs a web server.** ES modules are blocked over `file://`,
so opening `index.html` by double-clicking will not work:

```bash
python3 -m http.server 8000   # then visit http://localhost:8000
```

Each record looks like:

```json
{
  "id": "DWo6U8Pwcw4",
  "url": "https://www.youtube.com/watch?v=DWo6U8Pwcw4",
  "title": "The difference between a caricature and a portrait: Donald Trump.",
  "description": "",
  "upload_date": "20240620234817",
  "transcript": "if this portrait existed of me anywhere in the world okay ...",
  "thumbnail": "https://i.ytimg.com/vi/DWo6U8Pwcw4/hqdefault.jpg"
}
```

`upload_date` is `YYYYMMDDHHMMSS`. Videos with no captions get the literal string
`"Transcript not available."` as their transcript.

## Deployment

GitHub Pages, served from the root of `main`. **Pushing to `main` is the deploy.**
There is no build, no CI, and no gh-pages branch.

## Tests

Two suites, run separately.

```bash
npm test                 # JavaScript  (node --test + jsdom)
venv/bin/pytest          # Python      (pytest)
```

First time on a fresh clone: `npm install` for the JS side. The Python side needs
only `pip install pytest` into the existing venv — see the venv warning below
before touching it.

| Suite | Covers |
| --- | --- |
| `tests/search.test.mjs` | `search.js` matching and formatting. Pure, no DOM, no jsdom. |
| `tests/main.test.mjs` | `main.js` against a jsdom window built from the real `index.html`. |
| `tests/test_get_video_data.py` | `get-video-data.py`: key loading, dedupe, API parsing, the merge. |
| `tests/test_data_integrity.py` | The shipped `videos.json` itself. |

`tests/helpers.mjs` builds a fresh window per test and swaps in a `FakeXHR`, so no
test touches the network. Because `main.js` holds module-level state, each test
re-imports it under a cache-busting query string for isolation.

Some tests are marked `todo`: they describe behaviour that is known to be wrong
and are reported without failing the run. They flip to passing when the bug is
fixed. Currently these cover the regex-injection bug in `highlightText()`, the
progress bar exceeding 100% on GitHub Pages, and the pagination buttons staying
enabled when a search returns nothing.

`test_data_integrity.py` runs against the real 52 MB dataset, so it catches
problems the unit tests cannot — malformed dates, mismatched URLs, duplicate ids.
**The duplicate-id check currently fails** on the 7 known duplicates; see
[Known issues](#known-issues).

Neither suite talks to the YouTube API or needs a key.

## Updating the data

`get-video-data.py` fetches videos published since the newest one already in
`videos.json`, pulls their transcripts, merges everything, and sorts
reverse-chronologically.

```bash
cd my-site
source venv/bin/activate
python get-video-data.py
```

First run on a fresh clone? Set up the API key first — see [API key](#api-key) below.

It prints the cutoff date it derived and then a line per video it fetches. If the
channel has nothing new it says so and exits without writing anything.

### The manual step that is easy to forget

**The script writes `updated_videos.json`, not `videos.json`.** You have to promote
it yourself:

```bash
mv updated_videos.json videos.json
git add videos.json
git commit -m "Update videos.json"
git push
```

To check whether a past run was ever promoted: if `videos.json` and
`updated_videos.json` have the same hash, it was.

```bash
md5 videos.json updated_videos.json
```

### Use the committed venv — do not rebuild it

`requirements.txt` has **no version pins**, and the script will not survive a fresh
install. `venv/` has `youtube-transcript-api==0.6.2`; version 1.0 (2025) removed the
static `YouTubeTranscriptApi.get_transcript()` that `get_video_details()` calls and
relocated the exception classes that are imported from `youtube_transcript_api._errors`.
A clean `pip install -r requirements.txt` today installs the new API and the script
raises on import.

If you ever do need to rebuild the environment, pin these first:

```
youtube-transcript-api==0.6.2
google-api-python-client==2.134.0
```

...or port the two call sites to the 1.x instance-based API.

### API key

The script needs a YouTube Data API v3 key. It reads one from either source, in
this order:

1. the `YOUTUBE_API_KEY` environment variable, if set
2. `config.json` sitting next to the script

`config.json` is **gitignored and must never be committed.** To set it up on a
fresh clone:

```bash
cp config.example.json config.json
# then edit config.json and paste your key in
```

```json
{
  "youtube_api_key": "PASTE_YOUR_YOUTUBE_DATA_API_V3_KEY_HERE"
}
```

Get a key from the [Google Cloud Console](https://console.cloud.google.com/apis/credentials):
create a project, enable **YouTube Data API v3**, then create an API key. Restrict
it to that one API — this script only ever calls `search.list` and `videos.list`,
so a restricted key limits the damage if it does leak. Don't add an HTTP-referrer
restriction; that's for browser keys and will break a command-line script.

If no key is found the script exits with a message telling you which of the two to
set, rather than failing somewhere deep in an API call.

Quota: `search.list` costs 100 units per page against a 10,000/day default budget;
the per-video `videos.list` and transcript calls are cheap but slow. A long backlog
is more likely to be rate-limited on transcripts than on quota.

## Files that aren't part of the site

Nothing here is loaded by the site at runtime, and none of it is tracked in git.
You will see these locally but not in a fresh clone.

- **`config.json`** — your API key. Gitignored; see [API key](#api-key). The tracked
  `config.example.json` is the template to copy from.
- **`metadata.json`** — the original seed dataset, 2,327 videos through 2022-07-20.
  It is a byte-identical copy of the file from
  [Aryailia/a-bas-le-ciel](https://github.com/Aryailia/a-bas-le-ciel) (cloned to
  `../a-bas-le-ciel`), which already included transcripts and thumbnails.
  `videos.json` was seeded from it; everything after 2022-07-20 came from
  `get-video-data.py`. Keep it around as the origin point, but it's never read
  by anything now.
- **`playlist.json`** — a yt-dlp playlist dump (178 playlists) from that same
  upstream repo. Completely unused; playlists were never surfaced in the UI.
- **`updated_videos.json`** — leftover output from the last script run. Safe to
  delete once promoted.
- **`sample.json`** — a hand-truncated subset, presumably for testing against
  something smaller than 52 MB. **It is invalid JSON** (trailing comma near line 622)
  and nothing references it.
- **`todo.txt`** — a scratch todo list, kept local. Its contents are mirrored in
  the [Todo](#todo) section below.

## Known issues

- **The load progress bar is broken on the live site but fine locally.** GitHub Pages
  serves `videos.json` gzipped with `Content-Length: ~17.9 MB` (compressed), but
  XHR's `event.loaded` counts *decompressed* bytes, up to ~52 MB. So `loaded / total`
  reaches ~291% and the bar snaps to full almost immediately. Locally there's no
  gzip, so the two numbers agree. Fix by dividing against the known uncompressed
  size instead of `event.total`, or switch to an indeterminate spinner.
- **`videos.json` still contains 7 duplicate video IDs** (fixed in the script, not
  yet in the data). `dedupe_videos()` now collapses repeated ids during the merge,
  so the next run that finds new videos will clean these out on its own. Note the
  script returns early when there's nothing new, so a no-op run won't fix them.
- **Pagination overflows on narrow screens.** The `@media (max-width: 740px)` block
  only restyles the result cards. `.pagination` stays `display: flex` with no
  `flex-wrap`, so five buttons plus the page counter plus the results-per-page
  `<select>` run off the edge of a phone.
- **`highlightText()` builds a `RegExp` directly from user input** (`search.js`), so
  searching for `(`, `[`, or `*` throws. Escaping the token fixes it. Covered by a
  `todo` test.
- **Pagination controls stay enabled when a search returns nothing.** With 0 results
  `totalPages` is 0 while `currentPage` is 1, so the `currentPage === totalPages`
  checks never disable next/last, and the counter reads "Page 1 of 0". Covered by a
  `todo` test.
- **Results are injected via `innerHTML` without escaping.** The data comes from the
  YouTube API rather than from users, so this is low risk in practice, but a video
  description containing markup will render as markup.
- **The "contains any word" search is `.some()`** in `matchesQuery()`, despite an
  early commit message calling it "all". There is no all-words option — see the todo.

## Todo

As of the last review, **none of these have been done**:

- [ ] Deploy script. Probably obsolete — deploying is just `git push`.
- [ ] On initial load, show all videos in the results instead of an empty list.
- [ ] Fix the progress bar on GitHub Pages (cause diagnosed above).
- [ ] Fix results-per-page dropdown and pagination layout on small screens.
- [ ] Add a "contains all words" mode — a third radio in `index.html` plus an
      `.every()` branch alongside the existing `.some()`.
