"""Unit tests for get-video-data.py."""

import json

import pytest
from youtube_transcript_api import (
    AgeRestricted,
    IpBlocked,
    NoTranscriptFound,
    PoTokenRequired,
    RequestBlocked,
    TranscriptsDisabled,
    VideoUnavailable,
    VideoUnplayable,
)

from conftest import FakeYouTube, video_api_response


# --- load_api_key ---------------------------------------------------------

def write_config(tmp_path, contents):
    path = tmp_path / 'config.json'
    path.write_text(contents if isinstance(contents, str) else json.dumps(contents))
    return path


class TestLoadApiKey:
    def test_reads_the_key_from_config_json(self, gvd, tmp_path, monkeypatch):
        monkeypatch.delenv('YOUTUBE_API_KEY', raising=False)
        monkeypatch.setattr(gvd, 'CONFIG_PATH', write_config(tmp_path, {'youtube_api_key': 'from-file'}))

        assert gvd.load_api_key() == 'from-file'

    def test_environment_variable_wins_over_the_file(self, gvd, tmp_path, monkeypatch):
        monkeypatch.setenv('YOUTUBE_API_KEY', 'from-env')
        monkeypatch.setattr(gvd, 'CONFIG_PATH', write_config(tmp_path, {'youtube_api_key': 'from-file'}))

        assert gvd.load_api_key() == 'from-env'

    def test_environment_variable_alone_is_enough(self, gvd, tmp_path, monkeypatch):
        monkeypatch.setenv('YOUTUBE_API_KEY', 'from-env')
        monkeypatch.setattr(gvd, 'CONFIG_PATH', tmp_path / 'missing.json')

        assert gvd.load_api_key() == 'from-env'

    def test_missing_config_explains_how_to_fix_it(self, gvd, tmp_path, monkeypatch):
        monkeypatch.delenv('YOUTUBE_API_KEY', raising=False)
        monkeypatch.setattr(gvd, 'CONFIG_PATH', tmp_path / 'missing.json')

        with pytest.raises(SystemExit) as excinfo:
            gvd.load_api_key()

        message = str(excinfo.value)
        assert 'config.example.json' in message
        assert 'YOUTUBE_API_KEY' in message

    def test_unedited_template_placeholder_is_rejected(self, gvd, tmp_path, monkeypatch):
        monkeypatch.delenv('YOUTUBE_API_KEY', raising=False)
        monkeypatch.setattr(
            gvd, 'CONFIG_PATH',
            write_config(tmp_path, {'youtube_api_key': 'PASTE_YOUR_YOUTUBE_DATA_API_V3_KEY_HERE'}),
        )

        with pytest.raises(SystemExit):
            gvd.load_api_key()

    def test_missing_key_field_is_rejected(self, gvd, tmp_path, monkeypatch):
        monkeypatch.delenv('YOUTUBE_API_KEY', raising=False)
        monkeypatch.setattr(gvd, 'CONFIG_PATH', write_config(tmp_path, {'something_else': 'x'}))

        with pytest.raises(SystemExit):
            gvd.load_api_key()

    def test_malformed_config_reports_a_json_error(self, gvd, tmp_path, monkeypatch):
        monkeypatch.delenv('YOUTUBE_API_KEY', raising=False)
        monkeypatch.setattr(gvd, 'CONFIG_PATH', write_config(tmp_path, '{ not json'))

        with pytest.raises(SystemExit) as excinfo:
            gvd.load_api_key()

        assert 'not valid JSON' in str(excinfo.value)


# --- dedupe_videos --------------------------------------------------------

def rec(video_id, **over):
    base = {'id': video_id, 'title': f'title {video_id}', 'transcript': 'words'}
    base.update(over)
    return base


class TestDedupeVideos:
    def test_leaves_a_list_without_duplicates_alone(self, gvd):
        records = [rec('a'), rec('b'), rec('c')]
        assert gvd.dedupe_videos(records) == records

    def test_collapses_repeated_ids(self, gvd):
        out = gvd.dedupe_videos([rec('a'), rec('b'), rec('a')])
        assert [r['id'] for r in out] == ['a', 'b']

    def test_the_later_record_wins(self, gvd):
        out = gvd.dedupe_videos([rec('a', title='old'), rec('a', title='new')])
        assert out[0]['title'] == 'new'

    def test_a_missing_transcript_never_clobbers_a_real_one(self, gvd):
        """A failed caption fetch must not destroy a transcript we already have."""
        out = gvd.dedupe_videos([
            rec('a', title='old', transcript='the real transcript'),
            rec('a', title='new', transcript=gvd.NO_TRANSCRIPT),
        ])

        assert out[0]['transcript'] == 'the real transcript'  # kept
        assert out[0]['title'] == 'new'                       # but metadata refreshed

    def test_a_real_transcript_replaces_an_older_one(self, gvd):
        out = gvd.dedupe_videos([rec('a', transcript='v1'), rec('a', transcript='v2')])
        assert out[0]['transcript'] == 'v2'

    def test_a_real_transcript_replaces_a_missing_one(self, gvd):
        out = gvd.dedupe_videos([
            rec('a', transcript=gvd.NO_TRANSCRIPT),
            rec('a', transcript='now available'),
        ])
        assert out[0]['transcript'] == 'now available'

    def test_keeps_first_seen_ordering(self, gvd):
        out = gvd.dedupe_videos([rec('a'), rec('b'), rec('c'), rec('a')])
        assert [r['id'] for r in out] == ['a', 'b', 'c']

    def test_handles_more_than_two_copies(self, gvd):
        out = gvd.dedupe_videos([rec('a', title=str(i)) for i in range(5)])
        assert len(out) == 1
        assert out[0]['title'] == '4'

    def test_empty_input(self, gvd):
        assert gvd.dedupe_videos([]) == []

    def test_does_not_mutate_the_input_records(self, gvd):
        original = rec('a', transcript='keep me')
        gvd.dedupe_videos([original, rec('a', transcript=gvd.NO_TRANSCRIPT)])
        assert original['transcript'] == 'keep me'


# --- fetch_transcript -----------------------------------------------------

class FakeSnippet:
    """A FetchedTranscriptSnippet, of which only .text is used."""

    def __init__(self, text):
        self.text = text


class FakeTranscriptApi:
    """Stands in for a YouTubeTranscriptApi instance (the 1.x API)."""

    def __init__(self, texts=None, error=None):
        self.texts = texts or []
        self.error = error
        self.calls = []

    def fetch(self, video_id):
        self.calls.append(video_id)
        if self.error:
            raise self.error
        return [FakeSnippet(text) for text in self.texts]


def use_transcript_api(gvd, monkeypatch, fake):
    monkeypatch.setattr(gvd, 'get_transcript_api', lambda: fake)
    return fake


# Reasons one video has no captions, which should yield the placeholder
PER_VIDEO_FAILURES = [
    pytest.param(TranscriptsDisabled('vid'), id='TranscriptsDisabled'),
    pytest.param(NoTranscriptFound('vid', ['en'], None), id='NoTranscriptFound'),
    pytest.param(AgeRestricted('vid'), id='AgeRestricted'),
    pytest.param(VideoUnavailable('vid'), id='VideoUnavailable'),
    pytest.param(VideoUnplayable('vid', 'reason', []), id='VideoUnplayable'),
]

# Failures that affect every video, which must never be mistaken for "no captions"
BLOCKING_FAILURES = [
    pytest.param(RequestBlocked('vid'), id='RequestBlocked'),
    pytest.param(IpBlocked('vid'), id='IpBlocked'),
    pytest.param(PoTokenRequired('vid'), id='PoTokenRequired'),
]


class TestFetchTranscript:
    def test_joins_snippet_text_with_spaces(self, gvd, monkeypatch):
        use_transcript_api(gvd, monkeypatch, FakeTranscriptApi(['hello', 'there', 'world']))
        assert gvd.fetch_transcript('vid') == 'hello there world'

    def test_an_empty_transcript_is_an_empty_string(self, gvd, monkeypatch):
        use_transcript_api(gvd, monkeypatch, FakeTranscriptApi([]))
        assert gvd.fetch_transcript('vid') == ''

    def test_passes_the_video_id_through(self, gvd, monkeypatch):
        fake = use_transcript_api(gvd, monkeypatch, FakeTranscriptApi(['x']))
        gvd.fetch_transcript('abc123')
        assert fake.calls == ['abc123']

    @pytest.mark.parametrize('error', PER_VIDEO_FAILURES)
    def test_a_video_without_captions_gets_the_placeholder(self, gvd, monkeypatch, error):
        use_transcript_api(gvd, monkeypatch, FakeTranscriptApi(error=error))
        assert gvd.fetch_transcript('vid') == gvd.NO_TRANSCRIPT

    @pytest.mark.parametrize('error', BLOCKING_FAILURES)
    def test_blocking_errors_are_not_swallowed(self, gvd, monkeypatch, error):
        """A block affects every video in the run.

        Recording it as "Transcript not available." would overwrite real
        transcripts across the whole dataset, so it must crash instead.
        """
        use_transcript_api(gvd, monkeypatch, FakeTranscriptApi(error=error))

        with pytest.raises(type(error)):
            gvd.fetch_transcript('vid')

    def test_the_client_is_created_once_and_reused(self, gvd):
        """One client keeps its HTTP session warm across videos."""
        assert gvd.get_transcript_api() is gvd.get_transcript_api()


# --- get_video_details ----------------------------------------------------

class TestGetVideoDetails:
    """Transcript fetching is stubbed here; it is covered by TestFetchTranscript."""

    def _no_transcript(self, gvd, monkeypatch):
        monkeypatch.setattr(gvd, 'fetch_transcript', lambda video_id: gvd.NO_TRANSCRIPT)

    def _transcript(self, gvd, monkeypatch, text='a transcript'):
        monkeypatch.setattr(gvd, 'fetch_transcript', lambda video_id: text)

    def test_maps_the_api_response_onto_a_record(self, gvd, monkeypatch):
        self._transcript(gvd, monkeypatch, 'hello world')
        youtube = FakeYouTube(video_api_response(video_id='abc123', title='A title'))

        result = gvd.get_video_details(youtube, 'abc123')

        assert result['id'] == 'abc123'
        assert result['title'] == 'A title'
        assert result['description'] == 'A description'
        assert result['url'] == 'https://www.youtube.com/watch?v=abc123'
        assert result['transcript'] == 'hello world'

    def test_converts_the_iso_date_to_the_stored_format(self, gvd, monkeypatch):
        self._transcript(gvd, monkeypatch)
        youtube = FakeYouTube(video_api_response(published_at='2024-06-20T23:48:17Z'))

        assert gvd.get_video_details(youtube, 'abc123')['upload_date'] == '20240620234817'

    def test_prefers_the_high_resolution_thumbnail(self, gvd, monkeypatch):
        self._transcript(gvd, monkeypatch)
        youtube = FakeYouTube(video_api_response(video_id='xyz'))

        assert gvd.get_video_details(youtube, 'xyz')['thumbnail'].endswith('hqdefault.jpg')

    def test_falls_back_to_the_default_thumbnail(self, gvd, monkeypatch):
        self._transcript(gvd, monkeypatch)
        youtube = FakeYouTube(video_api_response(
            video_id='xyz',
            thumbnails={'default': {'url': 'https://i.ytimg.com/vi/xyz/default.jpg'}},
        ))

        assert gvd.get_video_details(youtube, 'xyz')['thumbnail'].endswith('default.jpg')

    def test_records_the_placeholder_when_captions_are_unavailable(self, gvd, monkeypatch):
        self._no_transcript(gvd, monkeypatch)
        youtube = FakeYouTube(video_api_response())

        assert gvd.get_video_details(youtube, 'abc123')['transcript'] == gvd.NO_TRANSCRIPT

    def test_returns_none_when_the_video_is_gone(self, gvd, monkeypatch):
        self._transcript(gvd, monkeypatch)
        youtube = FakeYouTube({'items': []})

        assert gvd.get_video_details(youtube, 'deleted') is None

    def test_returns_none_when_the_response_has_no_items_key(self, gvd, monkeypatch):
        self._transcript(gvd, monkeypatch)
        assert gvd.get_video_details(FakeYouTube({}), 'deleted') is None


# --- get_new_videos_from_channel ------------------------------------------

class FakeSearch:
    """Serves canned search().list() pages in order."""

    def __init__(self, pages):
        self.pages = list(pages)
        self.calls = []

    def search(self):
        return self

    def list(self, **kwargs):
        self.calls.append(kwargs)
        return self

    def execute(self):
        return self.pages.pop(0)


def search_page(video_ids, next_page_token=None):
    page = {'items': [{'id': {'videoId': v}} for v in video_ids]}
    if next_page_token:
        page['nextPageToken'] = next_page_token
    return page


class TestGetNewVideosFromChannel:
    def _setup(self, gvd, monkeypatch, pages, details):
        fake = FakeSearch(pages)
        monkeypatch.setattr(gvd, 'build', lambda *a, **k: fake)
        monkeypatch.setattr(gvd, 'load_api_key', lambda: 'test-key')
        monkeypatch.setattr(gvd, 'get_video_details', lambda youtube, vid: details(vid))
        return fake

    def test_collects_every_video_on_a_single_page(self, gvd, monkeypatch):
        self._setup(gvd, monkeypatch, [search_page(['a', 'b'])],
                    lambda v: {'id': v, 'upload_date': '20240101000000', 'title': v})

        result = gvd.get_new_videos_from_channel('chan', '20230101000000')

        assert [v['id'] for v in result] == ['a', 'b']

    def test_skips_videos_that_vanished_between_search_and_lookup(self, gvd, monkeypatch):
        """Regression: this used to crash with a TypeError before the None guard."""
        self._setup(
            gvd, monkeypatch,
            [search_page(['ok1', 'gone', 'ok2'])],
            lambda v: None if v == 'gone' else {'id': v, 'upload_date': '20240101000000', 'title': v},
        )

        result = gvd.get_new_videos_from_channel('chan', '20230101000000')

        assert [v['id'] for v in result] == ['ok1', 'ok2']

    def test_follows_pagination_until_the_token_runs_out(self, gvd, monkeypatch):
        fake = self._setup(
            gvd, monkeypatch,
            [search_page(['a'], next_page_token='page2'), search_page(['b'])],
            lambda v: {'id': v, 'upload_date': '20240101000000', 'title': v},
        )

        result = gvd.get_new_videos_from_channel('chan', '20230101000000')

        assert [v['id'] for v in result] == ['a', 'b']
        assert fake.calls[0]['pageToken'] is None
        assert fake.calls[1]['pageToken'] == 'page2'

    def test_asks_for_videos_one_second_after_the_newest_known_one(self, gvd, monkeypatch):
        """The +1s stops the newest existing video from being fetched again."""
        fake = self._setup(gvd, monkeypatch, [search_page([])], lambda v: None)

        gvd.get_new_videos_from_channel('chan', '20240620234817')

        assert fake.calls[0]['publishedAfter'] == '2024-06-20T23:48:18Z'

    def test_passes_the_channel_id_and_restricts_to_videos(self, gvd, monkeypatch):
        fake = self._setup(gvd, monkeypatch, [search_page([])], lambda v: None)

        gvd.get_new_videos_from_channel('my-channel', '20240101000000')

        assert fake.calls[0]['channelId'] == 'my-channel'
        assert fake.calls[0]['type'] == 'video'


# --- main -----------------------------------------------------------------

class TestMain:
    def _run(self, gvd, tmp_path, monkeypatch, existing, new):
        (tmp_path / 'videos.json').write_text(json.dumps(existing), encoding='utf-8')
        monkeypatch.chdir(tmp_path)
        monkeypatch.setattr(gvd, 'get_new_videos_from_channel', lambda channel, after: new)
        gvd.main()
        output = tmp_path / 'updated_videos.json'
        return json.loads(output.read_text(encoding='utf-8')) if output.exists() else None

    def test_writes_nothing_when_there_are_no_new_videos(self, gvd, tmp_path, monkeypatch):
        result = self._run(gvd, tmp_path, monkeypatch, [rec('a', upload_date='20240101000000')], [])
        assert result is None

    def test_merges_new_videos_into_the_existing_set(self, gvd, tmp_path, monkeypatch):
        result = self._run(
            gvd, tmp_path, monkeypatch,
            [rec('old', upload_date='20220101000000')],
            [rec('new', upload_date='20240101000000')],
        )
        assert {v['id'] for v in result} == {'old', 'new'}

    def test_sorts_newest_first(self, gvd, tmp_path, monkeypatch):
        result = self._run(
            gvd, tmp_path, monkeypatch,
            [rec('mid', upload_date='20230101000000'), rec('oldest', upload_date='20220101000000')],
            [rec('newest', upload_date='20240101000000')],
        )
        assert [v['id'] for v in result] == ['newest', 'mid', 'oldest']

    def test_removes_duplicates_during_the_merge(self, gvd, tmp_path, monkeypatch):
        result = self._run(
            gvd, tmp_path, monkeypatch,
            [rec('dup', upload_date='20240101000000'), rec('dup', upload_date='20240101000000')],
            [rec('fresh', upload_date='20240201000000')],
        )
        assert len(result) == 2

    def test_pads_date_only_timestamps_from_the_seed_dataset(self, gvd, tmp_path, monkeypatch):
        """metadata.json used YYYYMMDD; the script widens it to 14 characters."""
        result = self._run(
            gvd, tmp_path, monkeypatch,
            [rec('seeded', upload_date='20220720')],
            [rec('fresh', upload_date='20240101000000')],
        )
        seeded = next(v for v in result if v['id'] == 'seeded')
        assert seeded['upload_date'] == '20220720000000'

    def test_asks_for_videos_newer_than_the_latest_stored_one(self, gvd, tmp_path, monkeypatch):
        seen = {}
        (tmp_path / 'videos.json').write_text(json.dumps([
            rec('a', upload_date='20220101000000'),
            rec('b', upload_date='20240620234817'),
        ]), encoding='utf-8')
        monkeypatch.chdir(tmp_path)

        def capture(channel, after):
            seen['after'] = after
            return []

        monkeypatch.setattr(gvd, 'get_new_videos_from_channel', capture)
        gvd.main()

        assert seen['after'] == '20240620234817'
