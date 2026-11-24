/* Same-source API documentation; no CDN or production build step. */
(function () {
  'use strict';

  var fragmentAliases = new Map();

  function renderMarkdown(source) {
    var aliases = new Map();
    var body = document.createElement('div');
    body.innerHTML = DOMPurify.sanitize(marked.parse(source, { gfm: true }), {
      ALLOWED_TAGS: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'a', 'strong', 'em', 'del',
        'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'br'],
      ALLOWED_ATTR: ['href', 'title', 'id', 'class', 'start', 'align'],
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false
    });

    var used = new Set(['main', 'sidebar', 'theme-toggle', 'menu-toggle', 'doc-search',
      'search-empty', 'scrim', 'sr-status', 'doc-body', 'doc-navigation', 'doc-toc',
      'doc-loading', 'doc-error', 'doc-retry']);
    // Reserve the complete shell, including SVG symbols, but not the previous
    // rendered document when retrying/reloading it.
    document.querySelectorAll('[id]').forEach(function (node) {
      if (!node.closest('#doc-body') || node.id === 'doc-body') used.add(node.id);
    });
    function remember(original, actual) {
      if (!aliases.has(original)) aliases.set(original, actual);
    }
    function unique(base) {
      var id = base;
      var n = 1;
      while (used.has(id)) id = base + '-' + n++;
      used.add(id);
      return id;
    }
    function slug(text) {
      return text.toLowerCase().trim().replace(/[^\p{L}\p{N}_\s-]/gu, '').replace(/\s/g, '-') || 'section';
    }

    // Only empty anchors carry explicit IDs. Do not let document HTML control
    // the surrounding UI's IDs, classes or delegated event selectors.
    body.querySelectorAll('*').forEach(function (node) {
      var lang = node.tagName === 'CODE' && node.parentElement.tagName === 'PRE'
        ? (node.className.match(/(?:^|\s)language-([\w-]+)/) || [])[1] : '';
      node.removeAttribute('class');
      if (lang) node.parentElement.dataset.lang = lang.toLowerCase();
      if (node.hasAttribute('id')) {
        var id = node.id;
        if (node.tagName === 'A' && !node.hasAttribute('href') && !node.textContent.trim() && /^[\p{L}\p{N}_-]+$/u.test(id)) {
          node.id = unique(id);
          remember(id, node.id);
        } else node.removeAttribute('id');
      }
    });

    body.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(function (heading) {
      var previous = heading.previousElementSibling;
      var anchor = previous && (previous.tagName === 'A' ? previous :
        previous.tagName === 'P' && previous.children.length === 1 && !previous.textContent.trim() ? previous.firstElementChild : null);
      var explicit = anchor && anchor.tagName === 'A' && anchor.id && !anchor.hasAttribute('href') ? anchor.id : '';
      var base = slug(heading.textContent);
      var headingId = explicit === base ? explicit : unique(base);
      remember(base, headingId);
      if (explicit) previous.remove();
      if (heading.tagName === 'H2') {
        heading.dataset.sectionId = explicit || headingId;
        if (headingId !== heading.dataset.sectionId) heading.id = headingId;
      } else {
        heading.id = headingId;
        if (explicit && explicit !== headingId) {
          var preserved = document.createElement('a');
          preserved.id = explicit;
          heading.before(preserved);
        }
      }
    });
    body.querySelectorAll('h2').forEach(function (heading) {
      var section = document.createElement('section');
      section.className = 'doc-section';
      section.id = heading.dataset.sectionId;
      heading.removeAttribute('data-section-id');
      heading.before(section);
      section.appendChild(heading);
      while (section.nextSibling && !(section.nextSibling.nodeType === 1 &&
        /^(H1|H2)$/.test(section.nextSibling.tagName))) {
        section.appendChild(section.nextSibling);
      }
    });
    body.querySelectorAll('table').forEach(function (table) {
      var wrap = document.createElement('div');
      wrap.className = 'table-wrap';
      table.before(wrap);
      wrap.appendChild(table);
    });
    body.querySelectorAll('pre').forEach(function (pre) {
      pre.className = 'code';
      if (!pre.dataset.lang) pre.dataset.lang = 'text';
    });
    var h1 = body.querySelector('h1');
    if (h1) {
      var hero = document.createElement('header');
      hero.className = 'hero';
      h1.before(hero);
      hero.appendChild(h1);
      if (hero.nextElementSibling && hero.nextElementSibling.tagName === 'P') {
        hero.nextElementSibling.className = 'lead';
        hero.appendChild(hero.nextElementSibling);
      }
    }
    body.querySelectorAll('a[href^="#"]').forEach(function (link) {
      try {
        var fragment = decodeURIComponent(link.getAttribute('href').slice(1));
        if (aliases.has(fragment)) link.setAttribute('href', '#' + aliases.get(fragment));
      } catch (e) { /* malformed fragment */ }
    });
    fragmentAliases = aliases;
    return body.innerHTML;
  }

  function buildNavigation(body) {
    var navigation = document.getElementById('doc-navigation');
    var toc = document.getElementById('doc-toc');
    navigation.replaceChildren();
    toc.replaceChildren();
    var group = document.createElement('div');
    group.className = 'nav-group';
    var title = document.createElement('p');
    title.className = 'nav-group-title';
    title.textContent = 'API 参考';
    var list = document.createElement('ul');
    group.append(title, list);
    navigation.appendChild(group);
    body.querySelectorAll('.doc-section').forEach(function (section) {
      var link = document.createElement('a');
      link.setAttribute('href', '#' + section.id);
      link.textContent = section.querySelector('h2').textContent;
      link.dataset.keywords = section.textContent.replace(/\s+/g, ' ');
      var item = document.createElement('li');
      item.appendChild(link);
      list.appendChild(item);
      var tocItem = document.createElement('li');
      var tocLink = link.cloneNode(true);
      tocLink.removeAttribute('data-keywords');
      tocItem.appendChild(tocLink);
      toc.appendChild(tocItem);
    });
  }

  var pending = null;
  function load() {
    if (pending) return pending;
    var body = document.getElementById('doc-body');
    var loading = document.getElementById('doc-loading');
    var error = document.getElementById('doc-error');
    var retry = document.getElementById('doc-retry');
    loading.hidden = false;
    error.hidden = true;
    body.setAttribute('aria-busy', 'true');
    retry.disabled = true;
    var controller = new AbortController();
    var timer = window.setTimeout(function () { controller.abort(); }, 15000);
    pending = (async function () {
      try {
        var response = await fetch('/docs/api.md', { signal: controller.signal });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        var source = await response.text();
        if (!source.trim()) throw new Error('Empty documentation');
        body.innerHTML = renderMarkdown(source);
        buildNavigation(body);
        document.dispatchEvent(new CustomEvent('edge-docs-ready'));
        try {
          var fragment = decodeURIComponent(location.hash.slice(1));
          var target = document.getElementById(fragmentAliases.get(fragment) || fragment);
          if (location.hash && target && body.contains(target)) target.scrollIntoView();
        } catch (e) { /* malformed URL fragment */ }
      } catch (e) {
        error.hidden = false;
      } finally {
        window.clearTimeout(timer);
        loading.hidden = true;
        body.setAttribute('aria-busy', 'false');
        retry.disabled = false;
        pending = null;
      }
    })();
    return pending;
  }

  window.EdgeDocs = { renderMarkdown: renderMarkdown, load: load };
  var retry = document.getElementById('doc-retry');
  if (retry) retry.addEventListener('click', load);
})();
