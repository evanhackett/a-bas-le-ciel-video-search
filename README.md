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
| `help.html` | Static explainer for the three search modes. No JS; shares `styles.css`. |
| `search.js` | Pure logic: matching, tokenizing, date formatting, highlighting. No DOM. |
| `main.js` | DOM: fetches `videos.json`, renders results, paginates, wires events. |
| `styles.css` | All styling. |
| `videos.json` | **The dataset.** ~53 MB, one object per video. |

`loadVideoData()` XHRs `videos.json` into a module-level array, then `searchVideos()`
filters it with plain substring matching over whichever of
title / description / transcript you've checked, in one of three modes —
`exact` (the phrase verbatim), `all` (every word, any order) or `any` (at least one
word). Matching is substring rather than word-boundary in all three, so "cat"
matches "catastrophe". `help.html` explains the difference for readers of the site;
keep it in step when the matching rules change. There is no search index — it's a
linear scan over every video on every query. At the current dataset size that's
fast enough to feel instant.

The split exists so the matching logic can be tested without a browser. Keep
`search.js` free of DOM access; everything that touches the page belongs in
`main.js`. Event handlers are attached in `wireEvents()` — do not add inline
`onclick` attributes, as module scope is not global and they will not resolve.

### Why the progress bar uses a constant

`loadVideoData()` sizes the bar against `EXPECTED_BYTES` in `main.js`, not against
`event.total`. GitHub Pages serves `videos.json` gzipped, so `event.total` is the
compressed length while `event.loaded` counts decompressed bytes — verified with
`curl`, which reports `content-encoding: gzip` and `content-length: 17969259`
against 52258072 uncompressed. Measuring one against the other reaches 100% about a
third of the way through the download. No response header carries the uncompressed
size.

The constant is the same number in both environments, which is why it works on
Pages and on a local server alike. **When `videos.json` grows, a test fails and
tells you the value to paste in** — that guard is what makes hardcoding a size safe
rather than a slow leak. The tolerance is 5%.

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

Tests can be marked `todo`: they describe behaviour that is known to be wrong and
are reported without failing the run, then flip to passing when the bug is fixed.
There are none at the moment — the three that existed (the regex-injection bug in
`highlightText()`, the progress bar exceeding 100% on GitHub Pages, and the
pagination buttons staying enabled on an empty result set) were fixed and their
tests promoted. It is a good pattern for a bug you are not fixing today.

`test_data_integrity.py` runs against the real 53 MB dataset, so it catches
problems the unit tests cannot — malformed dates, mismatched URLs, duplicate ids.
It passes as of the 2026-08-21 backfill, which merged away the last 7 duplicates.

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

With `--proxy` this stops being a waiting game at all; see
[fetching through residential proxies](#fetching-through-residential-proxies).

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

If blocks keep happening, raise `--delay` further — or stop fighting the rate
limit from one IP and use [`--proxy`](#fetching-through-residential-proxies). The
checkpointing, not the delay, is what actually protects a long run.

### Fetching through residential proxies

```bash
python get-video-data.py --proxy
```

Sends transcript requests through Webshare's rotating residential proxies instead
of this machine's IP. This is what `youtube-transcript-api` itself recommends for
exactly this problem, and it addresses the cause rather than the symptom: the
delay exists because every request comes from one IP and that is what YouTube
counts. Behind a rotating pool no single IP makes enough requests to look like a
scraper, and a blocked IP is not *your* IP — the library retries, the pool rotates,
and the run carries on.

It changes the pacing accordingly. `--proxy` drops the default pause from 60
seconds to 1 (plus 0–1s of jitter), which turns a several-hundred-video backlog
from an overnight run into a few minutes. `--delay` still overrides it in either
mode:

```bash
python get-video-data.py --proxy --delay 5
```

Caveats worth knowing before you buy anything:

- **The package matters.** You need Webshare's **Residential** package. "Proxy
  Server" and "Static Residential" give fixed exit IPs, which get blocked exactly
  like a home IP does, only with a bill attached.
- **1 second is still a guess**, like the 60. It is not a measured safe rate,
  merely not flat out. Webshare bills bandwidth rather than requests, so speed
  costs nothing there, but the IP pool is shared and hammering it is how its IPs
  get blocked for everyone.
- **Blocks are still possible**, and they look different through a proxy — see
  [when a proxied run gets blocked](#when-a-proxied-run-gets-blocked). Everything
  that protected a direct run still applies: the checkpoint, the resume, the
  refusal to record a block as "no captions".
- **Only transcripts go through the proxy.** The YouTube Data API calls (the
  channel listing and per-video metadata) are authenticated with your key and go
  out directly. They were never the thing getting blocked.

Credentials are set up alongside the API key — see [API key](#api-key).

#### When a proxied run gets blocked

A proxied block does **not** arrive as `RequestBlocked`. It arrives as
`requests.RetryError`, with `host='www.google.com'` and `too many 429 error
responses` — which is why `TRANSPORT_ERRORS` (the whole `requests.RequestException`
tree) ends a run the same way a blocking error does: save the checkpoint, explain,
stop. It is emphatically *not* caught as "this video has no captions", for the
reason in
[why transcript errors are not all caught](#why-transcript-errors-are-not-all-caught).

**Neither waiting nor slowing down helps**, and both were tried. Three runs:
1.3s pacing reached 145 videos, an immediate rerun died on video 1, and `--delay 10`
managed 43. More delay, fewer videos.

The pace was never what decided it. Every request through the rotating endpoint
draws a fresh exit IP, and a minority of those are already refused by YouTube —
sampling 24 draws found 2 blocked, so on the order of 8%. What made one bad draw
fatal was `retries_when_blocked`, which does not do what its name promises. A
refused draw gets a 302 to `google.com/sorry`; `requests` follows the redirect; and
urllib3's `Retry` then fires **against the block page**, requesting `/sorry` ten
times — a URL that returns 429 for everyone, on any IP. The retry budget was spent
without ever redrawing an IP, so a single unlucky draw ended the run.

So the library's retry is disabled (`retries_when_blocked=0`) and
`fetch_with_retries()` does the work instead: on a refusal it drops the client —
Webshare binds an exit IP to a connection, so a new client is a new draw — and asks
again, up to `PROXY_ATTEMPTS_PER_VIDEO` (8) times. At an 8% refusal rate that puts
a stall at `0.08**8`, roughly one in seven hundred million videos.

You will see the redraws in the output, and they are not a problem:

```
  blocked draw (RetryError); redrawing an IP [2/8]
```

If a run *does* stall now, the pool is having a genuinely bad day. Rerun later or
raise `PROXY_ATTEMPTS_PER_VIDEO` — do not reach for `--delay`.

#### Why there is a timeout

`youtube-transcript-api` passes no timeout on any request — the word does not appear
anywhere in the package — and `requests` defaults to `None`, which means wait
forever. A single proxy connection going quiet is therefore enough to hang a run
indefinitely, which is exactly what happened with one video left to fetch: the
checkpoint was already safe, but there was nothing to do except ctrl-c.

`TimeoutSession` puts a `REQUEST_TIMEOUT_SECONDS` (30) default on every request and
is handed to the client as `http_client`. The library mutates that session — proxies,
headers, adapters — but never replaces it, so the override survives. A timeout is a
`RequestException`, so a hung draw becomes just another bad draw and gets redrawn.

`--check` honours the flag too, which is the quickest way to confirm the
credentials work:

```bash
python get-video-data.py --proxy --check
```

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

Blocking errors — `RequestBlocked`, `IpBlocked`, `PoTokenRequired` — and transport
failures — anything under `requests.RequestException`, which is how a proxied 429
wave arrives — are deliberately left to end the run. They affect *every* video, so treating one as
"no captions" would write placeholder text over real transcripts for the entire
batch and silently degrade `videos.json`. A request that never completed says
nothing about a video's captions either. A lost run is cheap; a corrupted dataset
is not. For the same reason, do not simplify that tuple to the
`CouldNotRetrieveTranscript` base class, which would catch the blocking errors too.

`fetch_videos()` catches the run-ending ones one level up, so they checkpoint and
exit with instructions instead of a traceback — that is the difference between a
rerun and a puzzle.

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

### Webshare proxy credentials

Only needed for [`--proxy`](#fetching-through-residential-proxies). Same two
sources as the API key, in the same order:

1. the `WEBSHARE_PROXY_USERNAME` and `WEBSHARE_PROXY_PASSWORD` environment variables
2. `config.json` sitting next to the script

```json
{
  "webshare_proxy_username": "PASTE_YOUR_WEBSHARE_PROXY_USERNAME_HERE",
  "webshare_proxy_password": "PASTE_YOUR_WEBSHARE_PROXY_PASSWORD_HERE"
}
```

These are the **Proxy Username** and **Proxy Password** from the
[Webshare proxy settings page](https://dashboard.webshare.io/proxy/settings) — not
your account login, and not an API token. Buy the **Residential** package; the
other two products hand out fixed IPs and defeat the point. Without `--proxy` the
two fields can be missing entirely; the script never reads them.

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

- **Results are injected via `innerHTML` without escaping.** The data comes from the
  YouTube API rather than from users, so this is low risk in practice, but a video
  description containing markup will render as markup.

## Todo

As of the last review, **none of these have been done**:

- [ ] Deploy script. Probably obsolete — deploying is just `git push`.
- [ ] On initial load, show all videos in the results instead of an empty list.
- [x] Fix the progress bar on GitHub Pages — done; it measures against
      `EXPECTED_BYTES` rather than the compressed `Content-Length`.
- [x] Fix results-per-page dropdown and pagination layout on small screens — done;
      the media query now wraps the row into counter / buttons / select.
- [x] Add a "contains all words" mode — done; `matchesQuery()` now switches on
      `options.mode` (`'exact' | 'any' | 'all'`).
