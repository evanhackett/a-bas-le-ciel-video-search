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

First time on a fresh clone:

```bash
npm install                                    # JS test deps (jsdom)
venv/bin/pip install -r requirements-dev.txt   # Python test deps (pytest)
```

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

`get-video-data.py` works out which videos are missing, fetches them with their
transcripts, merges everything, and sorts reverse-chronologically.

```bash
cd my-site
source venv/bin/activate
python get-video-data.py
```

First run on a fresh clone? Set up the API key first — see [API key](#api-key) below.

It prints how many videos the channel has, how many are already held and how many
it will fetch, then a line per video. If nothing is missing it says so and exits
without writing anything.

### How it decides what to fetch

It lists every video id on the channel and subtracts the ids already in
`videos.json`. It does **not** resume from the newest stored date.

That matters. The date-cutoff version asked `search.list` for videos published
after `max(upload_date)`, and `search.list` is a relevance-ranked index that is not
guaranteed to return everything. Anything it missed fell behind the cutoff on the
next run and was never retried — 18 videos had been silently stranded that way.
Diffing ids has no such blind spot: a video missed today is simply picked up
tomorrow.

The id list comes from the channel's uploads playlist, which is authoritative and
costs 1 quota unit per 50 videos where `search.list` costs 100.

### Interrupted runs resume

YouTube rate-limits transcript requests and will block your IP if you ask too
quickly, so the script sleeps between videos (see [about the delay](#about-the-delay))
and saves its progress to `fetch-progress.json` after every video.

If a block happens, the script saves what it has, tells you, and stops without
writing `updated_videos.json`. Wait for the block to clear — it can take hours —
then run the script again and it carries on from where it stopped. Nothing is
re-fetched and nothing is lost. The checkpoint is deleted once a run completes.

A block is not treated as "this video has no captions"; see
[why transcript errors are not all caught](#why-transcript-errors-are-not-all-caught).

### Checking whether you are still blocked

```bash
python get-video-data.py --check     # one request; exits 0 if clear, 1 if blocked
```

There is no API for block status, and YouTube does not publish how long a block
lasts, so a single request is the only way to find out. Use this rather than
starting a real run to test the water. Because it sets an exit code you can poll
with it:

```bash
until python get-video-data.py --check; do sleep 1800; done && python get-video-data.py
```

Don't poll aggressively — every probe is another request from an IP that is
already in trouble. Every half hour is plenty.

### About the delay

```bash
python get-video-data.py --delay 90   # seconds between videos
```

Each pause is `REQUEST_DELAY_SECONDS` (default 60) plus a random 1–10 seconds
drawn fresh each time, so requests do not arrive on an exact metronome. Roughly a
minute per video, so a few hundred videos is an overnight run; the script prints
an estimate before it starts.

**Both numbers are guesses.** YouTube publishes no rate limit for the transcript
endpoint, because it is not a public API — `youtube-transcript-api` reads an
internal one, and getting blocked is that endpoint behaving as intended rather
than a bug. Nothing here validates either value:

- **60 seconds** is only known to be slower than two rates that did get blocked —
  unthrottled, and a flat 3 seconds. It is not known to be slow *enough*.
- **The jitter** assumes the limiter notices perfectly regular traffic. That is a
  common way to build one, but unverified here. It is cheap insurance either way.

If blocks keep happening, raise `--delay` further. The checkpointing, not the
delay, is what actually protects a long run.

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

### Rebuilding the environment

`requirements.txt` is pinned, so a fresh environment is reproducible:

```bash
python3 -m venv venv
venv/bin/pip install -r requirements.txt
venv/bin/pip install -r requirements-dev.txt   # only needed to run the tests
```

`venv/` is gitignored and is not a backup of anything — the pins are.

**Bump versions deliberately, then run the tests.** Leaving this file unpinned is
how the script broke once already: `youtube-transcript-api` 1.0 removed the static
`get_transcript()` it called, and because the venv was never rebuilt, nothing
surfaced the breakage until someone tried to run it. Pinning stops an install from
changing behaviour, but it does not freeze YouTube — a version that works today can
stop working, so if transcripts start failing, upgrading is the first thing to try.

### Why transcript errors are not all caught

`fetch_transcript()` catches only the per-video reasons a transcript is missing
(`TranscriptsDisabled`, `NoTranscriptFound`, `AgeRestricted`, `VideoUnavailable`,
`VideoUnplayable`) and records the placeholder for them.

Blocking errors — `RequestBlocked`, `IpBlocked`, `PoTokenRequired` — are
deliberately left to crash the run. They affect *every* video, so treating one as
"no captions" would write placeholder text over real transcripts for the entire
batch and silently degrade `videos.json`. A lost run is cheap; a corrupted dataset
is not. For the same reason, do not simplify that tuple to the
`CouldNotRetrieveTranscript` base class, which would catch the blocking errors too.

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
it to that one API — this script only calls `channels.list`, `playlistItems.list`
and `videos.list`, so a restricted key limits the damage if it does leak. Don't add
an HTTP-referrer restriction; that's for browser keys and will break a
command-line script.

If no key is found the script exits with a message telling you which of the two to
set, rather than failing somewhere deep in an API call.

Quota, against a 10,000 units/day default budget: enumerating the whole channel
costs about 1 unit per 50 videos (~62 for 3,000 videos), plus 1 unit per video
fetched. Quota is not the constraint — **YouTube's transcript rate limiting is**,
and that has no quota cost at all. A long backlog will be slow, and a block is
likelier than running out of units.

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
- **`fetch-progress.json`** — checkpoint from an interrupted fetch. Leave it alone
  and rerun the script to resume; it is deleted automatically on success. Deleting
  it by hand only means re-fetching those videos.
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
