(function () {
  'use strict';

  var script = document.currentScript;
  var indexUrl = (script && script.getAttribute('data-index')) || '/search.json';

  function init() {
    var dialog = document.getElementById('search-dialog');
    var input = document.getElementById('search-input');
    var results = document.getElementById('search-results');
    var status = document.getElementById('search-status');
    if (!dialog || !input || !results || typeof dialog.showModal !== 'function') return;

    var posts = null;
    var loading = null;
    var selected = -1;

    function load() {
      if (!loading) {
        loading = fetch(indexUrl)
          .then(function (r) { return r.json(); })
          .then(function (data) {
            posts = data.map(function (p) {
              p._title = p.title.toLowerCase();
              p._content = p.content.toLowerCase();
              return p;
            });
          })
          .catch(function () {
            status.textContent = 'error: could not load the search index.';
          });
      }
      return loading;
    }

    function open() {
      if (dialog.open) return;
      load();
      dialog.showModal();
      input.select();
      render();
    }

    function links() {
      return Array.prototype.slice.call(results.querySelectorAll('a'));
    }

    function select(i) {
      var all = links();
      if (!all.length) { selected = -1; return; }
      selected = (i + all.length) % all.length;
      all.forEach(function (a, n) {
        a.classList.toggle('is-selected', n === selected);
        a.setAttribute('aria-selected', String(n === selected));
      });
      all[selected].scrollIntoView({ block: 'nearest' });
    }

    function render() {
      var query = input.value.trim().toLowerCase();
      results.textContent = '';
      selected = -1;

      if (query.length < 2) {
        status.textContent = '';
        return;
      }
      if (!posts) {
        status.textContent = 'loading index…';
        load().then(render);
        return;
      }

      var terms = query.split(/\s+/);
      var matches = posts
        .map(function (p) {
          var score = 0;
          for (var i = 0; i < terms.length; i++) {
            var t = terms[i];
            var inTitle = p._title.indexOf(t) !== -1;
            if (!inTitle && p._content.indexOf(t) === -1) return null;
            score += inTitle ? 10 : 1;
          }
          return { post: p, score: score };
        })
        .filter(Boolean)
        .sort(function (a, b) { return b.score - a.score; })
        .slice(0, 8);

      status.textContent = matches.length
        ? matches.length + (matches.length === 1 ? ' match' : ' matches')
        : 'no matches for "' + input.value.trim() + '"';

      matches.forEach(function (m) {
        var li = document.createElement('li');
        var a = document.createElement('a');
        a.href = m.post.url;
        var title = document.createElement('span');
        title.className = 'search-result-title';
        title.textContent = m.post.title;
        var date = document.createElement('span');
        date.className = 'search-result-date';
        date.textContent = m.post.date;
        a.appendChild(title);
        a.appendChild(date);
        li.appendChild(a);
        results.appendChild(li);
      });
      if (matches.length) select(0);
    }

    input.addEventListener('input', render);

    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); select(selected + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); select(selected - 1); }
      else if (e.key === 'Enter') {
        var all = links();
        if (selected >= 0 && all[selected]) {
          e.preventDefault();
          window.location.href = all[selected].href;
        }
      }
    });

    // Close when clicking the backdrop.
    dialog.addEventListener('click', function (e) {
      if (e.target === dialog) dialog.close();
    });

    document.querySelectorAll('[data-search-open]').forEach(function (button) {
      button.addEventListener('click', open);
    });

    document.addEventListener('keydown', function (e) {
      var target = e.target;
      var typing = target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        open();
      } else if (e.key === '/' && !typing && !dialog.open) {
        e.preventDefault();
        open();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
