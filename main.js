// DOM wiring: loads the dataset, renders results, drives pagination.
// The matching and formatting logic lives in search.js.

import {
    tokenize,
    formatDate,
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

export function loadVideoData() {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const progressBarContainer = document.getElementById('progress-bar-container');
        const progressBar = document.getElementById('progress-bar');

        xhr.open('GET', 'videos.json', true);

        xhr.onprogress = function(event) {
            if (event.lengthComputable) {
                const percentComplete = (event.loaded / event.total) * 100;
                progressBar.style.width = `${percentComplete}%`;
                progressBarContainer.style.display = 'block';
            }
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
        isExact: selectedOption === 'exact',
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

    const highlightTokens = options.isExact ? [query] : queryTokens;

    currentResults.forEach(video => {
        const videoElement = document.createElement('div');
        videoElement.classList.add('result-item');
        videoElement.innerHTML = `
            <div class="result-left">
                <img src="${video.thumbnail}" alt="Thumbnail">
                <p>${formatDate(video.upload_date)} - <a href="${video.url}" target="_blank">Watch Video on YouTube</a></p>
                <h3>${highlightText(video.title, highlightTokens)}</h3>
                <p>${highlightText(video.description.replace(/\n/g, '<br><br>'), highlightTokens)}</p>
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

export function updatePagination() {
    const totalPages = Math.ceil(searchResults.length / resultsPerPage);
    const paginationTop = document.getElementById('pagination-top');
    const paginationBot = document.getElementById('pagination-bottom');
    paginationTop.style.display = 'block';
    paginationBot.style.display = totalPages > 1 ? 'block' : 'none';

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
    const totalPages = Math.ceil(searchResults.length / resultsPerPage);
    if (currentPage < totalPages) {
        currentPage++;
        displayResults();
        updatePagination();
    }
}

export function lastPage() {
    const totalPages = Math.ceil(searchResults.length / resultsPerPage);
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
