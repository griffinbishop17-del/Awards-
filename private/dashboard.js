/* Admin dashboard. Served only to a signed-in admin (see server/index.js).
 * Every API call below is independently protected on the server. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var csrf = null;
  var voting = null;        // { open, changedAt, lastOpenedAt, lastClosedAt }
  var timer = null;
  var pendingOpen = null;   // what the confirm dialog will set

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'class') n.className = attrs[k]; else if (k === 'text') n.textContent = attrs[k]; else n.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  function fmt(iso) {
    if (!iso) return 'never';
    try { return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' }); } catch (e) { return iso; }
  }
  function pct(n) { return (Math.round(n * 10) / 10).toFixed(1) + '%'; }

  function api(path, opts) {
    opts = opts || {};
    var headers = { Accept: 'application/json' };
    if (opts.body) { headers['Content-Type'] = 'application/json'; headers['X-CSRF-Token'] = csrf || ''; }
    return fetch(path, { method: opts.method || 'GET', credentials: 'same-origin', headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined })
      .then(function (res) {
        if (res.status === 401) { window.location.assign('/admin'); return Promise.reject(new Error('signed-out')); }
        return res.json().catch(function () { return {}; }).then(function (d) { d.__status = res.status; d.__ok = res.ok; return d; });
      });
  }

  // ---------- rendering ----------
  function showBanner(msg) { $('banner').textContent = msg; $('banner').hidden = !msg; }

  function renderVoting() {
    var card = $('control'), btn = $('toggle-voting');
    if (!voting) {
      card.className = 'control-card error';
      $('state-text').textContent = 'Voting status unavailable';
      $('state-meta').replaceChildren(el('span', { text: 'A system error is preventing the status from loading. Votes already saved are safe.' }));
      btn.disabled = true; btn.textContent = 'Unavailable';
      return;
    }
    card.className = 'control-card ' + (voting.open ? 'open' : 'closed');
    $('state-text').textContent = voting.open ? 'Voting is OPEN' : 'Voting is CLOSED';
    $('state-meta').replaceChildren(
      el('span', { text: 'Last opened: ' + fmt(voting.lastOpenedAt) }),
      el('span', { text: 'Last closed: ' + fmt(voting.lastClosedAt) })
    );
    btn.disabled = false;
    btn.className = 'btn btn-lg ' + (voting.open ? 'btn-danger' : 'btn-primary');
    btn.textContent = voting.open ? 'Close voting' : (voting.lastClosedAt ? 'Reopen voting' : 'Open voting');
  }

  function renderResults(r) {
    $('total').textContent = String(r.totalBallots);
    $('updated').textContent = fmt(r.generatedAt);
    $('cat-count').textContent = String(r.categories.length);
    var wrap = $('results');
    if (!r.totalBallots) {
      wrap.replaceChildren(el('div', { class: 'empty', text: 'No ballots yet. Every nominee shows 0 votes until the first ballot arrives.' }));
      wrap.className = '';
    } else wrap.className = 'results';
    var cards = r.categories.map(function (cat) {
      var badge = cat.tie ? el('span', { class: 'badge tie', text: 'TIE · ' + cat.leaders.length + ' WAY' })
        : cat.leaders.length ? el('span', { class: 'badge lead', text: 'Leader: ' + cat.nominees.filter(function (n) { return n.id === cat.leaders[0]; })[0].name })
        : el('span', { class: 'badge', text: 'No votes' });
      var rows = cat.nominees.map(function (n) {
        var isLead = cat.leaders.indexOf(n.id) !== -1;
        var cls = 'bar-row' + (isLead ? (cat.tie ? ' tied' : ' leader') : '') + (n.votes === 0 ? ' zero' : '');
        var fill = el('div', { class: 'fill' });
        fill.style.setProperty('--p', String(Math.max(0, Math.min(100, n.percent))));
        var track = el('div', { class: 'track', role: 'img', 'aria-label': n.name + ': ' + n.votes + ' votes, ' + pct(n.percent) });
        track.appendChild(fill);
        var nums = el('span', { class: 'nums' });
        nums.appendChild(el('b', { text: String(n.votes) }));
        nums.appendChild(document.createTextNode(' vote' + (n.votes === 1 ? '' : 's') + ' · ' + pct(n.percent)));
        return el('li', { class: cls }, [el('div', { class: 'top' }, [el('span', { class: 'nm', text: n.name }), nums]), track]);
      });
      return el('article', { class: 'res-card' }, [el('div', { class: 'res-head' }, [el('h2', { text: cat.name }), badge]), el('ul', { class: 'bars' }, rows)]);
    });
    if (r.totalBallots) wrap.replaceChildren.apply(wrap, cards);
    else wrap.appendChild(el('div', { class: 'results' }, cards)); // zero-vote nominees are always shown
  }

  // ---------- data ----------
  function refresh() {
    var btn = $('refresh'); btn.disabled = true;
    return api('/api/admin/results').then(function (d) {
      if (!d.__ok) {
        voting = null; renderVoting();
        showBanner(d.error || 'Could not load results.');
        return;
      }
      showBanner('');
      voting = d.voting; renderVoting(); renderResults(d.results);
    }).catch(function (e) {
      if (e.message === 'signed-out') return;
      voting = null; renderVoting(); showBanner('Could not reach the server. Results below may be out of date.');
    }).then(function () { btn.disabled = false; });
  }

  function setAuto(on) {
    clearInterval(timer);
    if (on) timer = setInterval(function () { if (!document.hidden) refresh(); }, 15000);
    try { localStorage.setItem('rra_admin_auto', on ? '1' : '0'); } catch (e) { /* ignore */ }
  }

  // ---------- confirm dialog ----------
  var dlg = $('confirm');
  function askToggle() {
    if (!voting) return;
    pendingOpen = !voting.open;
    $('confirm-title').textContent = pendingOpen ? (voting.lastClosedAt ? 'Reopen voting?' : 'Open voting?') : 'Close voting now?';
    $('confirm-text').textContent = pendingOpen
      ? 'Visitors who have not voted yet will be able to submit a ballot. Ballots already submitted stay exactly as they are, and nobody who has voted can vote again.'
      : 'This takes effect immediately. No new ballots will be accepted, including ones people are filling out right now. You can reopen voting later.';
    var ok = $('confirm-ok');
    ok.textContent = pendingOpen ? 'Yes, open voting' : 'Yes, close voting';
    ok.className = 'btn ' + (pendingOpen ? 'btn-primary' : 'btn-danger');
    ok.disabled = false; $('confirm-cancel').disabled = false; $('confirm-error').hidden = true;
    dlg.showModal();
  }
  $('toggle-voting').addEventListener('click', askToggle);
  $('confirm-cancel').addEventListener('click', function () { dlg.close(); });
  $('confirm-ok').addEventListener('click', function () {
    var ok = $('confirm-ok'); ok.disabled = true; $('confirm-cancel').disabled = true;
    api('/api/admin/voting', { method: 'POST', body: { open: pendingOpen } }).then(function (d) {
      if (!d.__ok) { $('confirm-error').textContent = d.error || 'Could not change voting status.'; $('confirm-error').hidden = false; ok.disabled = false; $('confirm-cancel').disabled = false; return; }
      voting = d.voting; renderVoting(); dlg.close(); refresh();
    }).catch(function (e) {
      if (e.message === 'signed-out') return;
      $('confirm-error').textContent = 'Could not reach the server. Nothing was changed.'; $('confirm-error').hidden = false; ok.disabled = false; $('confirm-cancel').disabled = false;
    });
  });

  $('refresh').addEventListener('click', refresh);
  $('auto').addEventListener('change', function (e) { setAuto(e.target.checked); });
  $('logout').addEventListener('click', function () {
    api('/api/admin/logout', { method: 'POST', body: {} }).catch(function () {}).then(function () { window.location.assign('/admin'); });
  });

  // ---------- start ----------
  api('/api/admin/session').then(function (s) {
    csrf = s.csrf;
    try { if (localStorage.getItem('rra_admin_auto') === '1') { $('auto').checked = true; setAuto(true); } } catch (e) { /* ignore */ }
    return refresh();
  }).catch(function () { /* redirected to login */ });
})();
