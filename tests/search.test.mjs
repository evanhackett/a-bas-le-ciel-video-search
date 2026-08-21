// Tests for search.js. Pure logic, so no DOM and no jsdom.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    MIN_SEARCH_LENGTH,
    tokenize,
    formatDate,
    highlightText,
    searchableContent,
    matchesQuery,
    filterVideos,
    validateQuery,
} from '../search.js';

const ALL_FIELDS = { title: true, description: true, transcript: true, mode: 'exact' };
const ANY_WORD = { ...ALL_FIELDS, mode: 'any' };
const ALL_WORDS = { ...ALL_FIELDS, mode: 'all' };

const video = (over = {}) => ({
    title: 'Antinatalism and ecology',
    description: 'A discussion of ethics',
    transcript: 'the spoken words of the video',
    ...over,
});

describe('tokenize', () => {
    test('splits on whitespace and lowercases', () => {
        assert.deepEqual(tokenize('Hello World'), ['hello', 'world']);
    });

    test('collapses runs of whitespace', () => {
        assert.deepEqual(tokenize('a   b\tc'), ['a', 'b', 'c']);
    });

    test('trims leading and trailing whitespace', () => {
        assert.deepEqual(tokenize('  padded  '), ['padded']);
    });

    test('a single word yields one token', () => {
        assert.deepEqual(tokenize('solo'), ['solo']);
    });
});

describe('formatDate', () => {
    test('formats a full 14-digit timestamp', () => {
        assert.equal(formatDate('20240620234817'), '20 June 2024');
    });

    test('ignores the time portion', () => {
        assert.equal(formatDate('20240620000000'), '20 June 2024');
    });

    test('handles January and December (month index boundaries)', () => {
        assert.equal(formatDate('20220101000000'), '01 January 2022');
        assert.equal(formatDate('20221231000000'), '31 December 2022');
    });

    test('keeps the zero-padded day', () => {
        assert.equal(formatDate('20140212000000'), '12 February 2014');
        assert.equal(formatDate('20140202000000'), '02 February 2014');
    });
});

describe('highlightText', () => {
    test('wraps a match in a highlight span', () => {
        assert.equal(
            highlightText('hello world', ['world']),
            'hello <span class="highlight">world</span>',
        );
    });

    test('matches case-insensitively but preserves the original casing', () => {
        assert.equal(
            highlightText('Hello World', ['world']),
            'Hello <span class="highlight">World</span>',
        );
    });

    test('highlights every occurrence', () => {
        const out = highlightText('cat and cat', ['cat']);
        assert.equal(out.match(/class="highlight"/g).length, 2);
    });

    test('applies each token in turn', () => {
        const out = highlightText('alpha beta', ['alpha', 'beta']);
        assert.ok(out.includes('>alpha<'));
        assert.ok(out.includes('>beta<'));
    });

    test('leaves text without a match untouched', () => {
        assert.equal(highlightText('nothing here', ['absent']), 'nothing here');
    });

    // Regression: the token used to be interpolated straight into a RegExp, so a
    // query containing a metacharacter threw a SyntaxError instead of matching.
    test('treats regex metacharacters as literal text', () => {
        assert.equal(
            highlightText('a (parenthesis) here', ['(']),
            'a <span class="highlight">(</span>parenthesis) here',
        );
    });

    test('does not throw on any metacharacter', () => {
        for (const token of ['(', ')', '[', ']', '*', '+', '?', '.', '^', '$', '|', '\\']) {
            assert.doesNotThrow(() => highlightText(`a ${token} b`, [token]), `token ${token}`);
        }
    });

    test('a metacharacter token still matches its literal occurrence', () => {
        assert.ok(highlightText('2 + 2', ['+']).includes('>+<'));
    });

    test('does not let a token match as a wildcard', () => {
        // '.' as a regex would highlight every character; escaped it matches only a dot
        assert.equal(highlightText('ab.cd', ['.']), 'ab<span class="highlight">.</span>cd');
    });
});

describe('searchableContent', () => {
    test('includes only the enabled fields', () => {
        const content = searchableContent(video(), {
            title: true, description: false, transcript: false,
        });
        assert.ok(content.includes('antinatalism'));
        assert.ok(!content.includes('ethics'));
        assert.ok(!content.includes('spoken'));
    });

    test('combines all three when all are enabled', () => {
        const content = searchableContent(video(), ALL_FIELDS);
        assert.ok(content.includes('antinatalism'));
        assert.ok(content.includes('ethics'));
        assert.ok(content.includes('spoken'));
    });

    test('lowercases its output', () => {
        const content = searchableContent(video({ title: 'SHOUTING' }), ALL_FIELDS);
        assert.ok(content.includes('shouting'));
    });

    test('is empty when no field is enabled', () => {
        const content = searchableContent(video(), {
            title: false, description: false, transcript: false,
        });
        assert.equal(content, '');
    });
});

describe('matchesQuery', () => {
    test('exact mode matches a contiguous phrase', () => {
        assert.ok(matchesQuery(video(), 'antinatalism and ecology', [], ALL_FIELDS));
    });

    test('exact mode rejects words that appear out of order', () => {
        assert.ok(!matchesQuery(video(), 'ecology antinatalism', [], ALL_FIELDS));
    });

    test('any-word mode matches when a single token hits', () => {
        assert.ok(matchesQuery(video(), 'ecology zebra', ['ecology', 'zebra'], ANY_WORD));
    });

    test('any-word mode rejects when no token hits', () => {
        assert.ok(!matchesQuery(video(), 'zebra giraffe', ['zebra', 'giraffe'], ANY_WORD));
    });

    test('all-words mode matches when every token hits', () => {
        assert.ok(matchesQuery(video(), 'ecology antinatalism', ['ecology', 'antinatalism'], ALL_WORDS));
    });

    test('all-words mode rejects when one token misses', () => {
        assert.ok(!matchesQuery(video(), 'ecology zebra', ['ecology', 'zebra'], ALL_WORDS));
    });

    test('all-words mode ignores word order', () => {
        // "antinatalism and ecology" in the title, queried backwards
        assert.ok(matchesQuery(video(), 'ecology antinatalism', ['ecology', 'antinatalism'], ALL_WORDS));
    });

    test('all-words mode spans fields', () => {
        // one word from the title, one from the description
        assert.ok(matchesQuery(video(), 'ecology ethics', ['ecology', 'ethics'], ALL_WORDS));
    });

    test('the three modes genuinely disagree', () => {
        // The point of adding 'all': it is not a synonym for either neighbour.
        const tokens = ['ecology', 'zebra'];
        const q = 'ecology zebra';

        assert.ok(!matchesQuery(video(), q, tokens, ALL_FIELDS), 'exact: phrase absent');
        assert.ok(matchesQuery(video(), q, tokens, ANY_WORD), 'any: ecology hits');
        assert.ok(!matchesQuery(video(), q, tokens, ALL_WORDS), 'all: zebra misses');

        // and where all/any agree, exact still differs
        const both = ['ecology', 'antinatalism'];
        assert.ok(!matchesQuery(video(), 'ecology antinatalism', both, ALL_FIELDS));
        assert.ok(matchesQuery(video(), 'ecology antinatalism', both, ANY_WORD));
        assert.ok(matchesQuery(video(), 'ecology antinatalism', both, ALL_WORDS));
    });

    test('an unknown mode falls back to any-word', () => {
        const legacy = { ...ALL_FIELDS, mode: undefined };
        assert.ok(matchesQuery(video(), 'ecology zebra', ['ecology', 'zebra'], legacy));
    });

    test('respects disabled fields', () => {
        const titleOnly = { title: true, description: false, transcript: false, mode: 'exact' };
        assert.ok(!matchesQuery(video(), 'ethics', [], titleOnly));
        assert.ok(matchesQuery(video(), 'ethics', [], ALL_FIELDS));
    });

    test('matches a term found only in the transcript', () => {
        assert.ok(matchesQuery(video(), 'spoken words', [], ALL_FIELDS));
    });
});

describe('filterVideos', () => {
    const videos = [
        video({ title: 'first', description: '', transcript: '' }),
        video({ title: 'second', description: '', transcript: '' }),
        video({ title: 'third', description: '', transcript: '' }),
    ];

    test('returns only matching videos', () => {
        const out = filterVideos(videos, 'second', [], ALL_FIELDS);
        assert.equal(out.length, 1);
        assert.equal(out[0].title, 'second');
    });

    test('returns an empty array when nothing matches', () => {
        assert.deepEqual(filterVideos(videos, 'absent', [], ALL_FIELDS), []);
    });

    test('reports progress once per video, ending at 100', () => {
        const seen = [];
        filterVideos(videos, 'absent', [], ALL_FIELDS, (p) => seen.push(p));
        assert.equal(seen.length, 3);
        assert.equal(seen.at(-1), 100);
    });

    test('works without a progress callback', () => {
        assert.doesNotThrow(() => filterVideos(videos, 'first', [], ALL_FIELDS));
    });

    test('does not mutate the input', () => {
        const before = [...videos];
        filterVideos(videos, 'first', [], ALL_FIELDS);
        assert.deepEqual(videos, before);
    });
});

describe('validateQuery', () => {
    test('accepts a long enough exact phrase', () => {
        assert.equal(validateQuery('ecology', ['ecology'], ALL_FIELDS), null);
    });

    test('rejects a query shorter than the minimum', () => {
        const problem = validateQuery('ab', ['ab'], ALL_FIELDS);
        assert.ok(problem);
        assert.match(problem, /at least 3 characters/);
    });

    test('rejects a short word in any-word mode', () => {
        const problem = validateQuery('ab cdef', ['ab', 'cdef'], ANY_WORD);
        assert.ok(problem);
        assert.match(problem, /each word needs to be at least 3/);
    });

    test('allows short words in exact mode, where they are part of a phrase', () => {
        assert.equal(validateQuery('a b cdef', ['a', 'b', 'cdef'], ALL_FIELDS), null);
    });

    test('allows short words in all-words mode, where they only narrow', () => {
        // "war of the worlds" is a reasonable all-words query; ORed it would be junk
        assert.equal(validateQuery('war of the worlds', ['war', 'of', 'the', 'worlds'], ALL_WORDS), null);
    });

    test('still enforces the overall minimum length in all-words mode', () => {
        assert.ok(validateQuery('ab', ['ab'], ALL_WORDS));
    });

    test('MIN_SEARCH_LENGTH is the documented 3', () => {
        assert.equal(MIN_SEARCH_LENGTH, 3);
    });
});
