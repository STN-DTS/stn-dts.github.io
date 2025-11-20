(function () {
  const searchInput = document.getElementById('search-input');
  const searchResults = document.getElementById('search-results');
  const searchToggle = document.getElementById('search-toggle');
  const searchContainer = document.querySelector('.search-container');

  if (!searchInput || !searchResults) return;

  if (searchToggle && searchContainer) {
    searchToggle.addEventListener('click', function (e) {
      e.stopPropagation();
      searchContainer.classList.toggle('active');
      if (searchContainer.classList.contains('active')) {
        searchInput.focus();
      }
    });
  }

  let posts = [];

  // Fetch the search index
  const searchPath = window.searchJsonPath || '/search.json';
  fetch(searchPath)
    .then(response => response.json())
    .then(data => {
      posts = data;
    })
    .catch(error => console.error('Error fetching search index:', error));

  searchInput.addEventListener('input', function () {
    const query = this.value.toLowerCase();
    searchResults.innerHTML = '';

    if (query.length < 2) {
      searchResults.style.display = 'none';
      return;
    }

    const filteredPosts = posts.filter(post => {
      return post.title.toLowerCase().includes(query) ||
        post.content.toLowerCase().includes(query);
    });

    if (filteredPosts.length > 0) {
      searchResults.style.display = 'block';
      filteredPosts.slice(0, 5).forEach(post => {
        const resultItem = document.createElement('div');
        resultItem.classList.add('search-result-item');
        resultItem.innerHTML = `
          <a href="${post.url}">
            <div class="search-result-title">${post.title}</div>
            <div class="search-result-date">${post.date}</div>
          </a>
        `;
        searchResults.appendChild(resultItem);
      });
    } else {
      searchResults.style.display = 'block';
      searchResults.innerHTML = '<div class="search-no-results">No results found</div>';
    }
  });

  // Close search results when clicking outside
  document.addEventListener('click', function (event) {
    if (!searchInput.contains(event.target) && !searchResults.contains(event.target)) {
      searchResults.style.display = 'none';
    }
  });
})();
