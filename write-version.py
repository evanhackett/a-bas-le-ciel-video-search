#!/usr/bin/env python3
"""Write version.json, the fingerprint the browser cache keys on.

Run this after promoting a new dataset:

    mv updated_videos.json videos.json
    python3 write-version.py

Why the site needs it: GitHub Pages sends videos.json with `cache-control:
max-age=600` and an ETag derived from the file's mtime and size. Pages
re-checks-out the whole repo on every deploy, so a one-line edit to help.html
resets that mtime and invalidates the validator for a 55 MB file that did not
change -- every returning visitor downloads it again. main.js keys its
IndexedDB copy on the hash below instead, so a download happens only when the
dataset genuinely changed.

`count` is the guard against a torn read: version.json and videos.json are
separate CDN objects with separate lifetimes, so a visitor can be served a new
fingerprint alongside a stale archive. main.js refuses to cache a download
whose record count disagrees with this one.
"""

import hashlib
import json
import pathlib
import sys

ARCHIVE = pathlib.Path('videos.json')
VERSION = pathlib.Path('version.json')

# Enough hex to make an accidental collision irrelevant while keeping the
# IndexedDB keys readable in devtools.
HASH_LENGTH = 16


def main():
    if not ARCHIVE.exists():
        sys.exit(f'{ARCHIVE} not found -- run this from the site directory')

    raw = ARCHIVE.read_bytes()

    try:
        videos = json.loads(raw)
    except json.JSONDecodeError as exc:
        sys.exit(f'{ARCHIVE} is not valid JSON: {exc}')

    if not isinstance(videos, list):
        sys.exit(f'{ARCHIVE} should hold a list, found {type(videos).__name__}')

    meta = {
        # Hash of the bytes on disk, not of the re-serialised records: the
        # browser is caching what it downloaded, so the fingerprint has to
        # cover exactly that.
        'version': hashlib.sha256(raw).hexdigest()[:HASH_LENGTH],
        'bytes': len(raw),
        'count': len(videos),
    }

    VERSION.write_text(json.dumps(meta) + '\n', encoding='utf-8')
    print(f"wrote {VERSION}: version {meta['version']}, "
          f"{meta['count']} videos, {meta['bytes']} bytes")


if __name__ == '__main__':
    main()
