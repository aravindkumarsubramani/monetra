window.Monetra = window.Monetra || {};

/* Bank & cash accounts. Like PayLater, this requires being logged in and
   lives in the Monetra server's MySQL database (server/server.js,
   /api/accounts) rather than only in the browser. Unlike PayLater though,
   `state.accounts` is load-bearing elsewhere in the app — Transactions
   (js/transactions.js) directly mutate an account's balance on every
   Pay/Receive/Transfer, and calc.js reads it for net worth — so it's kept
   as a live local mirror, refreshed from the server whenever this tab
   loads, and pushed back to the server whenever a transaction changes a
   balance (see Monetra.accounts.syncOne, called from transactions.js).

   Pre-existing local accounts (from before this feature existed) get
   imported once per browser, preserving their original ids — see
   migrateIfNeeded() below, called from js/app.js before the first render. */
(function () {
  function escape(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

  const COUNTRIES = ['India', 'Germany', 'Other'];
  const COUNTRY_DEFAULT_CURRENCY = { India: 'INR', Germany: 'EUR' };

  function isLoggedIn() {
    return !!(Monetra.auth && Monetra.auth.isLoggedIn());
  }

  // See js/paylater.js for why this pattern (only re-fetch when the tab
  // opens or the logged-in account changes, never inside the fetch's own
  // success handler) is what keeps this safe from both stale-account leaks
  // and infinite refresh loops.
  let syncedForUserId = null;

  // One-time import of whatever accounts/cards/wallets already existed
  // locally before this account ever logged in on this browser. Guarded by
  // state.meta.localDataMigrated so it only ever runs once per browser (not
  // once per account) — critical so a second account logging in later never
  // inherits the first account's data. Must be awaited by js/app.js BEFORE
  // the first renderAll(), so this reads the true pre-migration local data
  // before this tab's own sync (below) has a chance to overwrite it.
  async function migrateIfNeeded() {
    if (!isLoggedIn()) return;
    const state = Monetra.storage.getState();
    state.meta = state.meta || {};
    if (state.meta.localDataMigrated) return;

    const hasData = (state.accounts && state.accounts.length) || (state.cards && state.cards.length) || (state.wallets && state.wallets.length);
    if (!hasData) {
      state.meta.localDataMigrated = true;
      Monetra.storage.save();
      return;
    }

    try {
      const result = await Monetra.auth.authFetch('/api/migrate', {
        method: 'POST',
        body: JSON.stringify({ accounts: state.accounts, cards: state.cards, wallets: state.wallets })
      });
      state.meta.localDataMigrated = true;
      Monetra.storage.save();
      const n = result.imported || {};
      console.log(`Monetra: imported ${n.accounts || 0} account(s), ${n.cards || 0} card(s), ${n.wallets || 0} wallet(s) into your account.`);
    } catch (err) {
      // Don't set the flag on failure (e.g. server unreachable) — retried
      // automatically next page load instead of losing the data silently.
      console.warn('Monetra: could not import existing local data into your account: ' + err.message);
    }
  }

  // Pushes one account's current full local state to the server — used
  // both by this tab's own edit form and by transactions.js after a
  // transaction changes an account's balance.
  function syncOne(accountId) {
    if (!isLoggedIn()) return Promise.resolve();
    const state = Monetra.storage.getState();
    const account = state.accounts.find((a) => a.id === accountId);
    if (!account) return Promise.resolve();
    return Monetra.auth.authFetch('/api/accounts/' + accountId, { method: 'PUT', body: JSON.stringify(account) })
      .catch((err) => console.warn('Monetra: could not sync account "' + account.name + '" to the server: ' + err.message));
  }

  function detailRows(a, disp) {
    const rows = [];
    if (a.country) rows.push(['Country', escape(a.country)]);
    if (a.branch) rows.push(['Branch', escape(a.branch)]);
    if (a.accountNumber) rows.push(['Account no.', escape(a.accountNumber)]);
    if (a.ifsc) rows.push(['IFSC', escape(a.ifsc)]);
    if (a.iban) rows.push(['IBAN', escape(a.iban)]);
    if (a.bic) rows.push(['BIC / SWIFT', escape(a.bic)]);
    if (a.customerId) rows.push(['Customer ID', escape(a.customerId)]);
    rows.push(['Type', a.type === 'cash' ? 'Cash' : 'Bank account']);
    rows.push(['Currency', a.currency]);
    if (a.currency !== disp) rows.push(['≈ ' + disp, Monetra.storage.formatMoney(Monetra.currency.convert(a.balance, a.currency, disp), disp)]);
    if (a.notes) rows.push(['Notes', escape(a.notes)]);
    return rows;
  }

  function render() {
    const el = document.getElementById('tab-accounts');
    if (!el) return;

    if (!isLoggedIn()) {
      syncedForUserId = null;
      el.innerHTML = `
        <div class="section-header"><h2>Bank &amp; cash accounts</h2></div>
        <div class="card" style="max-width:520px;">
          <h3 style="margin-top:0;">Log in to use Accounts</h3>
          <p class="hint" style="margin-top:0;">Accounts are saved to your Monetra account, not this browser — so you'll need to be logged in to add or view them. Adding transactions also needs at least one account, so log in first.</p>
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
      el.innerHTML = `<div class="section-header"><h2>Bank &amp; cash accounts</h2></div><div class="hint">Loading your accounts…</div>`;
      Monetra.auth.authFetch('/api/accounts', { method: 'GET' })
        .then((result) => {
          const state = Monetra.storage.getState();
          state.accounts = result.accounts || [];
          Monetra.storage.save();
          syncedForUserId = userId;
          Monetra.app.renderAll();
        })
        .catch((err) => {
          el.innerHTML = `<div class="section-header"><h2>Bank &amp; cash accounts</h2></div><div class="hint" style="color:var(--critical);">Could not load your accounts: ${escape(err.message)}</div>`;
        });
      return;
    }

    renderList(el);
  }

  function renderList(el) {
    const state = Monetra.storage.getState();
    const disp = state.settings.displayCurrency;

    const cards = state.accounts.map((a) => {
      const rows = detailRows(a, disp);
      return `<div class="account-card" data-id="${a.id}">
        <div class="account-card-inner">
          <div class="account-card-face account-card-front type-${a.type}">
            <span class="card-type-pill">${a.type === 'cash' ? 'Cash' : 'Bank'}</span>
            <div>
              ${a.type === 'bank' ? `<div class="card-bank">${escape(a.bank || a.name)}</div>` : ''}
              <div class="card-name">${escape(a.name)}</div>
            </div>
            <div class="card-balance">${Monetra.storage.formatMoney(a.balance, a.currency)}</div>
            <div class="card-hint">Click for details</div>
          </div>
          <div class="account-card-face account-card-back">
            <div class="back-rows">
              ${rows.map(([l, v]) => `<div class="back-row"><span class="back-label">${l}</span><span>${v}</span></div>`).join('')}
            </div>
            <div class="back-actions">
              <button class="btn btn-ghost btn-sm" data-action="viewCards">View cards</button>
              <button class="btn btn-ghost btn-sm" data-action="edit">Edit</button>
              <button class="btn btn-danger btn-sm" data-action="delete">Delete</button>
            </div>
          </div>
        </div>
      </div>`;
    }).join('');

    const addCard = `<div class="account-add-card" id="addAccountCard"><div class="plus">+</div><div>Add account</div></div>`;
    const addCashCard = `<div class="account-add-card" id="addCashCard"><div class="plus">+</div><div>Add cash</div></div>`;

    el.innerHTML = `
      <div class="section-header">
        <h2>Bank &amp; cash accounts</h2>
      </div>
      <div class="hint" style="margin-bottom:12px;">Saved to your Monetra account — only you can see this, even from a different browser.</div>
      <div class="accounts-grid">${cards}${addCard}${addCashCard}</div>
    `;

    document.getElementById('addAccountCard').onclick = () => openForm(null, 'bank');
    document.getElementById('addCashCard').onclick = () => openForm(null, 'cash');
    el.querySelectorAll('.account-card').forEach((card) => {
      const id = card.dataset.id;
      card.addEventListener('click', () => card.classList.toggle('flipped'));
      card.querySelector('[data-action="viewCards"]').addEventListener('click', (e) => { e.stopPropagation(); Monetra.cards.showForAccount(id); });
      card.querySelector('[data-action="edit"]').addEventListener('click', (e) => { e.stopPropagation(); openForm(id); });
      card.querySelector('[data-action="delete"]').addEventListener('click', (e) => {
        e.stopPropagation();
        if (!confirm('Delete this account? This cannot be undone.')) return;
        Monetra.auth.authFetch('/api/accounts/' + id, { method: 'DELETE' })
          .then(() => { syncedForUserId = null; Monetra.app.renderAll(); })
          .catch((err) => alert('Could not delete: ' + err.message));
      });
    });
  }

  // Renders the country-specific identifier fields. `vals` carries the
  // existing record only when its saved country matches, so switching the
  // country in the form starts those fields blank rather than showing
  // stale values from a different country's fields.
  function countryFieldsHtml(country, vals) {
    if (country === 'India') {
      return `
        <div class="form-grid-2">
          <div class="form-row"><label>Branch (optional)</label><input name="branch" value="${escape(vals.branch || '')}" placeholder="e.g. Koramangala"></div>
          <div class="form-row"><label>Account number</label><input name="accountNumber" value="${escape(vals.accountNumber || '')}"></div>
        </div>
        <div class="form-grid-2">
          <div class="form-row"><label>IFSC code</label><input name="ifsc" value="${escape(vals.ifsc || '')}" placeholder="e.g. HDFC0001234"></div>
          <div class="form-row"><label>Customer ID (optional)</label><input name="customerId" value="${escape(vals.customerId || '')}"></div>
        </div>`;
    }
    if (country === 'Germany') {
      return `
        <div class="form-grid-2">
          <div class="form-row"><label>IBAN</label><input name="iban" value="${escape(vals.iban || '')}" placeholder="e.g. DE89 3704 0044 0532 0130 00"></div>
          <div class="form-row"><label>BIC / SWIFT code</label><input name="bic" value="${escape(vals.bic || '')}" placeholder="e.g. COBADEFFXXX"></div>
        </div>
        <div class="form-row"><label>Customer ID (optional)</label><input name="customerId" value="${escape(vals.customerId || '')}"></div>`;
    }
    // Other / generic
    return `
      <div class="form-grid-2">
        <div class="form-row"><label>Account number (optional)</label><input name="accountNumber" value="${escape(vals.accountNumber || '')}"></div>
        <div class="form-row"><label>SWIFT / BIC code (optional)</label><input name="bic" value="${escape(vals.bic || '')}"></div>
      </div>
      <div class="form-row"><label>Customer ID (optional)</label><input name="customerId" value="${escape(vals.customerId || '')}"></div>`;
  }

  // The bank-only block: country + country-specific identifiers + bank name.
  // Only ever rendered when type === 'bank' — a cash account has no bank to
  // name, so this whole block (and the `required` on Bank name) simply
  // isn't present in the DOM when adding/editing cash.
  function bankOnlyFieldsHtml(country, vals) {
    return `
      <div class="form-row"><label>Country</label>
        <select name="country" id="countrySelect">${COUNTRIES.map((c) => `<option value="${c}" ${country === c ? 'selected' : ''}>${c}</option>`).join('')}</select>
      </div>
      <div id="countryFields">${countryFieldsHtml(country, vals)}</div>
      <div class="form-row"><label>Bank name</label><input name="bank" id="bankInput" required value="${escape(vals.bank || '')}" placeholder="e.g. HDFC Bank"></div>`;
  }

  // Opens the Add/Edit account modal. `forcedType` ("bank" or "cash") only
  // applies when adding new — it's how the two entry points on the Accounts
  // page ("+ Add account" vs "+ Add cash") start the form on the right kind
  // without asking. The Type dropdown still lets you switch either way
  // afterwards; switching hides/shows the bank-only fields live so a cash
  // account is never asked for a bank name.
  function openForm(id, forcedType) {
    const state = Monetra.storage.getState();
    const existing = id ? state.accounts.find((a) => a.id === id) : null;
    const initialType = existing ? existing.type : (forcedType === 'cash' ? 'cash' : 'bank');
    const initialCountry = existing ? (existing.country || 'Other') : 'India';
    const initialCurrency = existing ? existing.currency : (initialType === 'bank' ? (COUNTRY_DEFAULT_CURRENCY[initialCountry] || 'INR') : 'INR');

    const html = `
      <h2 id="formHeading">${existing ? 'Edit account' : (initialType === 'cash' ? 'Add cash' : 'Add account')}</h2>
      <form id="accountForm">
        <div class="form-row"><label id="nameLabel">${initialType === 'cash' ? 'Cash name' : 'Account name'}</label><input name="name" required value="${existing ? escape(existing.name) : ''}" placeholder="${initialType === 'cash' ? 'e.g. Wallet cash' : 'e.g. HDFC Savings'}"></div>
        <div class="form-row"><label>Type</label>
          <select name="type" id="typeSelect">
            <option value="bank" ${initialType === 'bank' ? 'selected' : ''}>Bank</option>
            <option value="cash" ${initialType === 'cash' ? 'selected' : ''}>Cash</option>
          </select>
        </div>
        <div id="bankOnlyFields">${initialType === 'bank' ? bankOnlyFieldsHtml(initialCountry, existing || {}) : ''}</div>
        <div class="form-grid-2">
          <div class="form-row"><label>Currency</label>
            <select name="currency" id="currencySelect">${Monetra.storage.CURRENCIES.map((c) => `<option value="${c}" ${initialCurrency === c ? 'selected' : ''}>${c}</option>`).join('')}</select>
          </div>
          <div class="form-row"><label id="balanceLabel">${initialType === 'cash' ? 'How much cash' : 'Current balance'}</label><input name="balance" type="number" step="0.01" required value="${existing ? existing.balance : ''}"></div>
        </div>
        <div class="form-row"><label>Notes (optional)</label><input name="notes" value="${existing ? escape(existing.notes || '') : ''}"></div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" id="cancelBtn">Cancel</button>
          <button type="submit" class="btn btn-primary" id="submitBtn">${existing ? 'Save changes' : (initialType === 'cash' ? 'Add cash' : 'Add account')}</button>
        </div>
      </form>`;
    Monetra.modal.open(html, (root) => {
      root.querySelector('#cancelBtn').onclick = () => Monetra.modal.close();

      function wireCountrySelect() {
        const countrySelect = root.querySelector('#countrySelect');
        if (!countrySelect) return; // not present while type is Cash
        countrySelect.onchange = (e) => {
          const newCountry = e.target.value;
          // keep saved values only if the field set still matches this country
          const vals = existing && existing.country === newCountry ? existing : {};
          root.querySelector('#countryFields').innerHTML = countryFieldsHtml(newCountry, vals);
          const defaultCurrency = COUNTRY_DEFAULT_CURRENCY[newCountry];
          if (defaultCurrency) root.querySelector('#currencySelect').value = defaultCurrency;
        };
      }
      wireCountrySelect();

      root.querySelector('#typeSelect').onchange = (e) => {
        const newType = e.target.value;
        const wrap = root.querySelector('#bankOnlyFields');
        if (newType === 'bank') {
          const country = existing && existing.country ? existing.country : 'India';
          const vals = existing && existing.type === 'bank' ? existing : {};
          wrap.innerHTML = bankOnlyFieldsHtml(country, vals);
          wireCountrySelect();
          const defaultCurrency = COUNTRY_DEFAULT_CURRENCY[country];
          if (defaultCurrency) root.querySelector('#currencySelect').value = defaultCurrency;
        } else {
          wrap.innerHTML = '';
        }
        root.querySelector('#nameLabel').textContent = newType === 'cash' ? 'Cash name' : 'Account name';
        root.querySelector('#balanceLabel').textContent = newType === 'cash' ? 'How much cash' : 'Current balance';
        root.querySelector('#formHeading').textContent = existing ? 'Edit account' : (newType === 'cash' ? 'Add cash' : 'Add account');
        root.querySelector('#submitBtn').textContent = existing ? 'Save changes' : (newType === 'cash' ? 'Add cash' : 'Add account');
      };

      root.querySelector('#accountForm').onsubmit = (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const get = (name) => (fd.get(name) || '').toString().trim();
        const type = fd.get('type');
        const data = {
          name: get('name'),
          type,
          currency: fd.get('currency'),
          balance: parseFloat(fd.get('balance')),
          notes: get('notes')
        };
        if (type === 'bank') {
          Object.assign(data, {
            country: get('country'),
            bank: get('bank'),
            branch: get('branch'),
            accountNumber: get('accountNumber'),
            ifsc: get('ifsc'),
            iban: get('iban'),
            bic: get('bic'),
            customerId: get('customerId')
          });
        }

        const submitBtn = root.querySelector('#submitBtn');
        submitBtn.disabled = true;

        const req = existing
          ? Monetra.auth.authFetch('/api/accounts/' + existing.id, { method: 'PUT', body: JSON.stringify(data) })
          : Monetra.auth.authFetch('/api/accounts', { method: 'POST', body: JSON.stringify(Object.assign({ id: Monetra.storage.uid('acc') }, data)) });

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

  Monetra.accounts = { render, migrateIfNeeded, syncOne };
})();
