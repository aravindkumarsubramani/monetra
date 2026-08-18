window.Monetra = window.Monetra || {};

/* Digital wallets (Paytm, PhonePe, Google Pay, etc.) — simple balances that
   count toward assets/net worth just like a bank or cash account. Reuses
   the same flip-card visual pattern as Accounts.

   Like Accounts, this requires being logged in and lives in the database
   (server/server.js, /api/wallets) — see js/accounts.js for the shared
   reasoning (id preservation, login gate, sync-on-tab-open pattern). */
(function () {
  function escape(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

  function isLoggedIn() {
    return !!(Monetra.auth && Monetra.auth.isLoggedIn());
  }

  let syncedForUserId = null;

  function render() {
    const el = document.getElementById('tab-wallets');
    if (!el) return;

    if (!isLoggedIn()) {
      syncedForUserId = null;
      el.innerHTML = `
        <div class="section-header"><h2>Wallets</h2></div>
        <div class="card" style="max-width:520px;">
          <h3 style="margin-top:0;">Log in to use Wallets</h3>
          <p class="hint" style="margin-top:0;">Wallets are saved to your Monetra account, not this browser — so you'll need to be logged in to add or view them.</p>
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
      el.innerHTML = `<div class="section-header"><h2>Wallets</h2></div><div class="hint">Loading your wallets…</div>`;
      Monetra.auth.authFetch('/api/wallets', { method: 'GET' })
        .then((result) => {
          const state = Monetra.storage.getState();
          state.wallets = result.wallets || [];
          Monetra.storage.save();
          syncedForUserId = userId;
          Monetra.app.renderAll();
        })
        .catch((err) => {
          el.innerHTML = `<div class="section-header"><h2>Wallets</h2></div><div class="hint" style="color:var(--critical);">Could not load your wallets: ${escape(err.message)}</div>`;
        });
      return;
    }

    renderList(el);
  }

  function renderList(el) {
    const state = Monetra.storage.getState();
    const disp = state.settings.displayCurrency;

    const cards = (state.wallets || []).map((w) => {
      const converted = Monetra.currency.convert(w.balance, w.currency, disp);
      return `<div class="account-card" data-id="${w.id}">
        <div class="account-card-inner">
          <div class="account-card-face account-card-front type-cash">
            <span class="card-type-pill">Wallet</span>
            <div>
              <div class="card-bank">${escape(w.name)}</div>
            </div>
            <div class="card-balance">${Monetra.storage.formatMoney(w.balance, w.currency)}</div>
            <div class="card-hint">Click for details</div>
          </div>
          <div class="account-card-face account-card-back">
            <div class="back-rows">
              <div class="back-row"><span class="back-label">Currency</span><span>${w.currency}</span></div>
              ${w.currency !== disp ? `<div class="back-row"><span class="back-label">≈ ${disp}</span><span>${Monetra.storage.formatMoney(converted, disp)}</span></div>` : ''}
              ${w.notes ? `<div class="back-row"><span class="back-label">Notes</span><span>${escape(w.notes)}</span></div>` : ''}
            </div>
            <div class="back-actions">
              <button class="btn btn-ghost btn-sm" data-action="edit">Edit</button>
              <button class="btn btn-danger btn-sm" data-action="delete">Delete</button>
            </div>
          </div>
        </div>
      </div>`;
    }).join('');

    const addCard = `<div class="account-add-card" id="addWalletCard"><div class="plus">+</div><div>Add wallet</div></div>`;

    el.innerHTML = `
      <div class="section-header">
        <h2>Wallets</h2>
      </div>
      <div class="hint" style="margin-bottom:12px;">Saved to your Monetra account — only you can see this, even from a different browser.</div>
      <div class="accounts-grid">${cards}${addCard}</div>
    `;

    document.getElementById('addWalletCard').onclick = () => openForm();
    el.querySelectorAll('.account-card').forEach((card) => {
      const id = card.dataset.id;
      card.addEventListener('click', () => card.classList.toggle('flipped'));
      card.querySelector('[data-action="edit"]').addEventListener('click', (e) => { e.stopPropagation(); openForm(id); });
      card.querySelector('[data-action="delete"]').addEventListener('click', (e) => {
        e.stopPropagation();
        if (!confirm('Delete this wallet? This cannot be undone.')) return;
        Monetra.auth.authFetch('/api/wallets/' + id, { method: 'DELETE' })
          .then(() => { syncedForUserId = null; Monetra.app.renderAll(); })
          .catch((err) => alert('Could not delete: ' + err.message));
      });
    });
  }

  function openForm(id) {
    const state = Monetra.storage.getState();
    const existing = id ? state.wallets.find((w) => w.id === id) : null;
    const html = `
      <h2>${existing ? 'Edit wallet' : 'Add wallet'}</h2>
      <form id="walletForm">
        <div class="form-row"><label>Wallet name</label><input name="name" required value="${existing ? escape(existing.name) : ''}" placeholder="e.g. Paytm, PhonePe, Google Pay"></div>
        <div class="form-grid-2">
          <div class="form-row"><label>Currency</label>
            <select name="currency">${Monetra.storage.CURRENCIES.map((c) => `<option value="${c}" ${existing && existing.currency === c ? 'selected' : (!existing && c === state.settings.displayCurrency ? 'selected' : '')}>${c}</option>`).join('')}</select>
          </div>
          <div class="form-row"><label>Current balance</label><input name="balance" type="number" step="0.01" required value="${existing ? existing.balance : ''}"></div>
        </div>
        <div class="form-row"><label>Notes (optional)</label><input name="notes" value="${existing ? escape(existing.notes || '') : ''}"></div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" id="cancelBtn">Cancel</button>
          <button type="submit" class="btn btn-primary">${existing ? 'Save changes' : 'Add wallet'}</button>
        </div>
      </form>`;
    Monetra.modal.open(html, (root) => {
      root.querySelector('#cancelBtn').onclick = () => Monetra.modal.close();
      root.querySelector('#walletForm').onsubmit = (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const data = {
          name: fd.get('name').trim(),
          currency: fd.get('currency'),
          balance: parseFloat(fd.get('balance')),
          notes: fd.get('notes').trim()
        };

        const submitBtn = root.querySelector('button[type="submit"]');
        submitBtn.disabled = true;

        const req = existing
          ? Monetra.auth.authFetch('/api/wallets/' + existing.id, { method: 'PUT', body: JSON.stringify(data) })
          : Monetra.auth.authFetch('/api/wallets', { method: 'POST', body: JSON.stringify(Object.assign({ id: Monetra.storage.uid('wal') }, data)) });

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

  Monetra.wallets = { render };
})();
