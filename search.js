// Pure search and formatting logic. Nothing in here touches the DOM, so it can be
// tested directly without a browser or jsdom.

export const MIN_SEARCH_LENGTH = 3;

const MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
];

/** Split a search phrase into lowercased words. */
export function tokenize(input) {
    return input.trim().toLowerCase().split(/\s+/);
}

/** "20240620234817" -> "20 June 2024" */
export function formatDate(dateString) {
    const year = dateString.substr(0, 4);
    const month = dateString.substr(4, 2);
    const day = dateString.substr(6, 2);

    return `${day.padStart(2, '0')} ${MONTHS[parseInt(month, 10) - 1]} ${year}`;
}

/**
 * Escape a string so it matches literally inside a RegExp.
 * Search tokens come straight from the user, and a query containing `(`, `[` or
 * `*` used to throw a SyntaxError rather than find anything.
 */
export function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Escape text for interpolation into HTML.
 *
 * Video titles, descriptions and transcripts come from the YouTube API, so they
 * are not attacker-controlled here, but they are not ours either: an ampersand or
 * an angle bracket in a description used to be handed to innerHTML as markup.
 */
export function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Wrap every occurrence of each token in a highlight span, escaping everything
 * else. Returns HTML, and is the only thing that should build it from video text.
 *
 * One pass over the raw string, rather than a replace() per token, for two
 * reasons. Escaping has to happen on the original text: escaping first would make
 * a search for "amp" match inside "&amp;", and escaping afterwards would eat the
 * spans this function just inserted. And a per-token pass lets a later token match
 * markup an earlier one inserted -- searching "span" or "class" used to produce
 * `<<span class="highlight">span</span> class=...` and wreck the card.
 *
 * Longest token first, so "catastrophe" wins over "cat" where both are searched.
 */
export function highlightText(text, queryTokens) {
    const tokens = [...new Set((queryTokens || []).filter(Boolean))]
        .sort((a, b) => b.length - a.length);

    if (tokens.length === 0) return escapeHtml(text);

    const pattern = new RegExp(tokens.map(escapeRegExp).join('|'), 'gi');
    let html = '';
    let cursor = 0;

    for (const match of String(text).matchAll(pattern)) {
        html += escapeHtml(String(text).slice(cursor, match.index));
        html += `<span class="highlight">${escapeHtml(match[0])}</span>`;
        cursor = match.index + match[0].length;
    }

    return html + escapeHtml(String(text).slice(cursor));
}

/**
 * The text of a video that a search should look at, given which fields are
 * enabled. Lowercased, so callers compare against a lowercased query.
 */
export function searchableContent(video, options) {
    let content = '';
    if (options.title) content += `${video.title} `;
    if (options.description) content += `${video.description} `;
    if (options.transcript) content += `${video.transcript} `;
    return content.toLowerCase();
}

/**
 * Does one video match the query under the given options?
 *
 * Three modes, which genuinely differ: 'exact' wants the phrase verbatim, 'all'
 * wants every word somewhere in the content in any order, 'any' wants at least
 * one. Matching is substring, not word-boundary, throughout -- "cat" matches
 * "catastrophe" in every mode.
 */
export function matchesQuery(video, query, queryTokens, options) {
    const content = searchableContent(video, options);

    switch (options.mode) {
        case 'exact':
            return content.includes(query);
        case 'all':
            return queryTokens.every(token => content.includes(token));
        default:
            return queryTokens.some(token => content.includes(token));
    }
}

/**
 * Filter a list of videos. `onProgress`, if given, is called with a 0-100
 * percentage as each video is checked; it is the only hook back to the UI.
 */
export function filterVideos(videos, query, queryTokens, options, onProgress) {
    return videos.filter((video, index) => {
        if (onProgress) {
            onProgress(Math.round(((index + 1) / videos.length) * 100));
        }
        return matchesQuery(video, query, queryTokens, options);
    });
}

/**
 * Why a search can't run, or null if it can.
 * Mirrors the two guards the UI enforces before searching.
 */
export function validateQuery(query, queryTokens, options) {
    if (query.length < MIN_SEARCH_LENGTH) {
        return `Please enter at least ${MIN_SEARCH_LENGTH} characters for your search.`;
    }

    // Only 'any' mode. A two-letter word ORed against everything else matches
    // nearly every video, which is useless and slow. ANDed it is just a narrowing
    // filter, so 'all' mode deliberately permits short words -- otherwise a
    // perfectly reasonable query like "war of the worlds" would be rejected.
    if (options.mode === 'any') {
        for (const token of queryTokens) {
            if (token.length < MIN_SEARCH_LENGTH) {
                return `When "Contains any word..." option is selected, each word needs to be at least ${MIN_SEARCH_LENGTH} characters long.`;
            }
        }
    }

    return null;
}
