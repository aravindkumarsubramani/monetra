window.Monetra = window.Monetra || {};

(function () {
  const TABS = ['dashboard', 'accounts', 'cards', 'wallets', 'transactions', 'planner', 'debts', 'paylater', 'investments', 'settings', 'profile'];
  const TITLES = { dashboard: 'Dashboard', accounts: 'Accounts', cards: 'Cards', wallets: 'Wallets', transactions: 'Transactions', planner: 'Monthly Planner', debts: 'Debts', paylater: 'PayLater', investments: 'Investments', settings: 'Settings', profile: 'Profile' };

  function safeRender(name, fn) {
    try {
      fn();
    } catch (e) {
      console.error('Monetra: ' + name + ' failed to render', e);
    }
  }

  function renderAll() {
    safeRender('dashboard', () => Monetra.dashboard.render());
    safeRender('accounts', () => Monetra.accounts.render());
    safeRender('cards', () => Monetra.cards.render());
    safeRender('wallets', () => Monetra.wallets.render());
    safeRender('transactions', () => Monetra.transactions.render());
    safeRender('planner', () => Monetra.planner.render());
    safeRender('debts', () => Monetra.debts.render());
    safeRender('paylater', () => Monetra.paylater.render());
    safeRender('investments', () => Monetra.investments.render());
    safeRender('settings', () => Monetra.settings.render());
    safeRender('profile', () => Monetra.profile.render());
    safeRender('currency select', populateCurrencySelect);
    safeRender('rates status', renderRatesStatus);
    safeRender('sidebar auth', renderSidebarAuth);
  }

  // Shows the sidebar's "Log out" button only while actually logged in —
  // logging out is otherwise only reachable from the Profile tab's own "Log
  // out" button (both call the same Monetra.profile.logout(), see
  // js/profile.js). The brand link right above it is a plain navigation
  // link to index.html and never logs anyone out.
  function renderSidebarAuth() {
    const btn = document.getElementById('sidebarLogoutBtn');
    if (!btn) return;
    btn.style.display = (Monetra.auth && Monetra.auth.isLoggedIn()) ? 'flex' : 'none';
  }

  function showTab(tab) {
    TABS.forEach((t) => {
      document.getElementById('tab-' + t).classList.toggle('active', t === tab);
      const navBtn = document.querySelector(`.nav-item[data-tab="${t}"]`);
      if (navBtn) navBtn.classList.toggle('active', t === tab);
    });
    document.getElementById('pageTitle').textContent = TITLES[tab];
    if (tab === 'dashboard') Monetra.dashboard.render();
  }

  function populateCurrencySelect() {
    const state = Monetra.storage.getState();
    const sel = document.getElementById('displayCurrencySelect');
    const current = state.settings.displayCurrency;
    sel.innerHTML = Monetra.storage.CURRENCIES.map((c) => `<option value="${c}" ${c === current ? 'selected' : ''}>${c}</option>`).join('');
  }

  function renderRatesStatus() {
    const state = Monetra.storage.getState();
    const el = document.getElementById('ratesStatus');
    const upd = state.exchangeRates.updated;
    el.textContent = 'Rates: ' + (upd ? new Date(upd).toLocaleString() : 'not fetched yet');
  }

  async function refreshRatesAndPrices() {
    const btn = document.getElementById('refreshAllBtn');
    btn.disabled = true;
    btn.textContent = 'Refreshing…';
    try {
      await Monetra.currency.fetchRates();
    } catch (e) {
      console.warn('rates refresh failed', e);
    }
    try {
      const state = Monetra.storage.getState();
      if ((state.settings.twelveDataApiKey || state.settings.alphaVantageApiKey) && state.investments.length) {
        await Monetra.stocks.refreshAll();
      }
    } catch (e) {
      console.warn('stocks refresh failed', e);
    }
    btn.disabled = false;
    btn.textContent = 'Refresh rates & prices';
    renderAll();
  }

  async function init() {
    document.getElementById('mainNav').addEventListener('click', (e) => {
      const btn = e.target.closest('.nav-item');
      if (!btn) return;
      showTab(btn.dataset.tab);
    });
    document.getElementById('displayCurrencySelect').addEventListener('change', (e) => {
      const state = Monetra.storage.getState();
      state.settings.displayCurrency = e.target.value;
      Monetra.storage.save();
      renderAll();
    });
    document.getElementById('refreshAllBtn').addEventListener('click', refreshRatesAndPrices);
    const sidebarLogoutBtn = document.getElementById('sidebarLogoutBtn');
    if (sidebarLogoutBtn) sidebarLogoutBtn.addEventListener('click', () => Monetra.profile.logout());

    // Must happen before the first renderAll() — otherwise Accounts/Cards/
    // Wallets' own tab-open sync (see js/accounts.js) would fetch from the
    // server first, overwrite state.accounts/cards/wallets with the
    // (empty, for a first login) server copy, and only THEN would this
    // migration read state.accounts — reading the already-overwritten empty
    // arrays instead of the real pre-existing local data. Awaiting it here
    // keeps it a one-shot, race-free import.
    if (Monetra.accounts && Monetra.accounts.migrateIfNeeded) {
      await Monetra.accounts.migrateIfNeeded();
    }

    renderAll();

    const state = Monetra.storage.getState();
    const staleMs = 60 * 60 * 1000;
    const upd = state.exchangeRates.updated ? new Date(state.exchangeRates.updated).getTime() : 0;
    if (Date.now() - upd > staleMs) {
      Monetra.currency.fetchRates().then(() => renderAll()).catch((e) => console.warn('initial rate fetch failed', e));
    }
  }

  Monetra.app = { showTab, renderAll };
  document.addEventListener('DOMContentLoaded', init);
})();
