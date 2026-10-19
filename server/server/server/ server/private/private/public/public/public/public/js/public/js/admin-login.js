(function () {
  'use strict';
  var form = document.getElementById('login-form');
  var input = document.getElementById('password');
  var err = document.getElementById('login-error');
  var btn = document.getElementById('login-btn');
  var label = document.getElementById('login-label');
  var busy = false;

  function fail(msg) { err.textContent = msg; err.hidden = false; busy = false; btn.disabled = false; label.textContent = 'Sign in'; input.focus(); input.select(); }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (busy) return;
    if (!input.value) return fail('Please enter the password.');
    busy = true; btn.disabled = true; label.textContent = 'Signing in…'; err.hidden = true;
    fetch('/api/admin/login', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: input.value })
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (d) { return { ok: res.ok, d: d }; });
    }).then(function (r) {
      if (r.ok) { input.value = ''; window.location.assign('/admin/dashboard'); return; }
      fail(r.d.error || 'Could not sign in.');
    }).catch(function () { fail('Could not reach the server. Please try again.'); });
  });
})();
