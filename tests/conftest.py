"""Shared pytest fixtures."""

import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent


def load_script():
    """Import get-video-data.py, whose hyphenated name blocks a normal import."""
    spec = importlib.util.spec_from_file_location(
        'get_video_data', ROOT / 'get-video-data.py'
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def gvd():
    """A freshly imported copy of the script.

    Function-scoped on purpose: tests monkeypatch module attributes such as
    build() and YouTubeTranscriptApi, and a shared module would leak those
    between tests.
    """
    return load_script()


@pytest.fixture(scope='session')
def videos():
    """The real videos.json. Session-scoped; it is ~52 MB and slow to parse."""
    with open(ROOT / 'videos.json', encoding='utf-8') as f:
        return json.load(f)


class FakeYouTube:
    """Stands in for the googleapiclient resource, for videos().list() calls."""

    def __init__(self, response):
        self._response = response
        self.kwargs = None

    def videos(self):
        return self

    def list(self, **kwargs):
        self.kwargs = kwargs
        return self

    def execute(self):
        return self._response


def video_api_response(
    video_id='abc123',
    title='A title',
    description='A description',
    published_at='2024-06-20T23:48:17Z',
    thumbnails=None,
):
    """Shape of a videos().list() response for one video."""
    if thumbnails is None:
        thumbnails = {
            'default': {'url': f'https://i.ytimg.com/vi/{video_id}/default.jpg'},
            'high': {'url': f'https://i.ytimg.com/vi/{video_id}/hqdefault.jpg'},
        }
    return {
        'items': [{
            'snippet': {
                'title': title,
                'description': description,
                'publishedAt': published_at,
                'thumbnails': thumbnails,
            }
        }]
    }
