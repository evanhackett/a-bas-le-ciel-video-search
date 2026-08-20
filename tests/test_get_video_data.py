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
    base = {
        'id': video_id,
        'title': f'title {video_id}',
        'transcript': 'words',
        'upload_date': '20240101000000',
    }
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


class TestCheckBlockStatus:
    def test_reports_clear_when_a_request_succeeds(self, gvd, monkeypatch):
        use_transcript_api(gvd, monkeypatch, FakeTranscriptApi(['words']))
        assert gvd.check_block_status() is True

    @pytest.mark.parametrize('error', BLOCKING_FAILURES)
    def test_reports_blocked_on_a_blocking_error(self, gvd, monkeypatch, error):
        use_transcript_api(gvd, monkeypatch, FakeTranscriptApi(error=error))
        assert gvd.check_block_status() is False

    def test_a_probe_video_without_captions_still_counts_as_clear(self, gvd, monkeypatch):
        """The request got through; the video simply has no transcript."""
        use_transcript_api(gvd, monkeypatch, FakeTranscriptApi(error=TranscriptsDisabled('vid')))
        assert gvd.check_block_status() is True


# --- next_delay -----------------------------------------------------------

class TestNextDelay:
    def test_never_shorter_than_the_delay_and_never_longer_than_delay_plus_jitter(self, gvd):
        low, high = gvd.REQUEST_JITTER_SECONDS
        for _ in range(200):
            assert gvd.REQUEST_DELAY_SECONDS + low <= gvd.next_delay() <= gvd.REQUEST_DELAY_SECONDS + high

    def test_varies_between_calls(self, gvd):
        assert len({gvd.next_delay() for _ in range(50)}) > 1

    def test_follows_the_delay_setting(self, gvd, monkeypatch):
        """--delay rebinds the constant, so next_delay has to read it live."""
        monkeypatch.setattr(gvd, 'REQUEST_DELAY_SECONDS', 0.0)
        monkeypatch.setattr(gvd, 'REQUEST_JITTER_SECONDS', (0.0, 0.0))

        assert gvd.next_delay() == 0.0


# --- command line ---------------------------------------------------------

class TestParseArgs:
    def test_defaults_to_a_normal_run(self, gvd):
        args = gvd.parse_args([])
        assert args.check is False
        assert args.delay == gvd.REQUEST_DELAY_SECONDS

    def test_check_flag(self, gvd):
        assert gvd.parse_args(['--check']).check is True

    def test_delay_overrides_the_default(self, gvd):
        assert gvd.parse_args(['--delay', '7.5']).delay == 7.5


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


# --- channel enumeration --------------------------------------------------

class FakeApiCall:
    def __init__(self, response):
        self._response = response

    def execute(self):
        return self._response


class FakeChannels:
    def __init__(self, response):
        self._response = response
        self.calls = []

    def list(self, **kwargs):
        self.calls.append(kwargs)
        return FakeApiCall(self._response)


class FakePlaylistItems:
    """Serves canned playlistItems().list() pages in order."""

    def __init__(self, pages):
        self.pages = list(pages)
        self.calls = []

    def list(self, **kwargs):
        self.calls.append(kwargs)
        return FakeApiCall(self.pages.pop(0))


class FakeYouTubeApi:
    def __init__(self, channels=None, playlist_items=None):
        self._channels = channels
        self._playlist_items = playlist_items

    def channels(self):
        return self._channels

    def playlistItems(self):
        return self._playlist_items


def channel_response(uploads_id='UUabc'):
    return {'items': [{'contentDetails': {'relatedPlaylists': {'uploads': uploads_id}}}]}


def playlist_page(video_ids, next_page_token=None):
    page = {'items': [{'contentDetails': {'videoId': v}} for v in video_ids]}
    if next_page_token:
        page['nextPageToken'] = next_page_token
    return page


class TestGetUploadsPlaylistId:
    def test_returns_the_uploads_playlist(self, gvd):
        youtube = FakeYouTubeApi(channels=FakeChannels(channel_response('UUxyz')))
        assert gvd.get_uploads_playlist_id(youtube, 'chan') == 'UUxyz'

    def test_exits_when_the_channel_does_not_exist(self, gvd):
        youtube = FakeYouTubeApi(channels=FakeChannels({'items': []}))
        with pytest.raises(SystemExit):
            gvd.get_uploads_playlist_id(youtube, 'nope')


class TestListAllVideoIds:
    def test_collects_ids_from_a_single_page(self, gvd):
        youtube = FakeYouTubeApi(playlist_items=FakePlaylistItems([playlist_page(['a', 'b'])]))
        assert gvd.list_all_video_ids(youtube, 'UUabc') == ['a', 'b']

    def test_follows_pagination_until_the_token_runs_out(self, gvd):
        items = FakePlaylistItems([playlist_page(['a'], 'page2'), playlist_page(['b'])])

        assert gvd.list_all_video_ids(FakeYouTubeApi(playlist_items=items), 'UUabc') == ['a', 'b']
        assert items.calls[0]['pageToken'] is None
        assert items.calls[1]['pageToken'] == 'page2'

    def test_asks_for_the_given_playlist(self, gvd):
        items = FakePlaylistItems([playlist_page([])])
        gvd.list_all_video_ids(FakeYouTubeApi(playlist_items=items), 'UUxyz')
        assert items.calls[0]['playlistId'] == 'UUxyz'

    def test_an_empty_playlist_yields_nothing(self, gvd):
        youtube = FakeYouTubeApi(playlist_items=FakePlaylistItems([playlist_page([])]))
        assert gvd.list_all_video_ids(youtube, 'UUabc') == []


# --- checkpointing --------------------------------------------------------

class TestCheckpoint:
    @pytest.fixture(autouse=True)
    def _in_tmp_dir(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        self.tmp_path = tmp_path

    def test_saves_and_reloads(self, gvd):
        gvd.save_checkpoint([rec('a'), rec('b')])
        assert [v['id'] for v in gvd.load_checkpoint()] == ['a', 'b']

    def test_absent_checkpoint_reads_as_empty(self, gvd):
        assert gvd.load_checkpoint() == []

    def test_clearing_removes_the_file(self, gvd):
        gvd.save_checkpoint([rec('a')])
        gvd.clear_checkpoint()
        assert not (self.tmp_path / gvd.CHECKPOINT_PATH).exists()

    def test_clearing_is_safe_when_there_is_no_checkpoint(self, gvd):
        gvd.clear_checkpoint()  # must not raise

    def test_does_not_leave_its_temporary_file_behind(self, gvd):
        """The write goes via a temp file and os.replace so it is atomic."""
        gvd.save_checkpoint([rec('a')])
        assert not (self.tmp_path / (gvd.CHECKPOINT_PATH + '.tmp')).exists()


# --- fetch_videos ---------------------------------------------------------

class TestFetchVideos:
    @pytest.fixture(autouse=True)
    def _fast_and_isolated(self, gvd, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        monkeypatch.setattr(gvd.time, 'sleep', lambda seconds: None)
        self.tmp_path = tmp_path

    def _details(self, gvd, monkeypatch, func):
        monkeypatch.setattr(gvd, 'get_video_details', func)

    def test_fetches_every_id(self, gvd, monkeypatch):
        self._details(gvd, monkeypatch, lambda youtube, vid: rec(vid))

        fetched, error = gvd.fetch_videos(None, ['a', 'b'], [])

        assert [v['id'] for v in fetched] == ['a', 'b']
        assert error is None

    def test_skips_ids_with_no_details(self, gvd, monkeypatch):
        self._details(gvd, monkeypatch,
                      lambda youtube, vid: None if vid == 'gone' else rec(vid))

        fetched, error = gvd.fetch_videos(None, ['ok1', 'gone', 'ok2'], [])

        assert [v['id'] for v in fetched] == ['ok1', 'ok2']
        assert error is None

    def test_stops_at_a_blocking_error_and_hands_it_back(self, gvd, monkeypatch):
        def details(youtube, vid):
            if vid == 'boom':
                raise IpBlocked(vid)
            return rec(vid)

        self._details(gvd, monkeypatch, details)

        fetched, error = gvd.fetch_videos(None, ['a', 'boom', 'c'], [])

        assert [v['id'] for v in fetched] == ['a']       # work before the block is kept
        assert isinstance(error, IpBlocked)              # and reported, not raised

    def test_a_block_checkpoints_what_was_fetched(self, gvd, monkeypatch):
        """The crash that motivated this: a block used to discard the whole run."""
        def details(youtube, vid):
            if vid == 'boom':
                raise IpBlocked(vid)
            return rec(vid)

        self._details(gvd, monkeypatch, details)

        gvd.fetch_videos(None, ['a', 'boom'], [rec('earlier')])

        saved = gvd.load_checkpoint()
        assert [v['id'] for v in saved] == ['earlier', 'a']

    def test_checkpoints_periodically_during_a_long_run(self, gvd, monkeypatch):
        self._details(gvd, monkeypatch, lambda youtube, vid: rec(vid))
        monkeypatch.setattr(gvd, 'CHECKPOINT_EVERY', 2)

        gvd.fetch_videos(None, [f'v{i}' for i in range(4)], [])

        assert len(gvd.load_checkpoint()) == 4

    def test_pauses_between_videos_but_not_after_the_last(self, gvd, monkeypatch):
        """The pause is what stops the IP block recurring."""
        delays = []
        monkeypatch.setattr(gvd.time, 'sleep', lambda seconds: delays.append(seconds))
        self._details(gvd, monkeypatch, lambda youtube, vid: rec(vid))

        gvd.fetch_videos(None, ['a', 'b', 'c'], [])

        assert len(delays) == 2
        low, high = gvd.REQUEST_JITTER_SECONDS
        assert all(gvd.REQUEST_DELAY_SECONDS + low <= d <= gvd.REQUEST_DELAY_SECONDS + high
                   for d in delays)

    def test_the_pause_is_not_the_same_length_every_time(self, gvd, monkeypatch):
        """A metronome-regular request is the pattern the jitter exists to break."""
        delays = []
        monkeypatch.setattr(gvd.time, 'sleep', lambda seconds: delays.append(seconds))
        self._details(gvd, monkeypatch, lambda youtube, vid: rec(vid))

        gvd.fetch_videos(None, [f'v{i}' for i in range(20)], [])

        assert len(set(delays)) > 1

    def test_per_video_errors_still_propagate_normally(self, gvd, monkeypatch):
        """Only blocking errors are caught here; anything else is a real bug."""
        def details(youtube, vid):
            raise ValueError('unexpected')

        self._details(gvd, monkeypatch, details)

        with pytest.raises(ValueError):
            gvd.fetch_videos(None, ['a'], [])


# --- main -----------------------------------------------------------------

class TestMain:
    def _setup(self, gvd, tmp_path, monkeypatch, existing, channel_ids,
               fetch_result=None, checkpoint=None):
        (tmp_path / 'videos.json').write_text(json.dumps(existing), encoding='utf-8')
        monkeypatch.chdir(tmp_path)

        if checkpoint is not None:
            gvd.save_checkpoint(checkpoint)

        monkeypatch.setattr(gvd, 'build', lambda *a, **k: object())
        monkeypatch.setattr(gvd, 'load_api_key', lambda: 'test-key')
        monkeypatch.setattr(gvd, 'get_uploads_playlist_id', lambda youtube, chan: 'UUabc')
        monkeypatch.setattr(gvd, 'list_all_video_ids', lambda youtube, pl: channel_ids)

        captured = {}

        def fake_fetch(youtube, video_ids, already_fetched):
            captured['requested'] = video_ids
            if fetch_result is not None:
                return fetch_result
            return [rec(v, upload_date='20240101000000') for v in video_ids], None

        monkeypatch.setattr(gvd, 'fetch_videos', fake_fetch)
        return captured

    def _run(self, gvd, tmp_path, monkeypatch, **kwargs):
        captured = self._setup(gvd, tmp_path, monkeypatch, **kwargs)
        gvd.main()
        output = tmp_path / 'updated_videos.json'
        result = json.loads(output.read_text(encoding='utf-8')) if output.exists() else None
        return result, captured

    def test_writes_nothing_when_the_archive_is_complete(self, gvd, tmp_path, monkeypatch):
        result, captured = self._run(
            gvd, tmp_path, monkeypatch,
            existing=[rec('a', upload_date='20240101000000')],
            channel_ids=['a'],
        )
        assert result is None

    def test_fetches_only_the_ids_it_does_not_have(self, gvd, tmp_path, monkeypatch):
        result, captured = self._run(
            gvd, tmp_path, monkeypatch,
            existing=[rec('have', upload_date='20240101000000')],
            channel_ids=['have', 'missing'],
        )
        assert captured['requested'] == ['missing']
        assert {v['id'] for v in result} == {'have', 'missing'}

    def test_fetches_a_video_older_than_the_newest_one_stored(self, gvd, tmp_path, monkeypatch):
        """Regression for the gap the old date cutoff created.

        Resuming from max(upload_date) stranded any video an earlier run had
        skipped, because it sat behind the cutoff forever. Diffing ids finds it.
        """
        result, captured = self._run(
            gvd, tmp_path, monkeypatch,
            existing=[rec('newest', upload_date='20240601000000')],
            channel_ids=['newest', 'straggler'],
        )
        assert captured['requested'] == ['straggler']
        assert 'straggler' in {v['id'] for v in result}

    def test_sorts_newest_first(self, gvd, tmp_path, monkeypatch):
        result, _ = self._run(
            gvd, tmp_path, monkeypatch,
            existing=[rec('mid', upload_date='20230101000000'),
                      rec('oldest', upload_date='20220101000000')],
            channel_ids=['mid', 'oldest', 'newest'],
            fetch_result=([rec('newest', upload_date='20240101000000')], None),
        )
        assert [v['id'] for v in result] == ['newest', 'mid', 'oldest']

    def test_removes_duplicates_during_the_merge(self, gvd, tmp_path, monkeypatch):
        result, _ = self._run(
            gvd, tmp_path, monkeypatch,
            existing=[rec('dup', upload_date='20240101000000'),
                      rec('dup', upload_date='20240101000000')],
            channel_ids=['dup', 'fresh'],
        )
        assert len(result) == 2

    def test_pads_date_only_timestamps_from_the_seed_dataset(self, gvd, tmp_path, monkeypatch):
        """metadata.json used YYYYMMDD; the script widens it to 14 characters."""
        result, _ = self._run(
            gvd, tmp_path, monkeypatch,
            existing=[rec('seeded', upload_date='20220720')],
            channel_ids=['seeded', 'fresh'],
        )
        seeded = next(v for v in result if v['id'] == 'seeded')
        assert seeded['upload_date'] == '20220720000000'

    def test_resumes_from_a_checkpoint_without_refetching(self, gvd, tmp_path, monkeypatch):
        result, captured = self._run(
            gvd, tmp_path, monkeypatch,
            existing=[rec('have', upload_date='20240101000000')],
            channel_ids=['have', 'done', 'todo'],
            checkpoint=[rec('done', upload_date='20240201000000')],
        )
        assert captured['requested'] == ['todo']
        assert {v['id'] for v in result} == {'have', 'done', 'todo'}

    def test_clears_the_checkpoint_after_a_successful_run(self, gvd, tmp_path, monkeypatch):
        self._run(
            gvd, tmp_path, monkeypatch,
            existing=[rec('have', upload_date='20240101000000')],
            channel_ids=['have', 'todo'],
            checkpoint=[rec('done', upload_date='20240201000000')],
        )
        assert not (tmp_path / gvd.CHECKPOINT_PATH).exists()

    def test_a_block_saves_progress_and_writes_no_output(self, gvd, tmp_path, monkeypatch):
        self._setup(
            gvd, tmp_path, monkeypatch,
            existing=[rec('have', upload_date='20240101000000')],
            channel_ids=['have', 'a', 'b'],
            fetch_result=([rec('a', upload_date='20240201000000')], IpBlocked('b')),
        )

        with pytest.raises(SystemExit) as excinfo:
            gvd.main()

        message = str(excinfo.value)
        assert gvd.CHECKPOINT_PATH in message
        assert 'run this script again' in message

        # the partial work survives, and videos.json is not half-updated
        assert [v['id'] for v in gvd.load_checkpoint()] == ['a']
        assert not (tmp_path / 'updated_videos.json').exists()


