"""Checks on the shipped videos.json.

These guard the dataset the site actually serves: a bad record here breaks
search or rendering for real visitors, and nothing else validates the file.
"""

import re
from collections import Counter
from datetime import datetime

REQUIRED_FIELDS = ('id', 'url', 'title', 'description', 'upload_date', 'transcript', 'thumbnail')

UPLOAD_DATE = re.compile(r'^\d{14}$')


def test_dataset_is_a_non_empty_list(videos):
    assert isinstance(videos, list)
    assert len(videos) > 0


def test_every_record_has_all_required_fields(videos):
    missing = [
        (v.get('id', '<no id>'), field)
        for v in videos
        for field in REQUIRED_FIELDS
        if field not in v
    ]
    assert not missing, f'records missing fields: {missing[:10]}'


def test_every_field_is_a_string(videos):
    wrong = [
        (v['id'], field, type(v[field]).__name__)
        for v in videos
        for field in REQUIRED_FIELDS
        if not isinstance(v.get(field), str)
    ]
    assert not wrong, f'non-string fields: {wrong[:10]}'


def test_no_record_has_an_empty_id(videos):
    empty = [i for i, v in enumerate(videos) if not v.get('id')]
    assert not empty, f'records with a blank id at positions: {empty[:10]}'


def test_video_ids_are_unique(videos):
    """Duplicates render the same video twice in the results."""
    counts = Counter(v['id'] for v in videos)
    duplicates = {vid: n for vid, n in counts.items() if n > 1}
    assert not duplicates, (
        f'{len(duplicates)} duplicated id(s), {sum(duplicates.values()) - len(duplicates)} '
        f'extra record(s): {duplicates}'
    )


def test_upload_dates_are_fourteen_digits(videos):
    """main.js formatDate() slices fixed offsets, so the width must be exact."""
    bad = [(v['id'], v['upload_date']) for v in videos if not UPLOAD_DATE.match(v['upload_date'])]
    assert not bad, f'malformed upload_date: {bad[:10]}'


def test_upload_dates_are_real_timestamps(videos):
    bad = []
    for v in videos:
        try:
            datetime.strptime(v['upload_date'], '%Y%m%d%H%M%S')
        except ValueError:
            bad.append((v['id'], v['upload_date']))
    assert not bad, f'unparseable upload_date: {bad[:10]}'


def test_upload_dates_are_plausible(videos):
    """The channel started in 2014; nothing should predate that or be in the future."""
    now = datetime.now().strftime('%Y%m%d%H%M%S')
    bad = [
        (v['id'], v['upload_date']) for v in videos
        if not ('20100101000000' <= v['upload_date'] <= now)
    ]
    assert not bad, f'implausible upload_date: {bad[:10]}'


def test_urls_match_their_video_id(videos):
    bad = [
        (v['id'], v['url']) for v in videos
        if v['url'] != f"https://www.youtube.com/watch?v={v['id']}"
    ]
    assert not bad, f'url does not match id: {bad[:10]}'


def test_thumbnails_are_https_urls(videos):
    bad = [(v['id'], v['thumbnail']) for v in videos if not v['thumbnail'].startswith('https://')]
    assert not bad, f'suspect thumbnail url: {bad[:10]}'


def test_records_are_sorted_newest_first(videos):
    """get-video-data.py writes them reverse-chronologically."""
    dates = [v['upload_date'] for v in videos]
    assert dates == sorted(dates, reverse=True), 'videos.json is not in reverse date order'


def test_titles_are_not_blank(videos):
    blank = [v['id'] for v in videos if not v['title'].strip()]
    assert not blank, f'blank titles: {blank[:10]}'
