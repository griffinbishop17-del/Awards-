/* Rabbit Rabbi Awards — public voting page.
 * The server is the source of truth for everything that matters (voting status,
 * one ballot per token, validation). This file only drives the interface.
 * Choices are kept in localStorage purely as a convenience so a refresh doesn't
 * lose someone's picks; they are re-validated against the server's category list. */
(function () {
  'use strict';

  var DRAFT_KEY = 'rra_draft_v1';
  var root = document.getElementById('ballot-root');
  var chip = document.getElementById('status-chip');
  var chipText = document.getElementById('status-text');
  var sub = document.getElementById('ballot-sub');
  var bar = document.getElementById('progress-bar');
  var barLabel = document.getElementById('progress-label');
  var barDots = document.getElementById('progress-dots');
  var barBtn = document.getElementById('progress-btn');
  var dlg = document.getElementById('review');
  var reviewList = document.getElementById('review-list');
  var reviewError = document.getElementById('review-error');
  var submitBtn = document.getElementById('review-submit');
  var submitLabel = document.getElementById('submit-label');

  var categories = [];
  var choices = {};
  var submitting = false;

  // ---------- tiny helpers (everything is built with textContent: no HTML injection) ----------
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else if (attrs[k] !== false && attrs[k] != null) n.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  var SVG_NS = 'http://www.w3.org/2000/svg';
  function icon(pathD, extra) {
    var s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '3'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true');
    var p = document.createElementNS(SVG_NS, 'path'); p.setAttribute('d', pathD); s.appendChild(p);
    if (extra) s.setAttribute('class', extra);
    return s;
  }
  var CHECK = 'M5 12.5l4.5 4.5L19 7.5';
  var LOCK = 'M7 11V8a5 5 0 0110 0v3M6 11h12v9H6z';

  function initials(name) { return name.trim().slice(0, 2).toUpperCase(); }
  function hue(id) { var h = 0; for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0; return h % 6; }

  function avatar(n) {
    var a = el('span', { class: 'avatar av' + hue(n.id), 'aria-hidden': 'true' });
    if (n.image) {
      var img = el('img', { src: n.image, alt: '', loading: 'lazy', width: '72', height: '72' });
      img.addEventListener('error', function () { img.remove(); a.textContent = initials(n.name); });
      a.appendChild(img);
    } else a.textContent = initials(n.name);
    return a;
  }

  function nomineeName(catId, nomId) {
    for (var i = 0; i < categories.length; i++) if (categories[i].id === catId) {
      for (var j = 0; j < categories[i].nominees.length; j++) if (categories[i].nominees[j].id === nomId) return categories[i].nominees[j].name;
    }
    return '';
  }

  // ---------- draft persistence (convenience only) ----------
  function loadDraft() {
    try {
      var d = JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}');
      choices = {};
      categories.forEach(function (c) {
        if (typeof d[c.id] === 'string' && c.nominees.some(function (n) { return n.id === d[c.id]; })) choices[c.id] = d[c.id];
      });
    } catch (e) { choices = {}; }
  }
  function saveDraft() { try { localStorage.setItem(DRAFT_KEY, JSON.stringify(choices)); } catch (e) { /* storage unavailable: fine */ } }
  function clearDraft() { try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* ignore */ } }

  // ---------- status chip ----------
  function setChip(open) {
    chip.className = 'status-chip ' + (open ? 'open' : 'closed');
    chipText.textContent = open ? 'Voting is open' : 'Voting has ended';
  }

  // ---------- marquee ----------
  function buildMarquee() {
    var m = document.getElementById('marquee');
    if (m.firstChild) return;
    function group() {
      var g = el('div', { class: 'marquee-group' });
      categories.forEach(function (c) { g.appendChild(el('span', { text: c.name })); g.appendChild(el('span', { text: '★' })); });
      return g;
    }
    m.appendChild(group()); m.appendChild(group());
  }

  // ---------- panels ----------
  function panel(kind, iconPath, title, text, extra) {
    root.setAttribute('aria-busy', 'false');
    bar.hidden = true;
    root.replaceChildren(el('div', { class: 'panel reveal ' + kind }, [
      el('div', { class: 'big-icon' }, [icon(iconPath)]),
      el('h2', { text: title }),
      el('p', { text: text }),
      extra
    ]));
  }
  function showClosed() {
    sub.textContent = 'The polls are closed.';
    panel('closed', LOCK, 'Voting has ended', 'Thanks for stopping by. The ballot box is closed and the votes are being counted. Winners will be revealed at the ceremony.');
  }
  function showAlreadyVoted() {
    sub.textContent = 'Your ballot is in.';
    clearDraft();
    panel('good', CHECK, 'You have already voted', 'A ballot has been submitted from this browser, so you are all set. Results stay secret until the ceremony.');
  }
  function showSuccess(recap) {
    sub.textContent = 'Your ballot is in.';
    var list = el('ul', { class: 'recap' });
    recap.forEach(function (r) { list.appendChild(el('li', null, [el('span', { text: r[0] }), el('span', { text: r[1] })])); });
    panel('good', CHECK, 'Ballot submitted!', 'Thank you for voting. Your choices have been saved. Results stay secret until the ceremony.', list);
    document.getElementById('ballot').scrollIntoView({ block: 'start' });
  }
  function showLoadError(msg) {
    root.setAttribute('aria-busy', 'false');
    bar.hidden = true;
    var retry = el('button', { class: 'btn btn-primary', type: 'button', text: 'Try again' });
    retry.addEventListener('click', load);
    root.replaceChildren(el('div', { class: 'panel' }, [
      el('h2', { text: 'Booth temporarily unavailable' }),
      el('p', { text: msg || 'We could not reach the voting booth. Please check your connection and try again.' }),
      el('div', { class: 'hero-actions' }, [retry])
    ]));
  }

  // ---------- ballot rendering ----------
  function render() {
    root.setAttribute('aria-busy', 'false');
    var frag = document.createDocumentFragment();
    categories.forEach(function (cat, i) {
      var group = el('div', { class: 'nominees n' + cat.nominees.length, role: 'radiogroup', 'aria-labelledby': 'name-' + cat.id });
      cat.nominees.forEach(function (n) {
        var inputId = 'n-' + cat.id + '-' + n.id;
        var input = el('input', { type: 'radio', name: 'cat-' + cat.id, id: inputId, value: n.id, 'data-cat': cat.id });
        if (choices[cat.id] === n.id) input.checked = true;
        input.setAttribute('aria-label', n.name + ' for ' + cat.name);
        var card = el('span', { class: 'card' }, [avatar(n), el('span', { class: 'nominee-name', text: n.name }), el('span', { class: 'tick' }, [icon(CHECK)])]);
        group.appendChild(el('label', { class: 'nominee', for: inputId }, [input, card]));
      });
      var pill = el('span', { class: 'pill', id: 'pill-' + cat.id });
      var fs = el('div', { class: 'category', id: 'cat-' + cat.id }, [
        el('div', { class: 'cat-card' }, [
          el('div', { class: 'cat-head' }, [
            el('span', { class: 'cat-num', 'aria-hidden': 'true', text: String(i + 1) }),
            el('div', { class: 'cat-title' }, [el('h3', { class: 'cat-name', id: 'name-' + cat.id, text: cat.name }), cat.blurb ? el('span', { class: 'blurb', text: cat.blurb }) : null]),
            pill
          ]),
          group
        ])
      ]);
      frag.appendChild(fs);
    });
    root.replaceChildren(frag);

    // dots
    barDots.replaceChildren.apply(barDots, categories.map(function (cat, i) {
      var a = el('a', { href: '#cat-' + cat.id, id: 'dot-' + cat.id, 'aria-label': 'Category ' + (i + 1) + ': ' + cat.name });
      return el('li', null, [a]);
    }));
    bar.hidden = false;
    updateProgress();
  }

  function firstIncomplete() {
    for (var i = 0; i < categories.length; i++) if (!choices[categories[i].id]) return categories[i];
    return null;
  }

  function updateProgress() {
    var done = 0;
    categories.forEach(function (cat) {
      var has = !!choices[cat.id];
      if (has) done++;
      var fs = document.getElementById('cat-' + cat.id);
      var pill = document.getElementById('pill-' + cat.id);
      var dot = document.getElementById('dot-' + cat.id);
      if (fs) fs.classList.toggle('done', has);
      if (pill) pill.textContent = has ? '✓ ' + nomineeName(cat.id, choices[cat.id]) : 'Needs a pick';
      if (dot) {
        dot.classList.toggle('done', has);
        dot.setAttribute('aria-label', dot.getAttribute('aria-label').replace(/ \((chosen|not chosen)\)$/, '') + (has ? ' (chosen)' : ' (not chosen)'));
      }
    });
    var total = categories.length;
    barLabel.textContent = '';
    barLabel.appendChild(document.createTextNode(done + ' of ' + total + ' chosen '));
    if (done < total) { var s = el('small', { text: '— ' + (total - done) + ' to go' }); barLabel.appendChild(s); }
    else barLabel.appendChild(el('small', { text: '— all set!' }));
    barBtn.textContent = done === total ? 'Review ballot' : 'Next category';
  }

  root.addEventListener('change', function (e) {
    var t = e.target;
    if (!t || t.type !== 'radio' || !t.dataset.cat) return;
    choices[t.dataset.cat] = t.value;
    saveDraft();
    updateProgress();
  });

  barBtn.addEventListener('click', function () {
    var next = firstIncomplete();
    if (next) {
      var target = document.getElementById('cat-' + next.id);
      target.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
      var firstInput = target.querySelector('input'); if (firstInput) setTimeout(function () { firstInput.focus({ preventScroll: true }); }, 350);
    } else openReview();
  });

  // ---------- review & submit ----------
  function openReview() {
    reviewError.hidden = true;
    reviewList.replaceChildren.apply(reviewList, categories.map(function (cat) {
      var change = el('button', { class: 'link-btn', type: 'button', 'aria-label': 'Change your pick for ' + cat.name, text: 'Change' });
      change.addEventListener('click', function () {
        dlg.close();
        var t = document.getElementById('cat-' + cat.id);
        t.scrollIntoView({ block: 'start' });
        var checked = t.querySelector('input:checked') || t.querySelector('input'); if (checked) checked.focus({ preventScroll: true });
      });
      return el('li', null, [
        el('div', { class: 'cat' }, [el('small', { text: cat.name }), el('strong', { text: nomineeName(cat.id, choices[cat.id]) })]),
        change
      ]);
    }));
    setSubmitting(false);
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  }
  document.getElementById('review-back').addEventListener('click', function () { if (!submitting) dlg.close(); });
  dlg.addEventListener('cancel', function (e) { if (submitting) e.preventDefault(); });

  function setSubmitting(on) {
    submitting = on;
    submitBtn.disabled = on;
    submitBtn.setAttribute('aria-busy', on ? 'true' : 'false');
    document.getElementById('review-back').disabled = on;
    submitLabel.textContent = on ? 'Submitting…' : 'Submit my ballot';
    var old = submitBtn.querySelector('.spinner'); if (old) old.remove();
    if (on) submitBtn.insertBefore(el('span', { class: 'spinner', 'aria-hidden': 'true' }), submitBtn.firstChild);
  }
  function reviewFail(msg) { reviewError.textContent = msg; reviewError.hidden = false; setSubmitting(false); }

  function post(retried) {
    return fetch('/api/ballot', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ choices: choices })
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) { return { status: res.status, data: data }; });
    }).then(function (r) {
      if (r.status === 201) return r;
      // Ballot session expired: get a fresh one silently and retry once, keeping all picks.
      if (r.data.code === 'TOKEN_INVALID' && !retried) {
        return fetch('/api/ballot', { credentials: 'same-origin' }).then(function () { return post(true); });
      }
      return r;
    });
  }

  submitBtn.addEventListener('click', function () {
    if (submitting) return; // ignore double taps
    if (firstIncomplete()) return reviewFail('Please pick a nominee in every category first.');
    reviewError.hidden = true;
    setSubmitting(true);
    post(false).then(function (r) {
      if (r.status === 201) {
        var recap = categories.map(function (c) { return [c.name, nomineeName(c.id, choices[c.id])]; });
        clearDraft(); dlg.close(); setSubmitting(false); setChip(true); showSuccess(recap);
        return;
      }
      var code = r.data && r.data.code;
      if (code === 'ALREADY_VOTED') { dlg.close(); setSubmitting(false); showAlreadyVoted(); return; }
      if (code === 'CLOSED') { dlg.close(); setSubmitting(false); setChip(false); showClosed(); return; }
      if (r.status === 429) return reviewFail('Too many attempts from this connection. Please wait a few minutes, then submit again. Your picks are saved.');
      reviewFail((r.data && r.data.error) || 'Something went wrong. Your picks are still here, so please try again.');
    }).catch(function () {
      reviewFail('We could not reach the server. Check your connection and tap submit again. Your picks are still here.');
    });
  });

  // ---------- startup ----------
  function load() {
    root.setAttribute('aria-busy', 'true');
    fetch('/api/ballot', { credentials: 'same-origin' })
      .then(function (res) { return res.json().catch(function () { return {}; }).then(function (d) { return { ok: res.ok, status: res.status, d: d }; }); })
      .then(function (r) {
        if (!r.ok) return showLoadError(r.d && r.d.error);
        categories = r.d.categories || [];
        buildMarquee();
        setChip(!!r.d.open);
        if (r.d.ballot === 'used') return showAlreadyVoted();
        if (!r.d.open || r.d.ballot === 'closed') return showClosed();
        sub.textContent = 'Choose one nominee in each category.';
        loadDraft();
        render();
      })
      .catch(function () { showLoadError(); });
  }
  load();
})();
