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


def next_delay():
    """How long to wait before the next video: the delay plus a random top-up."""
    return REQUEST_DELAY_SECONDS + random.uniform(*REQUEST_JITTER_SECONDS)

# Used only by --check, to see whether requests are getting through at all
PROBE_VIDEO_ID = 'hoxM7jBBlaU'


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


_transcript_api = None


def get_transcript_api():
    """One shared client, so its HTTP session is reused across videos."""
    global _transcript_api
    if _transcript_api is None:
        _transcript_api = YouTubeTranscriptApi()
    return _transcript_api


def fetch_transcript(video_id):
    """Transcript text for one video, or NO_TRANSCRIPT if it genuinely has none.

    Blocking errors are not caught here on purpose; see NO_TRANSCRIPT_ERRORS.
    """
    try:
        fetched = get_transcript_api().fetch(video_id)
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

    Returns (fetched, blocking_error). A blocking error is handed back rather than
    raised so the caller can save progress and say how to resume; everything
    fetched before it is kept.
    """
    fetched = []
    total = len(video_ids)

    for index, video_id in enumerate(video_ids, start=1):
        try:
            details = get_video_details(youtube, video_id)
        except BLOCKING_ERRORS as error:
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

    newly_fetched, blocking_error = fetch_videos(youtube, missing_ids, checkpoint)
    all_new = checkpoint + newly_fetched

    if blocking_error:
        # fetch_videos saves before returning; repeat it here so the guarantee
        # does not depend on which function noticed the block
        save_checkpoint(all_new)
        raise SystemExit(
            f'\nYouTube blocked the request ({type(blocking_error).__name__}).\n'
            f'{len(all_new)} video(s) saved to {CHECKPOINT_PATH}; nothing was lost.\n'
            'Wait for the block to clear, then run this script again to carry on '
            'from where it stopped.'
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
        '--delay',
        type=float,
        default=REQUEST_DELAY_SECONDS,
        metavar='SECONDS',
        help='pause between videos (default: %(default)s)',
    )
    return parser.parse_args(argv)


if __name__ == "__main__":
    args = parse_args()

    if args.check:
        raise SystemExit(0 if check_block_status() else 1)

    REQUEST_DELAY_SECONDS = args.delay
    main()
