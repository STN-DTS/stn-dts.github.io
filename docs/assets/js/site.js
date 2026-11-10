(function () {
  'use strict';

  function slugify(text) {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  /* Post pages: heading anchors, table of contents, code blocks, tables,
     reading progress. */
  function initPost() {
    var content = document.querySelector('[data-post-content]');
    if (!content) return;

    // Heading anchors: the "##" prefix doubles as the permalink.
    var headings = content.querySelectorAll('h2, h3, h4');
    var used = {};
    headings.forEach(function (heading) {
      if (!heading.id) {
        var base = slugify(heading.textContent) || 'section';
        var id = base;
        var n = 2;
        while (used[id] || document.getElementById(id)) id = base + '-' + n++;
        heading.id = id;
      }
      used[heading.id] = true;

      var level = Number(heading.tagName.charAt(1));
      var anchor = document.createElement('a');
      anchor.className = 'heading-anchor';
      anchor.href = '#' + heading.id;
      anchor.textContent = '#'.repeat(level);
      anchor.setAttribute('aria-label', 'Link to this section');
      heading.insertBefore(anchor, heading.firstChild);
    });

    // Table of contents from h2s.
    var toc = document.querySelector('[data-toc]');
    var tocList = document.querySelector('[data-toc-list]');
    var layout = document.querySelector('[data-post-layout]');
    var h2s = Array.prototype.slice.call(content.querySelectorAll('h2'));
    if (toc && tocList && h2s.length >= 2) {
      var links = h2s.map(function (h) {
        var li = document.createElement('li');
        var a = document.createElement('a');
        a.href = '#' + h.id;
        var anchor = h.querySelector('.heading-anchor');
        a.textContent = h.textContent.slice(anchor ? anchor.textContent.length : 0).trim();
        li.appendChild(a);
        tocList.appendChild(li);
        return a;
      });
      toc.hidden = false;

      // Scroll spy: the active section is the last h2 whose top has passed
      // just below the sticky header (same offset used for anchor jumps).
      var currentIndex = null;
      var ticking = false;
      var setActive = function () {
        ticking = false;
        var offset = (parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0) + 8;
        var activeIndex = -1;
        for (var i = 0; i < h2s.length; i++) {
          if (h2s[i].getBoundingClientRect().top <= offset) activeIndex = i;
          else break;
        }
        // At the bottom of the page, later sections may never reach the
        // offset line: prefer the linked section if on screen, else the last.
        var doc = document.documentElement;
        if (window.innerHeight + window.scrollY >= doc.scrollHeight - 2) {
          var onScreen = function (h) {
            var top = h.getBoundingClientRect().top;
            return top >= 0 && top < window.innerHeight;
          };
          var hashIndex = h2s.findIndex(function (h) {
            return '#' + h.id === decodeURIComponent(location.hash);
          });
          if (hashIndex > activeIndex && onScreen(h2s[hashIndex])) activeIndex = hashIndex;
          else if (onScreen(h2s[h2s.length - 1])) activeIndex = h2s.length - 1;
        }
        if (activeIndex === currentIndex) return;
        currentIndex = activeIndex;
        links.forEach(function (a, i) {
          a.classList.toggle('is-active', i === activeIndex);
          if (i === activeIndex) a.setAttribute('aria-current', 'location');
          else a.removeAttribute('aria-current');
        });
      };
      var requestUpdate = function () {
        if (!ticking) {
          ticking = true;
          window.requestAnimationFrame(setActive);
        }
      };
      window.addEventListener('scroll', requestUpdate, { passive: true });
      window.addEventListener('resize', requestUpdate);
      window.addEventListener('load', requestUpdate);
      window.addEventListener('hashchange', requestUpdate);
      setActive();
    } else if (layout) {
      layout.classList.add('no-toc');
    }

    // Code blocks: toolbar with language label and copy button.
    content.querySelectorAll('div.highlighter-rouge').forEach(function (block) {
      var match = block.className.match(/language-([\w+#-]+)/);
      var lang = match && match[1] !== 'plaintext' ? match[1] : 'text';

      var toolbar = document.createElement('div');
      toolbar.className = 'code-toolbar';
      var label = document.createElement('span');
      label.textContent = lang;
      toolbar.appendChild(label);

      if (navigator.clipboard) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'copy-button';
        button.textContent = 'copy';
        button.setAttribute('aria-label', 'Copy ' + lang + ' code');
        button.addEventListener('click', function () {
          var code = block.querySelector('pre');
          navigator.clipboard.writeText(code ? code.innerText.replace(/\n$/, '') : '').then(function () {
            button.textContent = 'copied ✓';
            setTimeout(function () { button.textContent = 'copy'; }, 1600);
          }, function () {
            button.textContent = 'copy failed';
          });
        });
        toolbar.appendChild(button);
      }

      block.classList.add('code-block');
      block.insertBefore(toolbar, block.firstChild);
    });

    // Tables: wrap so wide ones scroll instead of overflowing.
    content.querySelectorAll('table').forEach(function (table) {
      if (table.parentElement.classList.contains('table-scroll')) return;
      var wrap = document.createElement('div');
      wrap.className = 'table-scroll';
      table.parentNode.insertBefore(wrap, table);
      wrap.appendChild(table);
    });

    // Reading progress.
    var bar = document.querySelector('[data-read-progress]');
    if (bar) {
      var ticking = false;
      var update = function () {
        var rect = content.getBoundingClientRect();
        var total = rect.height - window.innerHeight;
        var progress = total > 0 ? Math.min(1, Math.max(0, -rect.top / total)) : 1;
        bar.style.transform = 'scaleX(' + progress + ')';
        ticking = false;
      };
      var onScroll = function () {
        if (!ticking) {
          ticking = true;
          window.requestAnimationFrame(update);
        }
      };
      window.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('resize', onScroll);
      update();
    }
  }

  /* Home page: topic filter chips over the post list. */
  function initFilters() {
    var log = document.querySelector('[data-post-log]');
    var group = document.querySelector('[data-filters]');
    if (!log || !group) return;

    var items = Array.prototype.slice.call(log.querySelectorAll('li[data-tags]'));
    var empty = document.querySelector('[data-post-log-empty]');
    var counts = {};
    items.forEach(function (li) {
      li._tags = li.getAttribute('data-tags').split(/\s+/).filter(Boolean);
      li._tags.forEach(function (t) { counts[t] = (counts[t] || 0) + 1; });
    });

    var top = Object.keys(counts)
      .sort(function (a, b) { return counts[b] - counts[a] || a.localeCompare(b); })
      .slice(0, 6);

    var params = new URLSearchParams(window.location.search);
    var initial = params.get('tag');
    if (initial && !counts[initial]) initial = null;
    if (initial && top.indexOf(initial) === -1) top.push(initial);

    var chips = [];
    function apply(tag) {
      var shown = 0;
      items.forEach(function (li) {
        var match = !tag || li._tags.indexOf(tag) !== -1;
        li.hidden = !match;
        if (match) shown++;
      });
      log.classList.toggle('is-filtering', Boolean(tag));
      if (empty) empty.hidden = shown > 0;
      chips.forEach(function (chip) {
        chip.setAttribute('aria-pressed', String(chip.dataset.tag === (tag || '')));
      });

      var url = new URL(window.location.href);
      if (tag) url.searchParams.set('tag', tag);
      else url.searchParams.delete('tag');
      window.history.replaceState(null, '', url);
    }

    [''].concat(top).forEach(function (tag) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.dataset.tag = tag;
      chip.textContent = tag || 'all';
      if (tag) chip.setAttribute('aria-label', tag + ' (' + counts[tag] + ' posts)');
      chip.addEventListener('click', function () { apply(tag || null); });
      group.appendChild(chip);
      chips.push(chip);
    });

    group.hidden = false;
    apply(initial);

    if (initial) {
      log.scrollIntoView({ block: 'start' });
    }
  }

  function init() {
    initPost();
    initFilters();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
