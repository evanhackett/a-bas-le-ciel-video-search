import os
import json
import requests
from googleapiclient.discovery import build
from datetime import datetime, timedelta
from youtube_transcript_api import YouTubeTranscriptApi
from youtube_transcript_api._errors import NoTranscriptFound, TranscriptsDisabled


# Where the (gitignored) API key lives, alongside this script
CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'config.json')

# YouTube channel ID or URL
CHANNEL_ID = 'UCWPKJM4CT6ES2BrUz9wbELw'

# Placeholder stored when a video has no captions
NO_TRANSCRIPT = 'Transcript not available.'


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



    transcript = ""
    try:
        transcript_list = YouTubeTranscriptApi.get_transcript(video_id)
        transcript = " ".join([t['text'] for t in transcript_list])
    except (NoTranscriptFound, TranscriptsDisabled):
        print('Transcript not available.')
        transcript = NO_TRANSCRIPT

    return {
        "id": video_id,
        "url": video_url,
        "title": title,
        "description": description,
        "upload_date": date,
        "transcript": transcript,
        "thumbnail":thumbnail_url,
    }


# Function to get new videos from the channel after a certain date
def get_new_videos_from_channel(channel_id, published_after):
    youtube = build('youtube', 'v3', developerKey=load_api_key())

    # Convert published_after to ISO 8601 format
    # Also add 1 second so we don't get a video that we already have
    published_after = datetime.strptime(published_after, '%Y%m%d%H%M%S') + timedelta(seconds=1)
    published_after = published_after.isoformat("T") + "Z"
    print('published_after:', published_after)

    video_list = []
    next_page_token = None

    while True:
        search_request = youtube.search().list(
            part="snippet",
            channelId=channel_id,
            publishedAfter=published_after,
            maxResults=50,
            pageToken=next_page_token,
            type="video"
        )
        search_response = search_request.execute()

        print('Found', len(search_response["items"]), 'new videos in this page.')

        for item in search_response["items"]:
            video_id = item["id"]["videoId"]
            video_details = get_video_details(youtube, video_id)
            if not video_details:
                # Video went private/deleted between the search and the lookup
                print('no details returned for', video_id, '- skipping.')
                continue
            print(video_details['upload_date'], '-', video_details['title'])
            video_list.append(video_details)

        next_page_token = search_response.get("nextPageToken")
        if next_page_token:
            print('next_page_token true. Continuing...')
        else:
            print('next_page_token false. Breaking out of loop.')
            break

    return video_list

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


def main():
    # Load existing video data
    with open('videos.json', 'r', encoding='utf-8') as f:
        existing_videos = json.load(f)

    # Ensure all existing videos have the correct date format
    for video in existing_videos:
        if len(video['upload_date']) == 8:
            video['upload_date'] += "000000"  # Append time as 000000 if missing


    # Get the latest date from existing videos
    if existing_videos:
        last_date = max(video['upload_date'] for video in existing_videos)
    else:
        last_date = '00000000000000'

    print('last date is:', last_date)

    # Fetch new videos published after the latest date
    new_videos = get_new_videos_from_channel(CHANNEL_ID, last_date)

    print('found', len(new_videos), 'new videos.')

    if len(new_videos) == 0:
        print('no new videos to add to json file.')
        return

    # Merge existing videos with new videos, collapsing any repeated ids
    merged = existing_videos + new_videos
    all_videos = dedupe_videos(merged)

    removed = len(merged) - len(all_videos)
    if removed:
        print('removed', removed, 'duplicate record(s).')

    # Sort videos in reverse chronological order
    all_videos_sorted = sorted(all_videos, key=lambda x: x['upload_date'], reverse=True)

    # Write sorted data to a new JSON file
    with open('updated_videos.json', 'w', encoding='utf-8') as f:
        json.dump(all_videos_sorted, f, ensure_ascii=False, indent=4)
        print('wrote updated json file at updated_videos.json')


if __name__ == "__main__":
    main()
