const MIN_SEARCH_LENGTH = 3;

let videos = [];
let currentPage = 1;
let resultsPerPage = 10;
let searchResults = [];
let query;
let queryTokens;
let options;

function loadVideoData() {
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

function showError(message) {
    const errorDiv = document.createElement('div');
    errorDiv.textContent = message;
    errorDiv.style.color = 'red';
    document.body.insertBefore(errorDiv, document.body.firstChild);
}

function tokenize(input) {
    return input.trim().toLowerCase().split(/\s+/);
}

function highlightText(text, queryTokens) {
    let highlightedText = text;
    queryTokens.forEach(token => {
        const regex = new RegExp(`(${token})`, 'gi');
        highlightedText = highlightedText.replace(regex, '<span class="highlight">$1</span>');
    });
    return highlightedText;
}

function formatDate(dateString) {
    const year = dateString.substr(0, 4);
    const month = dateString.substr(4, 2);
    const day = dateString.substr(6, 2);

    // Array of month names
    const months = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'
    ];

    // Format the date with padded day and month
    return `${day.padStart(2, '0')} ${months[parseInt(month, 10) - 1]} ${year}`;
}

function updateProgressBar(progress) {
    const progressBar = document.getElementById('progress-bar');
    progressBar.style.width = `${progress}%`;
}

function searchVideos() {
    query = document.getElementById('search-input').value.trim().toLowerCase();

    if (query.length < MIN_SEARCH_LENGTH) {
        alert(`Please enter at least ${MIN_SEARCH_LENGTH} characters for your search.`);
        return;
    }

    const optionsEl = document.getElementsByName('options');

    let selectedOption;
    for (const option of optionsEl) {
        if (option.checked) {
            selectedOption = option.value;
            break;
        }
    }

    options = {
        title: document.getElementById('titleCheckbox').checked,
        description: document.getElementById('descriptionCheckbox').checked,
        transcript: document.getElementById('transcriptCheckbox').checked,
        isExact: selectedOption === 'exact',
    };

    queryTokens = tokenize(query);

    if (!options.isExact) {
        // search will be too slow, and will likely match all videos, if there are words less than 3 letters
        for (const token of queryTokens) {
            if (token.length < MIN_SEARCH_LENGTH) {
                alert(`When "Contains any word..." option is selected, each word needs to be at least ${MIN_SEARCH_LENGTH} characters long.`);
                return;
            }
        }
    }

    searchResults = [];

    const resultsDiv = document.getElementById('results');
    resultsDiv.innerHTML = '';

    document.getElementById('progress-bar-container').style.display = 'block';

    const filteredVideos = videos.filter((video, index) => {
        const progress = Math.round(((index + 1) / videos.length) * 100);
        updateProgressBar(progress);

        let searchContent = '';
        if (options.title) searchContent += `${video.title} `;
        if (options.description) searchContent += `${video.description} `;
        if (options.transcript) searchContent += `${video.transcript} `;
        searchContent = searchContent.toLowerCase();

        if (options.isExact) {
            // Exact phrase match
            return searchContent.includes(query);
        } else {
            // Partial match
            return queryTokens.some(token => searchContent.includes(token));
        }
    });

    document.getElementById('progress-bar-container').style.display = 'none';

    searchResults = filteredVideos;

    currentPage = 1;
    displayResults();
    updatePagination();
}

function displayResults() {
    const resultsContainer = document.getElementById('results');
    resultsContainer.innerHTML = '';

    const startIndex = (currentPage - 1) * resultsPerPage;
    const endIndex = Math.min(startIndex + resultsPerPage, searchResults.length);
    const currentResults = searchResults.slice(startIndex, endIndex);

    currentResults.forEach(video => {
        const videoElement = document.createElement('div');
        videoElement.classList.add('result-item');
        videoElement.innerHTML = `
            <div class="result-left">
                <img src="${video.thumbnail}" alt="Thumbnail">
                <p>${formatDate(video.upload_date)} - <a href="${video.url}" target="_blank">Watch Video on YouTube</a></p>
                <h3>${highlightText(video.title, options.isExact ? [query] : queryTokens)}</h3>
                <p>${highlightText(video.description.replace(/\n/g, '<br><br>'), options.isExact ? [query] : queryTokens)}</p>
            </div>
            <div class="result-right">
                <h3>Transcript</h3>
                <p>${highlightText(video.transcript, options.isExact ? [query] : queryTokens)}</p>
            </div>
        `;
        resultsContainer.appendChild(videoElement);
    });

    const resultCount = document.getElementById('result-count');
    resultCount.textContent = `Found ${searchResults.length} result(s)`;
}

function updatePagination() {
    const totalPages = Math.ceil(searchResults.length / resultsPerPage);
    const paginationTop = document.getElementById('pagination-top');
    const paginationBot = document.getElementById('pagination-bottom');
    paginationTop.style.display = 'block';
    paginationBot.style.display = totalPages > 1 ? 'block' : 'none';

    Array.from(document.getElementsByClassName('prev-button')).forEach(el => el.disabled = currentPage === 1);
    Array.from(document.getElementsByClassName('next-button')).forEach(el => el.disabled = currentPage === totalPages);
    Array.from(document.getElementsByClassName('first-button')).forEach(el => el.disabled = currentPage === 1);
    Array.from(document.getElementsByClassName('last-button')).forEach(el => el.disabled = currentPage === totalPages);

    Array.from(document.getElementsByClassName('page-info')).forEach(el => el.textContent = `Page ${currentPage} of ${totalPages}`)
}

function firstPage() {
    if (currentPage !== 1) {
        currentPage = 1;
        displayResults();
        updatePagination();
    }
}

function prevPage() {
    if (currentPage > 1) {
        currentPage--;
        displayResults();
        updatePagination();
    }
}

function nextPage() {
    const totalPages = Math.ceil(searchResults.length / resultsPerPage);
    if (currentPage < totalPages) {
        currentPage++;
        displayResults();
        updatePagination();
    }
}

function lastPage() {
    const totalPages = Math.ceil(searchResults.length / resultsPerPage);
    if (currentPage !== totalPages) {
        currentPage = totalPages;
        displayResults();
        updatePagination();
    }
}


function changeResultsPerPage() {
  resultsPerPage = parseInt(document.getElementById('results-per-page').value);
  currentPage = 1;
  displayResults();
  updatePagination();
}

// scroll to top of page if they click one of the bottom pagination buttons
const paginationBottom = document.getElementById('pagination-bottom');
paginationBottom.addEventListener('click', (event) => {
    const isButton = event.target.nodeName === 'BUTTON';
    if (!isButton) {
        return;
    }

    window.scrollTo({top: 0});
});

document.addEventListener('DOMContentLoaded', function() {
    loadVideoData();

    // Add an event listener to the search input to handle the "Enter" key
    document.getElementById('search-input').addEventListener('keypress', function(event) {
        if (event.key === 'Enter') {
            event.preventDefault();
            searchVideos();
        }
    });
});