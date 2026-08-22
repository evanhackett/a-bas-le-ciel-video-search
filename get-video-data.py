import os
import json
import random
import time
import argparse
from googleapiclient.discovery import build
from datetime import datetime
from youtube_transcript_api import (
    YouTubeTranscriptApi,
    AgeRestricted,
    NoTranscriptFound,
    PoTokenRequired,
    RequestBlocked,
    TranscriptsDisabled,
    VideoUnavailable,
    VideoUnplayable,
)
from youtube_transcript_api.proxies import WebshareProxyConfig
import requests


# Where the (gitignored) API key lives, alongside this script
CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'config.json')

# YouTube channel ID or URL
CHANNEL_ID = 'UCWPKJM4CT6ES2BrUz9wbELw'

# Placeholder stored when a video has no captions
NO_TRANSCRIPT = 'Transcript not available.'

# Reasons one particular video has no transcript. Deliberately excludes the
# blocking errors (RequestBlocked, IpBlocked, PoTokenRequired): those affect every
# video, so treating them as "no captions" would quietly overwrite videos.json with
# placeholder text for the whole run. Better to crash and lose the run.
# Do not replace this with the CouldNotRetrieveTranscript base class, which would
# swallow the blocking errors too.
NO_TRANSCRIPT_ERRORS = (
    TranscriptsDisabled,
    NoTranscriptFound,
    AgeRestricted,
    VideoUnavailable,
    VideoUnplayable,
)

# Failures that affect every video, not just one. IpBlocked subclasses
# RequestBlocked, so both are covered. The fetch loop stops on these and saves its
# progress rather than carrying on and recording placeholders.
BLOCKING_ERRORS = (RequestBlocked, PoTokenRequired)

# The same thing, arriving as a transport failure instead of a library exception.
# A proxied run does not usually get to raise RequestBlocked: WebshareProxyConfig
# mounts urllib3's Retry(total=retries_when_blocked, status_forcelist=[429]) with
# no backoff factor, so a 429 is retried ten times back to back — ten fresh proxy
# IPs spent in a fraction of a second — and when the last one is refused too,
# requests raises RetryError before youtube-transcript-api sees any response.
#
# The whole RequestException tree is here, not just RetryError, for the reason
# blocking errors are not caught as NO_TRANSCRIPT: a request that never completed
# is no evidence that a video lacks captions, and writing the placeholder for one
# would degrade videos.json.
TRANSPORT_ERRORS = (requests.exceptions.RequestException,)

# Everything that should end a run early, saving progress rather than crashing
RUN_ENDING_ERRORS = BLOCKING_ERRORS + TRANSPORT_ERRORS

# Partially completed runs are saved here so a block does not discard the work
CHECKPOINT_PATH = 'fetch-progress.json'

# How often to write the checkpoint, in videos. Every one: at a minute per video a
# batched write would risk throwing away ten minutes of work on a ctrl-c, and the
# file is a few KB per record, so writing it costs nothing next to the delay.
CHECKPOINT_EVERY = 1

# Pause between videos. YouTube blocks the IP if transcripts are requested too
# quickly, and a block costs far more time than the delay does.
#
# This number is a guess. YouTube publishes no rate limit for the transcript
# endpoint, because it is not a public API — youtube-transcript-api reads an
# internal one. Nothing validates this value; it is simply slower than rates that
# did get blocked: unthrottled first, then a flat 3 seconds. Raise it with --delay
# if blocks recur.
REQUEST_DELAY_SECONDS = 60.0

# Added on top of the delay, a fresh random amount before each video. A perfectly
# regular request every N seconds is a machine-shaped pattern, and rate limiters
# look for those; jitter smears it out. Also a guess — nothing here confirms that
# YouTube's limiter cares about regularity, only that it is cheap if it does.
REQUEST_JITTER_SECONDS = (1.0, 10.0)

# Pacing for --proxy runs, which go out through rotating residential IPs. The
# throttling above exists because every direct request comes from this one IP, and
# that is the thing YouTube counts; behind a rotating pool no single IP makes
# enough requests to look like a scraper, so a minute of waiting per video buys
# nothing.
#
# A guess again, and a softer one: 1 second is not a measured safe rate, it is
# simply not flat out. Webshare bills by bandwidth rather than by request, so going
# faster costs nothing extra there, but the IP pool is shared and hammering it is
# how those IPs end up blocked for everyone. Raise it with --delay if proxied runs
# start getting blocked.
PROXY_REQUEST_DELAY_SECONDS = 1.0
PROXY_REQUEST_JITTER_SECONDS = (0.0, 1.0)

# How many exit IPs to try per video before giving up, and how long to pause
# between draws. Every request through the rotating endpoint gets a fresh IP and
# only a minority of them are refused, so the cheapest answer to a blocked draw is
# to ask again rather than to wait.
#
# Measured, unlike the delays above: sampling 24 draws on 2026-08-21 found 2
# refused, so roughly 8% arrive blocked. Eight attempts puts a stall at 0.08**8,
# which is about one in seven hundred million videos. The measurement is small
# (24 samples) and pool health will drift, so treat 8% as an order of magnitude,
# not a constant.
PROXY_ATTEMPTS_PER_VIDEO = 8
PROXY_RETRY_PAUSE_SECONDS = 2.0

# Ceiling on a single HTTP request, in seconds. youtube-transcript-api sets no
# timeout anywhere (the word does not appear in the package) and requests defaults
# to None, which means wait forever — so one silent proxy connection hangs the whole
# run, with the checkpoint already written and nothing left to do but ctrl-c.
#
# A guess, but a safe direction: this is not tuning, it is putting any bound at all
# where there was none. 30s is far longer than a healthy fetch, which runs about
# 6s including the transcript. Applies to both connect and read; a timeout is a
# RequestException, so fetch_with_retries() treats it as a bad draw and redraws.
REQUEST_TIMEOUT_SECONDS = 30.0


def next_delay():
    """How long to wait before the next video: the delay plus a random top-up."""
    return REQUEST_DELAY_SECONDS + random.uniform(*REQUEST_JITTER_SECONDS)

# Used only by --check, to see whether requests are getting through at all
PROBE_VIDEO_ID = 'hoxM7jBBlaU'

# Whether transcript requests go out through Webshare's residential proxies.
# Set from --proxy before anything is fetched; see get_transcript_api().
USE_PROXIES = False


def load_api_key():
    """Return the YouTube Data API key from $YOUTUBE_API_KEY or config.json."""
    key = os.environ.get('YOUTUBE_API_KEY')
    if key:
        return key

    try:
        with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
            key = json.load(f).get('youtube_api_key')
    except FileNotFoundError:
        raise SystemExit(
            'No API key found. Copy config.example.json to config.json and put your\n'
            'YouTube Data API key in it, or set the YOUTUBE_API_KEY environment variable.'
        )
    except json.JSONDecodeError as e:
        raise SystemExit(f'config.json is not valid JSON: {e}')

    if not key or key.startswith('PASTE_'):
        raise SystemExit(f'config.json has no "youtube_api_key" value set ({CONFIG_PATH}).')

    return key


def load_proxy_credentials():
    """Webshare proxy username and password, from the environment or config.json.

    Same two sources as the API key, in the same order, so there is one story for
    where secrets live. These are the "Proxy Username" and "Proxy Password" from
    https://dashboard.webshare.io/proxy/settings, not the account login.
    """
    username = os.environ.get('WEBSHARE_PROXY_USERNAME')
    password = os.environ.get('WEBSHARE_PROXY_PASSWORD')

    if not (username and password):
        try:
            with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
                config = json.load(f)
        except FileNotFoundError:
            config = {}
        except json.JSONDecodeError as e:
            raise SystemExit(f'config.json is not valid JSON: {e}')

        username = username or config.get('webshare_proxy_username')
        password = password or config.get('webshare_proxy_password')

    missing = [
        name for name, value in (('username', username), ('password', password))
        if not value or str(value).startswith('PASTE_')
    ]
    if missing:
        raise SystemExit(
            f'--proxy needs Webshare credentials, but the proxy '
            f'{" and ".join(missing)} '
            f'{"are" if len(missing) > 1 else "is"} not set.\n'
            f'Put webshare_proxy_username and webshare_proxy_password in '
            f'{CONFIG_PATH} (see config.example.json), or set '
            'WEBSHARE_PROXY_USERNAME and WEBSHARE_PROXY_PASSWORD.\n'
            'They are the "Proxy Username" and "Proxy Password" from '
            'https://dashboard.webshare.io/proxy/settings, not your account login.'
        )

    return username, password


def build_proxy_config():
    """A Webshare rotating-residential proxy config, or None for a direct run.

    Only the "Residential" package rotates. "Proxy Server" and "Static
    Residential" hand out fixed IPs, which is the situation this exists to escape:
    they would get blocked exactly like a home IP does, only with a bill attached.
    """
    if not USE_PROXIES:
        return None

    username, password = load_proxy_credentials()
    # retries_when_blocked=0 disables the library's own retry, which does not do
    # what its name promises here. A refused draw is answered with a 302 to
    # google.com/sorry, requests follows it, and urllib3's Retry then fires against
    # the block page — ten requests for /sorry, which returns 429 for anyone,
    # rather than one fresh attempt at the video. It burns the budget without ever
    # redrawing an IP. fetch_with_retries() below does the redrawing instead.
    return WebshareProxyConfig(
        proxy_username=username,
        proxy_password=password,
        retries_when_blocked=0,
    )


_transcript_api = None


def get_transcript_api():
    """One shared client, so its HTTP session is reused across videos.

    The client reads USE_PROXIES when it is built, so that flag has to be settled
    before the first transcript request.
    """
    global _transcript_api
    if _transcript_api is None:
        _transcript_api = YouTubeTranscriptApi(
            proxy_config=build_proxy_config(),
            http_client=TimeoutSession(),
        )
    return _transcript_api


class TimeoutSession(requests.Session):
    """A Session that refuses to wait forever.

    requests takes a timeout per call, and youtube-transcript-api never passes one,
    so the only place to put a default is the Session itself. The library mutates
    whatever client it is handed — proxies, headers, adapters — but it does not
    replace it, so this override survives.
    """

    def request(self, *args, **kwargs):
        kwargs.setdefault('timeout', REQUEST_TIMEOUT_SECONDS)
        return super().request(*args, **kwargs)


def reset_transcript_api():
    """Drop the client so the next request opens a new connection.

    Webshare hands out an exit IP per connection, so a fresh client is a fresh
    draw from the pool.
    """
    global _transcript_api
    _transcript_api = None


def fetch_with_retries(video_id):
    """Fetch one transcript, redrawing an exit IP when a draw comes back blocked.

    Only proxied runs retry. Retrying a direct run would be pointless and rude:
    there is one IP, YouTube has just refused it, and asking again is how the IP
    got blocked in the first place.
    """
    attempts = PROXY_ATTEMPTS_PER_VIDEO if USE_PROXIES else 1

    for attempt in range(1, attempts + 1):
        try:
            return get_transcript_api().fetch(video_id)
        except RUN_ENDING_ERRORS as error:
            if attempt == attempts:
                raise
            print(f'  blocked draw ({type(error).__name__}); '
                  f'redrawing an IP [{attempt + 1}/{attempts}]')
            reset_transcript_api()
            time.sleep(PROXY_RETRY_PAUSE_SECONDS)


def fetch_transcript(video_id):
    """Transcript text for one video, or NO_TRANSCRIPT if it genuinely has none.

    Blocking errors are not caught here on purpose; see NO_TRANSCRIPT_ERRORS.
    """
    try:
        fetched = fetch_with_retries(video_id)
    except NO_TRANSCRIPT_ERRORS as error:
        print(f'Transcript not available ({type(error).__name__}).')
        return NO_TRANSCRIPT

    return ' '.join(snippet.text for snippet in fetched)


def check_block_status():
    """Make a single transcript request to see whether this IP is blocked.

    There is no API for block status, and YouTube does not say how long a block
    lasts, so asking once and seeing what comes back is the only way to know.
    Returns True if requests are getting through.
    """
    try:
        get_transcript_api().fetch(PROBE_VIDEO_ID)
    except TRANSPORT_ERRORS as error:
        # A 429 wave looks like this rather than like RequestBlocked; see TRANSPORT_ERRORS
        print(f'BLOCKED, or the proxy is refusing requests ({type(error).__name__}).')
        return False
    except BLOCKING_ERRORS as error:
        print(f'BLOCKED ({type(error).__name__}). Wait longer before running again.')
        return False
    except NO_TRANSCRIPT_ERRORS as error:
        # The probe video lost its captions, but the request itself got through
        print(f'Not blocked. (Probe video has no transcript: {type(error).__name__}.)')
        return True

    print('Not blocked. Transcript requests are getting through.')
    return True


# Function to get video details
def get_video_details(youtube, video_id):
    print('fetching video data for video_id:', video_id)

    request = youtube.videos().list(
        part="snippet,contentDetails",
        id=video_id
    )
    response = request.execute()

    if "items" not in response or not response["items"]:
        return None

    item = response["items"][0]

    title = item["snippet"]["title"]
    description = item["snippet"]["description"]
    date = item["snippet"]["publishedAt"]
    date = datetime.strptime(date, '%Y-%m-%dT%H:%M:%S%z').strftime('%Y%m%d%H%M%S')
    video_url = f"https://www.youtube.com/watch?v={video_id}"
    # Extract the high-quality thumbnail URL if available, fallback to default if not
    thumbnail_url = item["snippet"]["thumbnails"].get("high", {}).get("url", item["snippet"]["thumbnails"]["default"]["url"])



    transcript = fetch_transcript(video_id)

    return {
        "id": video_id,
        "url": video_url,
        "title": title,
        "description": description,
        "upload_date": date,
        "transcript": transcript,
        "thumbnail":thumbnail_url,
    }


def get_uploads_playlist_id(youtube, channel_id):
    """The playlist that lists every video the channel has published."""
    response = youtube.channels().list(part='contentDetails', id=channel_id).execute()

    items = response.get('items')
    if not items:
        raise SystemExit(f'Channel {channel_id} not found.')

    return items[0]['contentDetails']['relatedPlaylists']['uploads']


def list_all_video_ids(youtube, playlist_id):
    """Every video id on the channel, newest first.

    Deliberately uses the uploads playlist rather than search.list. search is a
    relevance-ranked index that is not guaranteed to return every video, and it
    costs 100 quota units per page where playlistItems costs 1.
    """
    video_ids = []
    page_token = None

    while True:
        response = youtube.playlistItems().list(
            part='contentDetails',
            playlistId=playlist_id,
            maxResults=50,
            pageToken=page_token,
        ).execute()

        for item in response['items']:
            video_ids.append(item['contentDetails']['videoId'])

        page_token = response.get('nextPageToken')
        if not page_token:
            return video_ids


def load_checkpoint():
    """Videos already fetched by a run that was interrupted."""
    if not os.path.exists(CHECKPOINT_PATH):
        return []

    with open(CHECKPOINT_PATH, 'r', encoding='utf-8') as f:
        return json.load(f)


def save_checkpoint(videos):
    """Write the checkpoint atomically, so an interrupted write cannot corrupt it."""
    temp_path = CHECKPOINT_PATH + '.tmp'
    with open(temp_path, 'w', encoding='utf-8') as f:
        json.dump(videos, f, ensure_ascii=False)
    os.replace(temp_path, CHECKPOINT_PATH)


def clear_checkpoint():
    if os.path.exists(CHECKPOINT_PATH):
        os.remove(CHECKPOINT_PATH)


def fetch_videos(youtube, video_ids, already_fetched):
    """Fetch each video in turn, checkpointing as it goes.

    Returns (fetched, error). A run-ending error is handed back rather than raised
    so the caller can save progress and say how to resume; everything fetched
    before it is kept.
    """
    fetched = []
    total = len(video_ids)

    for index, video_id in enumerate(video_ids, start=1):
        try:
            details = get_video_details(youtube, video_id)
        except RUN_ENDING_ERRORS as error:
            save_checkpoint(already_fetched + fetched)
            return fetched, error

        if details:
            print(f'  [{index}/{total}] {details["upload_date"]} - {details["title"][:60]}')
            fetched.append(details)
        else:
            print(f'  [{index}/{total}] {video_id}: no details returned, skipping.')

        if index % CHECKPOINT_EVERY == 0:
            save_checkpoint(already_fetched + fetched)

        if index < total:
            delay = next_delay()
            # Said out loud because a minute of silence otherwise looks like a hang
            print(f'  waiting {delay:.1f}s...')
            time.sleep(delay)

    return fetched, None


def describe_run_ending_error(error):
    """What stopped the run, and what to do about it.

    The two cases want different advice: a RequestBlocked means this IP is in
    trouble and needs to sit out, while a proxied failure means every one of the
    redraws was refused, which is about pool health rather than pace.
    """
    name = type(error).__name__

    if isinstance(error, TRANSPORT_ERRORS):
        if USE_PROXIES:
            message = (
                f'All {PROXY_ATTEMPTS_PER_VIDEO} exit IPs drawn for this video were '
                f'refused ({name}).\n'
                'A longer --delay will not help — the pace is not what decides this, '
                'the draw is.\n'
                'The pool is unusually blocked right now; rerun later, or raise '
                'PROXY_ATTEMPTS_PER_VIDEO.'
            )
        else:
            message = (
                f'The request failed at the network level ({name}).\n'
                'Check the connection, or try --proxy.'
            )

        # The host in a requests error is the whole diagnosis: www.google.com means
        # YouTube served its block page, while the proxy host means Webshare itself
        # refused (out of bandwidth, or over an account rate limit). The class name
        # alone makes those two look identical. It goes on its own line because it
        # is long enough to shred the sentence if inlined.
        detail = str(error).strip()
        return f'{message}\n  detail: {detail[:300]}' if detail else message

    if USE_PROXIES:
        return (
            f'YouTube blocked the request ({name}), through the proxies.\n'
            'Resume with a longer pause, e.g. --proxy --delay 5.'
        )

    return (
        f'YouTube blocked the request ({name}).\n'
        'Wait for the block to clear before running again — or use --proxy.'
    )


def dedupe_videos(videos):
    """Collapse records sharing a video id, keeping the freshest one.

    Later records win: the merge appends newly-fetched videos after the existing
    ones, and a re-fetch has the current title and a stable (unsigned) thumbnail
    URL. The one exception is transcripts — a record that came back without
    captions never clobbers one that already has them.
    """
    by_id = {}
    for video in videos:
        previous = by_id.get(video['id'])
        if (previous
                and video['transcript'] == NO_TRANSCRIPT
                and previous['transcript'] != NO_TRANSCRIPT):
            # Take the fresher metadata but hold on to the transcript we have
            video = {**video, 'transcript': previous['transcript']}
        by_id[video['id']] = video
    return list(by_id.values())


def load_existing_videos():
    with open('videos.json', 'r', encoding='utf-8') as f:
        existing_videos = json.load(f)

    # The seed dataset stored YYYYMMDD; widen it so sorting and comparison work
    for video in existing_videos:
        if len(video['upload_date']) == 8:
            video['upload_date'] += '000000'

    return existing_videos


def main():
    existing_videos = load_existing_videos()

    checkpoint = load_checkpoint()
    if checkpoint:
        print(f'resuming an interrupted run: {len(checkpoint)} video(s) already fetched.')

    known_ids = {v['id'] for v in existing_videos} | {v['id'] for v in checkpoint}

    youtube = build('youtube', 'v3', developerKey=load_api_key())
    uploads_playlist = get_uploads_playlist_id(youtube, CHANNEL_ID)
    all_ids = list_all_video_ids(youtube, uploads_playlist)

    # Diffing ids rather than resuming from the newest stored date. A video the
    # old approach missed fell permanently behind the cutoff and was never
    # retried; this picks it up on the next run instead.
    missing_ids = [video_id for video_id in all_ids if video_id not in known_ids]

    print(f'channel has {len(all_ids)} videos; '
          f'{len(known_ids)} already held; {len(missing_ids)} to fetch.')

    if not missing_ids and not checkpoint:
        print('nothing to do.')
        return

    if missing_ids:
        # Time spent sleeping only; the requests themselves add to this
        average_delay = REQUEST_DELAY_SECONDS + sum(REQUEST_JITTER_SECONDS) / 2
        hours = (len(missing_ids) - 1) * average_delay / 3600
        print(f'at ~{average_delay:.0f}s between videos that is roughly {hours:.1f}h '
              f'of waiting. Progress is saved as it goes; ctrl-c is safe.')

    newly_fetched, run_ending_error = fetch_videos(youtube, missing_ids, checkpoint)
    all_new = checkpoint + newly_fetched

    if run_ending_error:
        # fetch_videos saves before returning; repeat it here so the guarantee
        # does not depend on which function noticed the block
        save_checkpoint(all_new)
        raise SystemExit(
            f'\n{describe_run_ending_error(run_ending_error)}\n'
            f'{len(all_new)} video(s) saved to {CHECKPOINT_PATH}; nothing was lost.\n'
            'Run this script again to carry on from where it stopped.'
        )

    # Merge existing videos with new videos, collapsing any repeated ids
    merged = existing_videos + all_new
    all_videos = dedupe_videos(merged)

    removed = len(merged) - len(all_videos)
    if removed:
        print('removed', removed, 'duplicate record(s).')

    # Sort videos in reverse chronological order
    all_videos_sorted = sorted(all_videos, key=lambda x: x['upload_date'], reverse=True)

    with open('updated_videos.json', 'w', encoding='utf-8') as f:
        json.dump(all_videos_sorted, f, ensure_ascii=False, indent=4)

    clear_checkpoint()
    print(f'wrote {len(all_videos_sorted)} videos to updated_videos.json')
    print('promote it with:  mv updated_videos.json videos.json')
    print('then refresh the cache fingerprint:  python3 write-version.py')
    print('Make sure to refresh the cache AFTER promoting the new videos.json file, otherwise write-version.py will be working off the old json.')


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description='Fetch missing videos and transcripts into updated_videos.json.',
    )
    parser.add_argument(
        '--check',
        action='store_true',
        help='make one request to see whether YouTube is blocking this IP, then exit',
    )
    parser.add_argument(
        '--proxy',
        action='store_true',
        help='route transcript requests through Webshare residential proxies '
             'instead of this machine\'s IP (needs Webshare credentials)',
    )
    parser.add_argument(
        '--delay',
        type=float,
        default=None,
        metavar='SECONDS',
        help=f'pause between videos (default: {REQUEST_DELAY_SECONDS:g}, '
             f'or {PROXY_REQUEST_DELAY_SECONDS:g} with --proxy)',
    )
    return parser.parse_args(argv)


def resolve_pacing(args):
    """The (delay, jitter) a run should use, given the flags.

    An explicit --delay always wins. Otherwise --proxy picks the much shorter
    proxied pacing, since the long pause is there to protect one IP and a proxied
    run is not using one.
    """
    if args.proxy:
        default_delay, jitter = PROXY_REQUEST_DELAY_SECONDS, PROXY_REQUEST_JITTER_SECONDS
    else:
        default_delay, jitter = REQUEST_DELAY_SECONDS, REQUEST_JITTER_SECONDS

    return (default_delay if args.delay is None else args.delay), jitter


if __name__ == "__main__":
    args = parse_args()

    # Before anything fetches: get_transcript_api() reads this when it builds the
    # client, and --check fetches too
    USE_PROXIES = args.proxy
    if USE_PROXIES:
        print('using Webshare residential proxies.')

    if args.check:
        raise SystemExit(0 if check_block_status() else 1)

    REQUEST_DELAY_SECONDS, REQUEST_JITTER_SECONDS = resolve_pacing(args)
    main()
