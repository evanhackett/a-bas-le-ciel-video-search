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

/** Wrap every occurrence of each token in a highlight span. */
export function highlightText(text, queryTokens) {
    let highlightedText = text;
    queryTokens.forEach(token => {
        const regex = new RegExp(`(${escapeRegExp(token)})`, 'gi');
        highlightedText = highlightedText.replace(regex, '<span class="highlight">$1</span>');
    });
    return highlightedText;
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

/** Does one video match the query under the given options? */
export function matchesQuery(video, query, queryTokens, options) {
    const content = searchableContent(video, options);

    if (options.isExact) {
        return content.includes(query);
    }
    return queryTokens.some(token => content.includes(token));
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

    if (!options.isExact) {
        // A search for very short words would match nearly every video, and is slow.
        for (const token of queryTokens) {
            if (token.length < MIN_SEARCH_LENGTH) {
                return `When "Contains any word..." option is selected, each word needs to be at least ${MIN_SEARCH_LENGTH} characters long.`;
            }
        }
    }

    return null;
}
