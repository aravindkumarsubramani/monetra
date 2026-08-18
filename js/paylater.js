window.Monetra = window.Monetra || {};

/* PayLater / Buy-Now-Pay-Later providers (Simpl, LazyPay, Amazon Pay Later,
   Klarna, etc.) — a lightweight version of Debts: a credit limit and current
   outstanding amount. Outstanding counts toward total debts / net worth
   just like the Debts section.

   Unlike the rest of Monetra, PayLater data is NOT stored in the browser —
   it lives only in the account's row in the Monetra server's MySQL database
   (server/server.js, /api/paylaters), which is why this tab requires being
   logged in, and why every add/edit/delete/payment goes straight to the
   server. `state.paylaters` is kept as a *mirror* of whatever the server
   last returned, refreshed whenever this tab loads or changes — that's what
   lets calc.js/dashboard.js keep computing net worth and totals exactly as
   before, without needing to know PayLater moved to a real backend. */
(function () {
  function escape(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

  function paidThisCycle(p) {
    const month = Monetra.storage.monthKey();
    return (p.payments || []).some((pm) => pm.date && pm.date.slice(0, 7) === month);
  }

  function isLoggedIn() {
    return !!(Monetra.auth && Monetra.auth.isLoggedIn());
  }

  // Tracks which account's data is currently mirrored into state.paylaters,
  // so render() only re-fetches from the server when it actually needs to
  // (tab just opened, or the logged-in account changed) rather than on
  // every single app-wide renderAll() — and critically, so a fresh fetch
  // never gets triggered from inside its own success handler, which would
  // loop forever.
  let syncedForUserId = null;

  function render() {
    const el = document.getElementById('tab-paylater');
    if (!el) return;

    if (!isLoggedIn()) {
      syncedForUserId = null;
      el.innerHTML = `
        <div class="section-header"><h2>PayLater</h2></div>
        <div class="card" style="max-width:520px;">
          <h3 style="margin-top:0;">Log in to use PayLater</h3>
          <p class="hint" style="margin-top:0;">PayLater providers and payment history are saved to your Monetra account, not this browser — so you'll need to be logged in to add or view them. Everything else in Monetra still works without logging in.</p>
          <div style="display:flex; gap:10px; margin-top:14px;">
            <a class="btn btn-primary btn-sm" href="login.html">Log in</a>
            <a class="btn btn-ghost btn-sm" href="signup.html">Sign up</a>
          </div>
        </div>
      `;
      return;
    }

    const user = Monetra.auth.getUser();
    const userId = user && user.id;

    if (syncedForUserId !== userId) {
      // Never draw from local cache first — it may still hold a *different*
      // account's PayLater data, cached from before that account logged
      // out (the same class of bug already fixed once for the Settings API
      // keys). Show a loading state and only draw real cards once the
      // server has answered for whoever is actually logged in right now.
      el.innerHTML = `<div class="section-header"><h2>PayLater</h2></div><div class="hint">Loading your PayLater providers…</div>`;

      Monetra.auth.authFetch('/api/paylaters', { method: 'GET' })
        .then((result) => {
          const state = Monetra.storage.getState();
          state.paylaters = result.paylaters || [];
          Monetra.storage.save();
          syncedForUserId = userId;
          // Safe to call renderAll here: render() will now take the
          // "already synced" branch below and just redraw from the cache
          // it was just given, instead of fetching again.
          Monetra.app.renderAll();
        })
        .catch((err) => {
          el.innerHTML = `<div class="section-header"><h2>PayLater</h2></div><div class="hint" style="color:var(--critical);">Could not load your PayLater providers: ${escape(err.message)}</div>`;
        });
      return;
    }

    renderList(el);
  }

  // Draws the actual card grid from whatever's currently in state.paylaters
  // — called once this tab's data is known to be synced for the logged-in
  // account (see render() above).
  function renderList(el) {
    const state = Monetra.storage.getState();
    const disp = state.settings.displayCurrency;

    const cards = (state.paylaters || []).map((p) => {
      const remainingDisp = Monetra.currency.convert(p.outstanding, p.currency, disp);
      const paid = paidThisCycle(p);
      const statusText = p.outstanding <= 0 ? 'No outstanding balance' : paid ? 'Paid this month' : 'Outstanding';

      return `<div class="account-card" data-id="${p.id}">
        <div class="account-card-inner">
          <div class="account-card-face account-card-front type-debt">
            <span class="card-type-pill">PayLater</span>
            <div>
              <div class="card-bank">${escape(p.provider)}</div>
              <div class="card-name">${statusText}</div>
            </div>
            <div class="card-balance">${Monetra.storage.formatMoney(p.outstanding, p.currency)}</div>
            <div class="card-hint">Click for details</div>
          </div>
          <div class="account-card-face account-card-back">
            <div class="back-rows">
              <div class="back-row"><span class="back-label">Credit limit</span><span>${Monetra.storage.formatMoney(p.creditLimit, p.currency)}</span></div>
              <div class="back-row"><span class="back-label">Status</span><span>${statusText}</span></div>
              <div class="back-row"><span class="back-label">Currency</span><span>${p.currency}</span></div>
              ${p.currency !== disp ? `<div class="back-row"><span class="back-label">≈ ${disp}</span><span>${Monetra.storage.formatMoney(remainingDisp, disp)}</span></div>` : ''}
              ${p.notes ? `<div class="back-row"><span class="back-label">Notes</span><span>${escape(p.notes)}</span></div>` : ''}
            </div>
            <div class="back-actions">
              <button class="btn btn-ghost btn-sm" data-action="pay">Log payment</button>
              <button class="btn btn-ghost btn-sm" data-action="edit">Edit</button>
              <button class="btn btn-danger btn-sm" data-action="delete">Delete</button>
            </div>
          </div>
        </div>
      </div>`;
    }).join('');

    const addCard = `<div class="account-add-card" id="addPaylaterCard"><div class="plus">+</div><div>Add PayLater</div></div>`;

    el.innerHTML = `
      <div class="section-header">
        <h2>PayLater</h2>
      </div>
      <div class="hint" style="margin-bottom:12px;">Saved to your Monetra account — only you can see this, even from a different browser.</div>
      <div class="accounts-grid">${cards}${addCard}</div>
    `;

    document.getElementById('addPaylaterCard').onclick = () => openForm();
    el.querySelectorAll('.account-card').forEach((card) => {
      const id = card.dataset.id;
      card.addEventListener('click', () => card.classList.toggle('flipped'));
      card.querySelector('[data-action="edit"]').addEventListener('click', (e) => { e.stopPropagation(); openForm(id); });
      card.querySelector('[data-action="pay"]').addEventListener('click', (e) => { e.stopPropagation(); openPaymentForm(id); });
      card.querySelector('[data-action="delete"]').addEventListener('click', (e) => {
        e.stopPropagation();
        if (!confirm('Delete this PayLater provider? This cannot be undone.')) return;
        Monetra.auth.authFetch('/api/paylaters/' + id, { method: 'DELETE' })
          .then(() => { syncedForUserId = null; Monetra.app.renderAll(); })
          .catch((err) => alert('Could not delete: ' + err.message));
      });
    });
  }

  function openForm(id) {
    const state = Monetra.storage.getState();
    const existing = id ? state.paylaters.find((p) => p.id === id) : null;
    const html = `
      <h2>${existing ? 'Edit PayLater' : 'Add PayLater'}</h2>
      <form id="paylaterForm">
        <div class="form-row"><label>Provider</label><input name="provider" required value="${existing ? escape(existing.provider) : ''}" placeholder="e.g. Simpl, LazyPay, Amazon Pay Later, Klarna"></div>
        <div class="form-grid-2">
          <div class="form-row"><label>Credit limit</label><input name="creditLimit" type="number" step="0.01" required value="${existing ? existing.creditLimit : ''}"></div>
          <div class="form-row"><label>Current outstanding</label><input name="outstanding" type="number" step="0.01" required value="${existing ? existing.outstanding : ''}"></div>
        </div>
        <div class="form-row"><label>Currency</label>
          <select name="currency">${Monetra.storage.CURRENCIES.map((c) => `<option value="${c}" ${existing && existing.currency === c ? 'selected' : (!existing && c === state.settings.displayCurrency ? 'selected' : '')}>${c}</option>`).join('')}</select>
        </div>
        <div class="form-row"><label>Notes (optional)</label><input name="notes" value="${existing ? escape(existing.notes || '') : ''}"></div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" id="cancelBtn">Cancel</button>
          <button type="submit" class="btn btn-primary">${existing ? 'Save changes' : 'Add PayLater'}</button>
        </div>
      </form>`;
    Monetra.modal.open(html, (root) => {
      root.querySelector('#cancelBtn').onclick = () => Monetra.modal.close();
      root.querySelector('#paylaterForm').onsubmit = (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const data = {
          provider: fd.get('provider').trim(),
          creditLimit: parseFloat(fd.get('creditLimit')),
          outstanding: parseFloat(fd.get('outstanding')),
          currency: fd.get('currency'),
          notes: fd.get('notes').trim()
        };

        const submitBtn = root.querySelector('button[type="submit"]');
        submitBtn.disabled = true;

        const req = existing
          ? Monetra.auth.authFetch('/api/paylaters/' + existing.id, { method: 'PUT', body: JSON.stringify(data) })
          : Monetra.auth.authFetch('/api/paylaters', { method: 'POST', body: JSON.stringify(data) });

        req.then(() => {
          syncedForUserId = null;
          Monetra.modal.close();
          Monetra.app.renderAll();
        }).catch((err) => {
          submitBtn.disabled = false;
          alert('Could not save: ' + err.message);
        });
      };
    });
  }

  function openPaymentForm(id) {
    const state = Monetra.storage.getState();
    const p = state.paylaters.find((x) => x.id === id);
    if (!p) return;
    const html = `
      <h2>Log payment · ${escape(p.provider)}</h2>
      <form id="payForm">
        <div class="form-grid-2">
          <div class="form-row"><label>Payment date</label><input name="date" type="date" required value="${Monetra.storage.todayISO()}"></div>
          <div class="form-row"><label>Amount (${p.currency})</label><input name="amount" type="number" step="0.01" required value="${p.outstanding}"></div>
        </div>
        <div class="hint">This reduces the outstanding balance by the payment amount and marks this cycle as paid.</div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" id="cancelBtn">Cancel</button>
          <button type="submit" class="btn btn-primary">Log payment</button>
        </div>
      </form>`;
    Monetra.modal.open(html, (root) => {
      root.querySelector('#cancelBtn').onclick = () => Monetra.modal.close();
      root.querySelector('#payForm').onsubmit = (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const amount = parseFloat(fd.get('amount'));
        const date = fd.get('date');

        const submitBtn = root.querySelector('button[type="submit"]');
        submitBtn.disabled = true;

        Monetra.auth.authFetch('/api/paylaters/' + id + '/payments', { method: 'POST', body: JSON.stringify({ date, amount }) })
          .then(() => {
            syncedForUserId = null;
            Monetra.modal.close();
            Monetra.app.renderAll();
          })
          .catch((err) => {
            submitBtn.disabled = false;
            alert('Could not log payment: ' + err.message);
          });
      };
    });
  }

  Monetra.paylater = { render };
})();
