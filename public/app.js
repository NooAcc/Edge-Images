/* Edge Image — API documentation interactions */
(function () {
  'use strict';

  var root = document.documentElement;
  var $ = function (sel, ctx) { return (ctx || document).querySelector(sel); };
  var $$ = function (sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); };
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------------------------------------------------------------------
     Theme
     --------------------------------------------------------------------- */

  var themeBtn = $('#theme-toggle');

  function applyTheme(theme) {
    var dark = theme === 'dark';
    root.setAttribute('data-theme', theme);
    if (themeBtn) {
      themeBtn.setAttribute('aria-pressed', String(dark));
      themeBtn.setAttribute('aria-label', dark ? '切换到浅色主题' : '切换到深色主题');
      themeBtn.title = dark ? '切换到浅色主题' : '切换到深色主题';
    }
  }

  applyTheme(root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');

  if (themeBtn) {
    themeBtn.addEventListener('click', function () {
      var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      try { localStorage.setItem('edge-image-theme', next); } catch (e) { /* private mode */ }
    });
  }

  try {
    if (!localStorage.getItem('edge-image-theme') && window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var onScheme = function (ev) { applyTheme(ev.matches ? 'dark' : 'light'); };
      if (mq.addEventListener) mq.addEventListener('change', onScheme);
      else if (mq.addListener) mq.addListener(onScheme);
    }
  } catch (e) { /* ignore */ }

  /* ---------------------------------------------------------------------
     Copy to clipboard
     --------------------------------------------------------------------- */

  var srStatus = $('#sr-status');

  function announce(message) {
    if (!srStatus) return;
    srStatus.textContent = '';
    window.setTimeout(function () { srStatus.textContent = message; }, 40);
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    document.body.removeChild(ta);
  }

  document.addEventListener('click', function (event) {
    var btn = event.target.closest ? event.target.closest('.copy-btn') : null;
    if (!btn) return;

    var text = '';
    if (btn.hasAttribute('data-copy-text')) {
      text = btn.getAttribute('data-copy-text');
    } else if (btn.hasAttribute('data-copy-target')) {
      var target = $(btn.getAttribute('data-copy-target'));
      if (target) text = target.textContent;
    } else {
      var block = btn.closest('.codeblock');
      if (block) {
        var code = $('code', block);
        if (code) text = code.textContent;
      }
    }

    text = (text || '').trim();
    if (!text) return;

    var done = function () {
      var label = $('.copy-label', btn);
      var previous = label ? label.textContent : '';
      btn.classList.add('is-copied');
      if (label) label.textContent = '已复制';
      announce('已复制到剪贴板');
      window.clearTimeout(btn._copyTimer);
      btn._copyTimer = window.setTimeout(function () {
        btn.classList.remove('is-copied');
        if (label && previous) label.textContent = previous;
      }, 1600);
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () {
        fallbackCopy(text);
        done();
      });
    } else {
      fallbackCopy(text);
      done();
    }
  });

  /* ---------------------------------------------------------------------
     Syntax highlighting
     --------------------------------------------------------------------- */

  var ESCAPES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  };

  function esc(value) {
    return String(value).replace(/[&<>"']/g, function (ch) { return ESCAPES[ch]; });
  }

  function hlJSON(src) {
    var re = /"(?:\\.|[^"\\])*"(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
    var out = '';
    var last = 0;
    var m;
    while ((m = re.exec(src))) {
      out += esc(src.slice(last, m.index));
      var token = m[0];
      if (token.charAt(0) === '"') {
        if (m[1]) {
          out += '<span class="tok-key">' + esc(token) + '</span>' +
            '<span class="tok-punct">' + esc(m[1]) + '</span>';
        } else {
          out += '<span class="tok-str">' + esc(token) + '</span>';
        }
      } else if (/^(true|false|null)$/.test(token)) {
        out += '<span class="tok-lit">' + token + '</span>';
      } else {
        out += '<span class="tok-num">' + token + '</span>';
      }
      last = re.lastIndex;
    }
    return out + esc(src.slice(last));
  }

  function hlHTTP(src) {
    return src.split('\n').map(function (line, index) {
      if (index === 0) {
        var status = line.match(/^(HTTP\/[\d.]+)\s+(\d{3})(.*)$/);
        if (status) {
          return '<span class="tok-punct">' + esc(status[1]) + '</span> ' +
            '<span class="tok-num">' + esc(status[2]) + '</span>' +
            '<span class="tok-str">' + esc(status[3]) + '</span>';
        }
        var req = line.match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)(\s+)(\S+)(\s+HTTP\/[\d.]+)?\s*$/);
        if (req) {
          return '<span class="tok-method">' + req[1] + '</span>' + esc(req[2]) +
            '<span class="tok-str">' + esc(req[3]) + '</span>' +
            (req[4] ? '<span class="tok-punct">' + esc(req[4]) + '</span>' : '');
        }
      }
      var colon = line.indexOf(':');
      if (colon > 0 && /^[A-Za-z0-9-]+$/.test(line.slice(0, colon))) {
        return '<span class="tok-key">' + esc(line.slice(0, colon)) + '</span>' +
          '<span class="tok-punct">:</span>' +
          '<span class="tok-str">' + esc(line.slice(colon + 1)) + '</span>';
      }
      if (line.trim().indexOf('{') === 0 || line.trim().indexOf('}') === 0 ||
          line.trim().indexOf('[') === 0 || line.trim().indexOf(']') === 0) {
        return '<span class="tok-punct">' + esc(line) + '</span>';
      }
      return esc(line);
    }).join('\n');
  }

  function hlBash(src) {
    var re = /(#[^\n]*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|\b(curl)\b|(--?[A-Za-z][\w-]*)/g;
    var out = '';
    var last = 0;
    var m;
    while ((m = re.exec(src))) {
      out += esc(src.slice(last, m.index));
      if (m[1]) out += '<span class="tok-comment">' + esc(m[1]) + '</span>';
      else if (m[2]) out += '<span class="tok-str">' + esc(m[2]) + '</span>';
      else if (m[3]) out += '<span class="tok-method">' + esc(m[3]) + '</span>';
      else out += '<span class="tok-flag">' + esc(m[4]) + '</span>';
      last = re.lastIndex;
    }
    return out + esc(src.slice(last));
  }

  function hlHTML(src) {
    var re = /<!--[\s\S]*?-->|<\/?([A-Za-z][\w-]*)([^>]*)>/g;
    var out = '';
    var last = 0;
    var m;
    while ((m = re.exec(src))) {
      out += esc(src.slice(last, m.index));
      if (m[0].indexOf('<!--') === 0) {
        out += '<span class="tok-comment">' + esc(m[0]) + '</span>';
      } else {
        var open = /^<\/?/.exec(m[0])[0];
        var attrs = esc(m[2] || '').replace(
          /([\w:-]+)(=)(&quot;[^&]*?&quot;|'[^']*?')/g,
          '<span class="tok-attr">$1</span><span class="tok-punct">$2</span><span class="tok-str">$3</span>'
        );
        out += '<span class="tok-punct">' + esc(open) + '</span>' +
          '<span class="tok-tag">' + esc(m[1]) + '</span>' + attrs +
          '<span class="tok-punct">&gt;</span>';
      }
      last = re.lastIndex;
    }
    return out + esc(src.slice(last));
  }

  function hlJS(src) {
    var re = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\b(const|let|var|await|async|function|return|new|if|else|try|catch|for|of|fetch)\b|(\b\d+\b)/g;
    var out = '';
    var last = 0;
    var m;
    while ((m = re.exec(src))) {
      out += esc(src.slice(last, m.index));
      if (m[1]) out += '<span class="tok-comment">' + esc(m[1]) + '</span>';
      else if (m[2]) out += '<span class="tok-str">' + esc(m[2]) + '</span>';
      else if (m[3]) out += '<span class="tok-method">' + esc(m[3]) + '</span>';
      else out += '<span class="tok-num">' + esc(m[4]) + '</span>';
      last = re.lastIndex;
    }
    return out + esc(src.slice(last));
  }

  function highlight(src, lang) {
    switch (lang) {
      case 'json': return hlJSON(src);
      case 'http': return hlHTTP(src);
      case 'bash':
      case 'sh':
      case 'shell': return hlBash(src);
      case 'html': return hlHTML(src);
      case 'js':
      case 'javascript': return hlJS(src);
      default: return esc(src);
    }
  }

  function enhanceCodeBlocks(scope) {
    $$('pre.code', scope || document).forEach(function (pre) {
      if (pre.dataset.enhanced === '1') return;
      pre.dataset.enhanced = '1';

      var code = $('code', pre) || pre;
      var lang = (pre.getAttribute('data-lang') || 'text').toLowerCase();
      var raw = code.textContent.replace(/^\n+/, '').replace(/\n+$/, '');
      code.innerHTML = highlight(raw, lang);

      if (pre.closest('.codeblock')) return;

      var wrap = document.createElement('div');
      wrap.className = 'codeblock';

      var bar = document.createElement('div');
      bar.className = 'codeblock-bar';
      bar.innerHTML = '<span class="code-lang">' + esc(lang) + '</span>' +
        '<button class="copy-btn" type="button">' +
        '<svg class="icon" aria-hidden="true" focusable="false"><use href="#i-copy"></use></svg>' +
        '<span class="copy-label">复制</span></button>';

      pre.parentNode.insertBefore(wrap, pre);
      wrap.appendChild(bar);
      wrap.appendChild(pre);
    });
  }

  enhanceCodeBlocks();

  /* ---------------------------------------------------------------------
     Active section (sidebar + TOC)
     --------------------------------------------------------------------- */

  var sections = $$('.doc-section[id]');
  var anchoredLinks = $$('.sidebar-nav a[href^="#"], .toc a[href^="#"]');
  var headerHeight = 60;

  function syncHeaderHeight() {
    var styles = getComputedStyle(root);
    headerHeight = parseInt(styles.getPropertyValue('--header-h'), 10) || 60;
  }

  function updateActiveSection() {
    if (!sections.length) return;
    // Activate a section once its heading enters the upper part of the
    // viewport, not only when it crosses the sticky header.
    var readingLine = Math.min(Math.max(window.innerHeight * 0.25, 140), 300);
    var threshold = window.scrollY + headerHeight + readingLine;
    var current = sections[0].id;

    for (var i = 0; i < sections.length; i++) {
      if (sections[i].getBoundingClientRect().top + window.scrollY <= threshold) {
        current = sections[i].id;
      } else {
        break;
      }
    }

    if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 4) {
      current = sections[sections.length - 1].id;
    }

    anchoredLinks.forEach(function (link) {
      var isActive = link.getAttribute('href') === '#' + current;
      link.classList.toggle('is-active', isActive);
      if (isActive) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
    });
  }

  var ticking = false;
  function requestActiveUpdate() {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(function () {
      updateActiveSection();
      ticking = false;
    });
  }

  syncHeaderHeight();
  updateActiveSection();
  window.addEventListener('scroll', requestActiveUpdate, { passive: true });
  window.addEventListener('resize', function () {
    syncHeaderHeight();
    requestActiveUpdate();
  });

  /* ---------------------------------------------------------------------
     Sidebar search
     --------------------------------------------------------------------- */

  var search = $('#doc-search');
  var searchEmpty = $('#search-empty');

  function filterNav() {
    if (!search) return;
    var query = search.value.trim().toLowerCase();
    var total = 0;

    $$('.sidebar-nav .nav-group').forEach(function (group) {
      var shown = 0;
      $$('a', group).forEach(function (link) {
        var haystack = (link.textContent + ' ' + (link.dataset.keywords || '')).toLowerCase();
        var hit = !query || haystack.indexOf(query) !== -1;
        var item = link.closest('li');
        if (item) item.hidden = !hit;
        if (hit) shown += 1;
      });
      group.hidden = shown === 0;
      total += shown;
    });

    if (searchEmpty) searchEmpty.hidden = !(query && total === 0);
  }

  if (search) {
    search.addEventListener('input', filterNav);
    search.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        search.value = '';
        filterNav();
        search.blur();
      }
    });
  }

  document.addEventListener('keydown', function (event) {
    var tag = event.target.tagName;
    var typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
      event.target.isContentEditable;

    if (event.key === '/' && !typing && search) {
      event.preventDefault();
      if (window.innerWidth <= 960) openSidebar(false);
      search.focus();
      search.select();
    }
  });

  /* ---------------------------------------------------------------------
     Mobile sidebar drawer
     --------------------------------------------------------------------- */

  var menuBtn = $('#menu-toggle');
  var sidebar = $('#sidebar');
  var scrim = $('#scrim');
  var sidebarOpen = false;
  var lastFocused = null;

  function focusableInSidebar() {
    if (!sidebar) return [];
    return $$('a,button,input,select,textarea', sidebar).filter(function (el) {
      return !el.disabled && el.offsetParent !== null;
    });
  }

  function openSidebar(shouldFocus) {
    if (!sidebar || !menuBtn || sidebarOpen) return;
    sidebarOpen = true;
    lastFocused = document.activeElement;
    sidebar.classList.add('is-open');
    if (scrim) scrim.hidden = false;
    menuBtn.setAttribute('aria-expanded', 'true');
    menuBtn.setAttribute('aria-label', '关闭导航');
    document.body.classList.add('no-scroll');

    if (shouldFocus !== false) {
      window.setTimeout(function () {
        var first = focusableInSidebar()[0];
        if (first) first.focus();
      }, 60);
    }
  }

  function closeSidebar(returnFocus) {
    if (!sidebar || !sidebarOpen) return;
    sidebarOpen = false;
    sidebar.classList.remove('is-open');
    if (scrim) scrim.hidden = true;
    if (menuBtn) {
      menuBtn.setAttribute('aria-expanded', 'false');
      menuBtn.setAttribute('aria-label', '打开导航');
    }
    document.body.classList.remove('no-scroll');

    if (returnFocus !== false) {
      var target = lastFocused && document.contains(lastFocused) ? lastFocused : menuBtn;
      if (target) target.focus();
    }
  }

  if (menuBtn) {
    menuBtn.addEventListener('click', function () {
      if (sidebarOpen) closeSidebar();
      else openSidebar();
    });
  }

  if (scrim) scrim.addEventListener('click', function () { closeSidebar(); });

  if (sidebar) {
    sidebar.addEventListener('click', function (event) {
      if (event.target.closest('a')) closeSidebar(false);
    });
  }

  document.addEventListener('keydown', function (event) {
    if (!sidebarOpen) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      closeSidebar();
      return;
    }

    if (event.key === 'Tab') {
      var focusables = focusableInSidebar();
      if (!focusables.length) return;
      var first = focusables[0];
      var last = focusables[focusables.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });

  window.addEventListener('resize', function () {
    if (window.innerWidth > 960 && sidebarOpen) closeSidebar(false);
  });

  /* Re-render highlight when content changes are made after load. */
  window.EdgeDocs = {
    highlight: highlight,
    enhanceCodeBlocks: enhanceCodeBlocks
  };
})();
