window.Monetra = window.Monetra || {};

/* A simple card registry — linked to a bank account, for reference only.
   Card balances/limits are informational and are not counted toward net
   worth (the underlying money already lives in the linked account, or in
   Debts if it's a credit card balance you're tracking separately).

   Like Accounts, this requires being logged in and lives in the database
   (server/server.js, /api/cards) — see js/accounts.js for the shared
   reasoning (id preservation, login gate, sync-on-tab-open pattern). */
(function () {
  function escape(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

  function isLoggedIn() {
    return !!(Monetra.auth && Monetra.auth.isLoggedIn());
  }

  let syncedForUserId = null;

  function accountLabel(state, accountId) {
    const a = state.accounts.find((x) => x.id === accountId);
    return a ? `${a.name}${a.bank ? ' · ' + a.bank : ''}` : '(no linked account)';
  }

  function groupNumber(digits) {
    if (!digits) return '•••• •••• •••• ••••';
    return (digits.match(/.{1,4}/g) || [digits]).join(' ');
  }

  let filterAccountId = null;

  function showForAccount(accountId) {
    filterAccountId = accountId;
    Monetra.app.showTab('cards');
    render();
  }

  function render() {
    const el = document.getElementById('tab-cards');
    if (!el) return;

    if (!isLoggedIn()) {
      syncedForUserId = null;
      el.innerHTML = `
        <div class="section-header"><h2>Cards</h2></div>
        <div class="card" style="max-width:520px;">
          <h3 style="margin-top:0;">Log in to use Cards</h3>
          <p class="hint" style="margin-top:0;">Cards are saved to your Monetra account, not this browser — so you'll need to be logged in to add or view them.</p>
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
      el.innerHTML = `<div class="section-header"><h2>Cards</h2></div><div class="hint">Loading your cards…</div>`;
      Monetra.auth.authFetch('/api/cards', { method: 'GET' })
        .then((result) => {
          const state = Monetra.storage.getState();
          state.cards = result.cards || [];
          Monetra.storage.save();
          syncedForUserId = userId;
          Monetra.app.renderAll();
        })
        .catch((err) => {
          el.innerHTML = `<div class="section-header"><h2>Cards</h2></div><div class="hint" style="color:var(--critical);">Could not load your cards: ${escape(err.message)}</div>`;
        });
      return;
    }

    renderList(el);
  }

  function renderList(el) {
    const state = Monetra.storage.getState();
    const hasAccounts = state.accounts.length > 0;

    if (filterAccountId && !state.accounts.some((a) => a.id === filterAccountId)) filterAccountId = null;
    const visibleCards = filterAccountId ? state.cards.filter((c) => c.accountId === filterAccountId) : state.cards;

    const cardTiles = visibleCards.map((c) => {
      const account = state.accounts.find((a) => a.id === c.accountId);
      const number = c.cardNumber || c.last4 || ''; // fall back for cards saved before full numbers were captured
      const expiry = c.expiryMonth && c.expiryYear ? `${String(c.expiryMonth).padStart(2, '0')}/${String(c.expiryYear).slice(-2)}` : '--/--';
      const currency = account ? account.currency : state.settings.displayCurrency;

      const backRows = [];
      backRows.push(['Linked account', escape(accountLabel(state, c.accountId))]);
      backRows.push(['Network', escape(c.network)]);
      backRows.push(['Type', c.cardType === 'credit' ? 'Credit' : 'Debit']);
      if (c.cardType === 'credit' && c.creditLimit) backRows.push(['Credit limit', Monetra.storage.formatMoney(c.creditLimit, currency)]);
      if (c.outstandingBalance) backRows.push(['Outstanding', Monetra.storage.formatMoney(c.outstandingBalance, currency)]);
      if (c.notes) backRows.push(['Notes', escape(c.notes)]);

      return `<div class="paycard" data-id="${c.id}">
        <div class="paycard-inner">
          <div class="paycard-face paycard-front type-${c.cardType}">
            <div class="paycard-top">
              <span class="paycard-network">${escape(c.network)}</span>
              <span class="card-type-pill">${c.cardType === 'credit' ? 'Credit' : 'Debit'}</span>
            </div>
            <div class="paycard-number">${groupNumber(number)}</div>
            <div class="paycard-bottom">
              <div>
                <div class="paycard-label">Bank</div>
                <div class="paycard-holder">${escape(account ? account.bank || account.name : '—')}</div>
              </div>
              <div>
                <div class="paycard-label">Expires</div>
                <div class="paycard-holder">${expiry}</div>
              </div>
            </div>
            <div class="card-hint">Click for details</div>
          </div>
          <div class="paycard-face paycard-back">
            <div class="back-rows">
              ${backRows.map(([l, v]) => `<div class="back-row"><span class="back-label">${l}</span><span>${v}</span></div>`).join('')}
            </div>
            <div class="back-actions">
              <button class="btn btn-ghost btn-sm" data-action="edit">Edit</button>
              <button class="btn btn-danger btn-sm" data-action="delete">Delete</button>
            </div>
          </div>
        </div>
      </div>`;
    }).join('');

    const addTile = hasAccounts ? `<div class="paycard-add" id="addCardBtn"><div class="plus">+</div><div>Add card</div></div>` : '';

    const filterBanner = filterAccountId ? `
      <div class="card" style="display:flex; align-items:center; justify-content:space-between; margin-bottom:14px; padding:12px 16px;">
        <span class="small">Showing cards linked to <strong>${escape(accountLabel(state, filterAccountId))}</strong></span>
        <button class="btn btn-ghost btn-sm" id="clearCardFilterBtn">Show all cards</button>
      </div>` : '';

    el.innerHTML = `
      <div class="section-header">
        <h2>Cards</h2>
      </div>
      <div class="hint" style="margin-bottom:12px;">Saved to your Monetra account — only you can see this, even from a different browser.</div>
      ${hasAccounts ? '' : '<div class="empty-state">Add a bank account first, then link a card to it.</div>'}
      ${filterBanner}
      <div class="paycard-grid">${cardTiles}${addTile}</div>
      <div class="hint" style="margin-top:14px;">Cards are a reference list linked to your accounts — the money itself is already counted through the linked account (or through Debts, if you track a credit card balance there), so cards don't add to or subtract from your net worth.</div>
    `;

    if (hasAccounts) document.getElementById('addCardBtn').onclick = () => openForm();
    if (filterAccountId) document.getElementById('clearCardFilterBtn').onclick = () => { filterAccountId = null; render(); };

    el.querySelectorAll('.paycard').forEach((tile) => {
      const id = tile.dataset.id;
      tile.addEventListener('click', () => tile.classList.toggle('flipped'));
      tile.querySelector('[data-action="edit"]').addEventListener('click', (e) => { e.stopPropagation(); openForm(id); });
      tile.querySelector('[data-action="delete"]').addEventListener('click', (e) => {
        e.stopPropagation();
        if (!confirm('Delete this card? This cannot be undone.')) return;
        Monetra.auth.authFetch('/api/cards/' + id, { method: 'DELETE' })
          .then(() => { syncedForUserId = null; Monetra.app.renderAll(); })
          .catch((err) => alert('Could not delete: ' + err.message));
      });
    });
  }

  function openForm(id) {
    const state = Monetra.storage.getState();
    if (!state.accounts.length) return;
    const existing = id ? state.cards.find((c) => c.id === id) : null;
    const cardType = existing ? existing.cardType : 'debit';
    const existingNumber = existing ? (existing.cardNumber || existing.last4 || '') : '';

    const html = `
      <h2>${existing ? 'Edit card' : 'Add card'}</h2>
      <form id="cardForm">
        <div class="form-row"><label>Linked account</label>
          <select name="accountId">${state.accounts.map((a) => `<option value="${a.id}" ${(existing ? existing.accountId === a.id : filterAccountId === a.id) ? 'selected' : ''}>${escape(a.name)}${a.bank ? ' · ' + escape(a.bank) : ''}</option>`).join('')}</select>
        </div>
        <div class="form-grid-2">
          <div class="form-row"><label>Card network</label>
            <select name="network">${Monetra.storage.CARD_NETWORKS.map((n) => `<option value="${n}" ${existing && existing.network === n ? 'selected' : ''}>${n}</option>`).join('')}</select>
          </div>
          <div class="form-row"><label>Card type</label>
            <select name="cardType" id="cardTypeSelect">
              <option value="debit" ${cardType === 'debit' ? 'selected' : ''}>Debit</option>
              <option value="credit" ${cardType === 'credit' ? 'selected' : ''}>Credit</option>
            </select>
          </div>
        </div>
        <div class="form-row"><label>Card number</label><input name="cardNumber" inputmode="numeric" maxlength="23" value="${escape(existingNumber)}" placeholder="1234 5678 9012 3456"></div>
        <div class="form-grid-2">
          <div class="form-row"><label>Expiry (MM/YY)</label><input name="expiry" placeholder="08/29" value="${existing && existing.expiryMonth ? String(existing.expiryMonth).padStart(2, '0') + '/' + String(existing.expiryYear).slice(-2) : ''}"></div>
          <div class="form-row"></div>
        </div>
        <div class="form-grid-2" id="creditFields" style="${cardType === 'credit' ? '' : 'display:none;'}">
          <div class="form-row"><label>Credit limit (optional)</label><input name="creditLimit" type="number" step="0.01" value="${existing && existing.creditLimit != null ? existing.creditLimit : ''}"></div>
          <div class="form-row"><label>Outstanding balance (optional)</label><input name="outstandingBalance" type="number" step="0.01" value="${existing && existing.outstandingBalance != null ? existing.outstandingBalance : ''}"></div>
        </div>
        <div class="form-row"><label>Notes (optional)</label><input name="notes" value="${existing ? escape(existing.notes || '') : ''}"></div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" id="cancelBtn">Cancel</button>
          <button type="submit" class="btn btn-primary">${existing ? 'Save changes' : 'Add card'}</button>
        </div>
      </form>`;

    Monetra.modal.open(html, (root) => {
      root.querySelector('#cancelBtn').onclick = () => Monetra.modal.close();
      root.querySelector('#cardTypeSelect').onchange = (e) => {
        root.querySelector('#creditFields').style.display = e.target.value === 'credit' ? '' : 'none';
      };
      root.querySelector('#cardForm').onsubmit = (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const expiry = (fd.get('expiry') || '').trim();
        const [em, ey] = expiry.split('/').map((x) => x && x.trim());
        const data = {
          accountId: fd.get('accountId'),
          network: fd.get('network'),
          cardType: fd.get('cardType'),
          cardNumber: (fd.get('cardNumber') || '').replace(/\D/g, ''),
          expiryMonth: em ? parseInt(em, 10) : null,
          expiryYear: ey ? (ey.length === 2 ? 2000 + parseInt(ey, 10) : parseInt(ey, 10)) : null,
          creditLimit: fd.get('creditLimit') ? parseFloat(fd.get('creditLimit')) : null,
          outstandingBalance: fd.get('outstandingBalance') ? parseFloat(fd.get('outstandingBalance')) : null,
          notes: (fd.get('notes') || '').trim()
        };

        const submitBtn = root.querySelector('button[type="submit"]');
        submitBtn.disabled = true;

        const req = existing
          ? Monetra.auth.authFetch('/api/cards/' + existing.id, { method: 'PUT', body: JSON.stringify(data) })
          : Monetra.auth.authFetch('/api/cards', { method: 'POST', body: JSON.stringify(Object.assign({ id: Monetra.storage.uid('card') }, data)) });

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

  Monetra.cards = { render, showForAccount };
})();
