#!/usr/bin/env python3
"""One-stop update: fetch new videos, promote the dataset, re-fingerprint it.

    ./update-site.py                    # fetch on this machine's IP
    ./update-site.py --proxy            # ...through Webshare
    ./update-site.py --proxy --push     # ...and deploy it

Flags this script does not recognise are forwarded to get-video-data.py, so
--proxy, --delay and --check all work here.

Each step runs only if the one before it succeeded, so an interrupted or blocked
fetch leaves videos.json and version.json exactly as they were -- the checkpoint
in fetch-progress.json is picked up by the next run.

The order matters in one direction: write-version.py hashes videos.json off the
disk, so promoting has to happen before fingerprinting or the fingerprint
describes the old dataset. That is the mistake this script exists to prevent.
"""

import argparse
import json
import os
import pathlib
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
ARCHIVE = HERE / 'videos.json'
INCOMING = HERE / 'updated_videos.json'
VERSION = HERE / 'version.json'
FETCH = HERE / 'get-video-data.py'
FINGERPRINT = HERE / 'write-version.py'


def interpreter():
    """The venv interpreter if there is one, else whatever is running this.

    The fetch script needs googleapiclient and youtube_transcript_api, which
    live in venv/. Running ./update-site.py with the system python3 should still
    reach them, so the children are launched explicitly rather than inherited.
    """
    venv_python = HERE / 'venv' / 'bin' / 'python'
    return str(venv_python) if os.access(venv_python, os.X_OK) else sys.executable


PYTHON = interpreter()


def step(message):
    print(f'\n==> {message}', flush=True)


def run(script, *args):
    """Run one of the project's scripts, exiting with its status if it fails.

    No message on failure: the child has already said what went wrong, and a
    second summary line on top of it only buries the detail.
    """
    result = subprocess.run([PYTHON, str(script), *args])
    if result.returncode:
        sys.exit(result.returncode)


def git(*args, check=True):
    return subprocess.run(['git', '-C', str(HERE), *args], check=check)


def read_archive(path):
    """Parse an archive file, rejecting anything that is not a list of records."""
    try:
        videos = json.loads(path.read_text(encoding='utf-8'))
    except json.JSONDecodeError as exc:
        sys.exit(f'{path.name} is not valid JSON: {exc}')

    if not isinstance(videos, list):
        sys.exit(f'{path.name} should hold a list, found {type(videos).__name__}')

    return videos


def promote():
    """Move the fetched dataset over the archive, once it looks sane.

    This overwrites a tracked 55 MB file, so the replacement is checked first: a
    dataset that shrank means something went wrong upstream -- a partial merge, a
    checkpoint that lost records -- and the archive is the only copy.
    """
    new = read_archive(INCOMING)
    old = read_archive(ARCHIVE) if ARCHIVE.exists() else []

    if len(new) < len(old):
        sys.exit(f'{INCOMING.name} holds {len(new)} videos, fewer than the '
                 f'{len(old)} in {ARCHIVE.name}. Refusing to promote it; '
                 f'inspect it by hand.')

    print(f'{len(old)} videos -> {len(new)} ({len(new) - len(old)} added)')
    INCOMING.replace(ARCHIVE)


def commit(push):
    """Commit the two changed files, and push if asked. Returns what it did."""
    git('add', ARCHIVE.name, VERSION.name)

    if git('diff', '--cached', '--quiet', check=False).returncode == 0:
        print('nothing staged -- the archive did not change.')
        return False, False

    git('commit', '-m', 'Update videos.json')

    if push:
        step('Pushing (this deploys the site)')
        git('push')

    return True, push


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
        # Off so that a forwarded flag can never be read as an abbreviation of
        # one of these two
        allow_abbrev=False,
    )
    parser.add_argument(
        '--commit',
        action='store_true',
        help='commit videos.json and version.json when the update succeeds',
    )
    parser.add_argument(
        '--push',
        action='store_true',
        help='commit and push. Pushing to main is the deploy',
    )
    args, forwarded = parser.parse_known_args(argv)
    args.commit = args.commit or args.push
    return args, forwarded


def main(argv=None):
    args, fetch_args = parse_args(argv)

    if '--check' in fetch_args:
        # --check makes one request and reports whether this IP is blocked. There
        # is nothing to promote after it, so hand the run over and stop here.
        sys.exit(subprocess.run([PYTHON, str(FETCH), *fetch_args]).returncode)

    if INCOMING.exists():
        sys.exit(f'{INCOMING.name} already exists -- left over from a previous run.\n'
                 f'Promote it (mv {INCOMING.name} {ARCHIVE.name}) or delete it, '
                 f'then run this again.')

    step('Fetching new videos')
    run(FETCH, *fetch_args)

    if not INCOMING.exists():
        # get-video-data.py writes nothing when the channel holds no new videos.
        # version.json can still be stale -- a hand-edited archive, a past run
        # that was promoted but never fingerprinted -- so it is worth checking.
        step('No new videos -- checking the fingerprint is still current')
        run(FINGERPRINT)
        return

    step(f'Promoting {INCOMING.name} to {ARCHIVE.name}')
    promote()

    step('Refreshing the cache fingerprint')
    run(FINGERPRINT)

    committed = pushed = False
    if args.commit:
        step('Committing')
        committed, pushed = commit(args.push)

    step('Done')
    # Pushing to main is the deploy, so say plainly whether the site has moved.
    if pushed:
        print('Pushed -- GitHub Pages is deploying the new archive.')
    elif committed:
        print('Committed but not pushed. Deploy with:  git push')
    elif args.commit:
        # Asked to commit and found nothing to commit: the promoted dataset
        # matched what is already in HEAD, so there is nothing to deploy either
        print('Nothing to deploy -- the archive matches the last commit.')
    else:
        print('Not committed. Deploy with:')
        print(f'  git add {ARCHIVE.name} {VERSION.name} && '
              f"git commit -m 'Update videos.json' && git push")


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        # The fetch script takes the same ctrl-c and saves its checkpoint before
        # it goes, so there is nothing to clean up here
        sys.exit('\ninterrupted.')
