window.Monetra = window.Monetra || {};

(function () {
  const STORAGE_KEY = 'monetra_state_v1';

  const CURRENCIES = ['INR', 'EUR', 'USD', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'SGD', 'AED', 'CNY', 'NZD', 'ZAR', 'SEK', 'NOK', 'DKK', 'HKD', 'THB', 'MYR', 'KRW'];

  const EXPENSE_CATEGORIES = ['Housing', 'Groceries', 'Utilities', 'Transport', 'Dining', 'Health', 'Entertainment', 'Shopping', 'Education', 'Insurance', 'Travel', 'Subscriptions', 'Other'];
  const INCOME_CATEGORIES = ['Salary', 'Business', 'Investment Income', 'Gift', 'Refund', 'Other'];
  const CARD_NETWORKS = ['Visa', 'Mastercard', 'RuPay', 'American Express', 'Discover', 'Diners Club', 'Other'];

  function uid(prefix) {
    return (prefix || 'id') + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function defaultState() {
    return {
      settings: { displayCurrency: 'INR', twelveDataApiKey: '', alphaVantageApiKey: '' },
      accounts: [],
      cards: [],
      wallets: [],
      transactions: [],
      // Reusable transaction presets (see js/transactions.js) — same field
      // shape as a transaction minus `date`, since a template always starts
      // from today's date when used.
      transactionTemplates: [],
      debts: [],
      paylaters: [],
      investments: [],
      // One entry per calendar day the Investments tab was viewed/refreshed —
      // real snapshots of total portfolio value, used to draw the Performance
      // chart. Builds up over time; never backfilled or fabricated.
      investmentSnapshots: [],
      // Auto-logged Buy/Sell/Update/Remove events from Investments actions —
      // powers the "Recent activity" panel. Not a full trade ledger.
      investmentActivity: [],
      planner: { months: {} },
      exchangeRates: { base: 'EUR', rates: { EUR: 1 }, updated: null, source: null, manualOverrides: {} },
      // Profile is genuinely yours, not a demo template — prefilled with the
      // real name/email this app is set up for, since Monetra has no
      // multi-user accounts. Editable from the Profile tab.
      profile: {
        fullName: 'Aravind Kumar',
        username: 'aravindkumar', // fixed once set — Profile tab shows it read-only, no rename
        email: 'aravindkumar.s@mba.christuniversity.in',
        emailVerified: false, // local-only marker: no backend, so no real email is ever sent
        mobileCountryCode: '+91',
        mobile: '',
        mobileVerified: false, // local-only marker: no backend, so no real SMS is ever sent
        photo: '', // data URL, or '' for none — set via Profile tab avatar upload
        dateFormat: 'DD MMM YYYY' // one of: 'DD MMM YYYY' | 'DD.MM.YYYY' | 'MM/DD/YYYY' | 'YYYY-MM-DD'
      },
      meta: { createdAt: new Date().toISOString(), lastActivity: null }
    };
  }

  let state;

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const def = defaultState();
      if (!raw) return def;
      const parsed = JSON.parse(raw);
      return Object.assign({}, def, parsed, {
        settings: Object.assign({}, def.settings, parsed.settings),
        planner: Object.assign({}, def.planner, parsed.planner),
        exchangeRates: Object.assign({}, def.exchangeRates, parsed.exchangeRates),
        profile: Object.assign({}, def.profile, parsed.profile),
        meta: Object.assign({}, def.meta, parsed.meta)
      });
    } catch (e) {
      console.error('Failed to load Monetra state, starting fresh.', e);
      return defaultState();
    }
  }

  state = load();

  function save() {
    state.meta = state.meta || {};
    state.meta.lastActivity = new Date().toISOString();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function getState() {
    return state;
  }

  function replaceState(newState) {
    state = newState;
    save();
  }

  function formatMoney(amount, currency) {
    const n = Number(amount) || 0;
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD', maximumFractionDigits: 2 }).format(n);
    } catch (e) {
      return (currency || '') + ' ' + n.toFixed(2);
    }
  }

  function monthKey(date) {
    const d = date ? new Date(date) : new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  function todayISO() {
    return new Date().toISOString().slice(0, 10);
  }

  // Formats a YYYY-MM-DD date string per the user's chosen Profile ->
  // Date format preference. Used anywhere a transaction/debt/etc. date is
  // shown, so changing the preference once updates it everywhere.
  function formatDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso + 'T00:00:00');
    if (isNaN(d.getTime())) return iso;
    const fmt = (state.profile && state.profile.dateFormat) || 'DD MMM YYYY';
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    switch (fmt) {
      case 'DD.MM.YYYY': return `${dd}.${mm}.${yyyy}`;
      case 'MM/DD/YYYY': return `${mm}/${dd}/${yyyy}`;
      case 'YYYY-MM-DD': return `${yyyy}-${mm}-${dd}`;
      case 'DD MMM YYYY':
      default: return `${d.getDate()} ${d.toLocaleString('en-US', { month: 'short' })} ${yyyy}`;
    }
  }

  function ensureMonth(key) {
    if (!state.planner.months[key]) {
      state.planner.months[key] = { budgets: [], payments: [], incomes: [] };
    }
    // Older saved months may predate the `incomes` list — patch it in so
    // callers can always rely on it being an array.
    if (!state.planner.months[key].incomes) state.planner.months[key].incomes = [];
    return state.planner.months[key];
  }

  Monetra.storage = {
    STORAGE_KEY, CURRENCIES, EXPENSE_CATEGORIES, INCOME_CATEGORIES, CARD_NETWORKS,
    uid, defaultState, load, save, getState, replaceState,
    formatMoney, monthKey, todayISO, ensureMonth, formatDate
  };
})();
