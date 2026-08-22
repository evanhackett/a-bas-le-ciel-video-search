// DOM wiring: loads the dataset, renders results, drives pagination.
// The matching and formatting logic lives in search.js.

import {
    tokenize,
    formatDate,
    escapeHtml,
    highlightText,
    filterVideos,
    validateQuery,
} from './search.js';

let videos = [];
let currentPage = 1;
let resultsPerPage = 10;
let searchResults = [];
let query;
let queryTokens;
let options;

/**
 * Uncompressed size of videos.json, in bytes.
 *
 * The progress bar cannot use event.total. GitHub Pages serves videos.json
 * gzipped, so total is the compressed length (~17.9 MB) while event.loaded counts
 * decompressed bytes (~53 MB) -- the ratio passes 100% about a third of the way
 * through the download. No response header carries the uncompressed size, and the
 * value is the same whether or not the transport compressed it, so a constant is
 * the one thing that works both on Pages and on a local server.
 *
 * A test compares this against the real file and fails with the correct number
 * when the dataset has grown enough to matter, so it cannot drift silently.
 */
export const EXPECTED_BYTES = 55_689_430;

/** "24.3 MB". One decimal is as much precision as a loading message can use. */
function formatMegabytes(bytes) {
    return `${(bytes / 1048576).toFixed(1)} MB`;
}

export function loadVideoData() {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const progressBarContainer = document.getElementById('progress-bar-container');
        const progressBar = document.getElementById('progress-bar');
        const progressText = document.getElementById('progress-text');

        xhr.open('GET', 'videos.json', true);

        xhr.onprogress = function(event) {
            // Measured against EXPECTED_BYTES rather than event.total; see above.
            // Capped because the dataset grows between updates of that constant.
            const percentComplete = Math.min(100, (event.loaded / EXPECTED_BYTES) * 100);
            progressBar.style.width = `${percentComplete}%`;

            // Always true even if the constant has drifted, and it gives a sense of
            // scale on a slow connection
            progressText.textContent =
                `${formatMegabytes(event.loaded)} of ${formatMegabytes(EXPECTED_BYTES)}`;
            progressBarContainer.style.display = 'block';
            // No lengthComputable guard: nothing here reads event.total, so progress
            // still shows for a response that arrives without a Content-Length.
        };

        xhr.onload = function() {
            progressBarContainer.style.display = 'none';
            if (xhr.status >= 200 && xhr.status < 300) {
                try {
                    const data = JSON.parse(xhr.responseText);
                    videos = data;
                    document.getElementById('search-container').style.display = 'block';
                    resolve();
                } catch (error) {
                    reject('Failed to parse JSON response');
                }
            } else {
                reject(`HTTP error! Status: ${xhr.status}`);
            }
        };

        xhr.onerror = function() {
            progressBarContainer.style.display = 'none';
            reject('Request failed');
        };

        xhr.send();
    }).catch(error => {
        console.error('Error loading video data:', error);
        showError('Failed to load video data. Please try again later.');
    });
}

export function showError(message) {
    const errorDiv = document.createElement('div');
    errorDiv.textContent = message;
    errorDiv.style.color = 'red';
    document.body.insertBefore(errorDiv, document.body.firstChild);
}

export function updateProgressBar(progress) {
    const progressBar = document.getElementById('progress-bar');
    progressBar.style.width = `${progress}%`;
}

/** Read the current state of the search option controls. */
function readOptions() {
    const optionsEl = document.getElementsByName('options');

    let selectedOption;
    for (const option of optionsEl) {
        if (option.checked) {
            selectedOption = option.value;
            break;
        }
    }

    return {
        title: document.getElementById('titleCheckbox').checked,
        description: document.getElementById('descriptionCheckbox').checked,
        transcript: document.getElementById('transcriptCheckbox').checked,
        // Matches the radio values in index.html: 'exact', 'any' or 'all'. The
        // fallback mirrors the markup, where option1 carries the checked attribute.
        mode: selectedOption ?? 'exact',
    };
}

export function searchVideos() {
    query = document.getElementById('search-input').value.trim().toLowerCase();
    options = readOptions();
    queryTokens = tokenize(query);

    const problem = validateQuery(query, queryTokens, options);
    if (problem) {
        alert(problem);
        return;
    }

    searchResults = [];

    const resultsDiv = document.getElementById('results');
    resultsDiv.innerHTML = '';

    // The bar does double duty as the search progress indicator, where a byte
    // count means nothing
    document.getElementById('progress-text').textContent = '';
    document.getElementById('progress-bar-container').style.display = 'block';

    searchResults = filterVideos(videos, query, queryTokens, options, updateProgressBar);

    document.getElementById('progress-bar-container').style.display = 'none';

    currentPage = 1;
    displayResults();
    updatePagination();
}

export function displayResults() {
    const resultsContainer = document.getElementById('results');
    resultsContainer.innerHTML = '';

    const startIndex = (currentPage - 1) * resultsPerPage;
    const endIndex = Math.min(startIndex + resultsPerPage, searchResults.length);
    const currentResults = searchResults.slice(startIndex, endIndex);

    const highlightTokens = options.mode === 'exact' ? [query] : queryTokens;

    currentResults.forEach(video => {
        const videoElement = document.createElement('div');
        videoElement.classList.add('result-item');
        // Everything interpolated here is escaped: highlightText() returns HTML it
        // escaped itself, and the attributes and the date go through escapeHtml().
        // Paragraph breaks are applied after highlighting rather than before --
        // escaping would otherwise turn our own <br> tags into visible text.
        videoElement.innerHTML = `
            <div class="result-left">
                <img src="${escapeHtml(video.thumbnail)}" alt="Thumbnail">
                <p>${escapeHtml(formatDate(video.upload_date))} - <a href="${escapeHtml(video.url)}" target="_blank">Watch Video on YouTube</a></p>
                <h3>${highlightText(video.title, highlightTokens)}</h3>
                <p>${highlightText(video.description, highlightTokens).replace(/\n/g, '<br><br>')}</p>
            </div>
            <div class="result-right">
                <h3>Transcript</h3>
                <p>${highlightText(video.transcript, highlightTokens)}</p>
            </div>
        `;
        resultsContainer.appendChild(videoElement);
    });

    const resultCount = document.getElementById('result-count');
    resultCount.textContent = `Found ${searchResults.length} result(s)`;
}

/**
 * How many pages the current results span. Never less than 1: an empty result
 * set used to give 0, which left next/last enabled (currentPage 1 never equalled
 * totalPages 0) and made lastPage() jump to page 0.
 */
function totalPageCount() {
    return Math.max(1, Math.ceil(searchResults.length / resultsPerPage));
}

export function updatePagination() {
    const totalPages = totalPageCount();
    const paginationTop = document.getElementById('pagination-top');
    const paginationBot = document.getElementById('pagination-bottom');
    // Clear the inline display rather than setting 'block'. Setting it overrode
    // .pagination's own `display: flex` for the element's whole life, so
    // justify-content and align-items never applied and the controls laid out as
    // left-aligned inline content. Emptying the property lets the stylesheet win.
    paginationTop.style.display = '';
    paginationBot.style.display = totalPages > 1 ? '' : 'none';

    Array.from(document.getElementsByClassName('prev-button')).forEach(el => el.disabled = currentPage === 1);
    Array.from(document.getElementsByClassName('next-button')).forEach(el => el.disabled = currentPage === totalPages);
    Array.from(document.getElementsByClassName('first-button')).forEach(el => el.disabled = currentPage === 1);
    Array.from(document.getElementsByClassName('last-button')).forEach(el => el.disabled = currentPage === totalPages);

    Array.from(document.getElementsByClassName('page-info')).forEach(el => el.textContent = `Page ${currentPage} of ${totalPages}`);
}

export function firstPage() {
    if (currentPage !== 1) {
        currentPage = 1;
        displayResults();
        updatePagination();
    }
}

export function prevPage() {
    if (currentPage > 1) {
        currentPage--;
        displayResults();
        updatePagination();
    }
}

export function nextPage() {
    const totalPages = totalPageCount();
    if (currentPage < totalPages) {
        currentPage++;
        displayResults();
        updatePagination();
    }
}

export function lastPage() {
    const totalPages = totalPageCount();
    if (currentPage !== totalPages) {
        currentPage = totalPages;
        displayResults();
        updatePagination();
    }
}

export function changeResultsPerPage() {
    resultsPerPage = parseInt(document.getElementById('results-per-page').value);
    currentPage = 1;
    displayResults();
    updatePagination();
}

/** Attach every event listener. Replaces the old inline onclick attributes. */
export function wireEvents() {
    document.getElementById('search-button').addEventListener('click', searchVideos);

    document.getElementById('search-input').addEventListener('keypress', function(event) {
        if (event.key === 'Enter') {
            event.preventDefault();
            searchVideos();
        }
    });

    document.getElementById('results-per-page').addEventListener('change', changeResultsPerPage);

    const buttons = [
        ['first-button', firstPage],
        ['prev-button', prevPage],
        ['next-button', nextPage],
        ['last-button', lastPage],
    ];
    for (const [className, handler] of buttons) {
        Array.from(document.getElementsByClassName(className))
            .forEach(el => el.addEventListener('click', handler));
    }

    // Scroll to the top if they click one of the bottom pagination buttons
    document.getElementById('pagination-bottom').addEventListener('click', (event) => {
        if (event.target.nodeName === 'BUTTON') {
            window.scrollTo({ top: 0 });
        }
    });
}

export function init() {
    wireEvents();
    return loadVideoData();
}

// Module scripts are deferred, so the DOM is already parsed when this runs.
init();
