window.Monetra = window.Monetra || {};

(function () {
  function totalAssets(displayCurrency) {
    const state = Monetra.storage.getState();
    let total = 0;
    const breakdown = [];
    state.accounts.forEach((a) => {
      const v = Monetra.currency.convert(a.balance, a.currency, displayCurrency);
      total += v;
      breakdown.push({ id: a.id, label: a.name, type: a.type, value: v });
    });
    state.investments.forEach((inv) => {
      const v = Monetra.currency.convert((inv.quantity || 0) * (inv.currentPrice || 0), inv.currency, displayCurrency);
      total += v;
      breakdown.push({ id: inv.id, label: inv.symbol, type: 'investment', value: v });
    });
    (state.wallets || []).forEach((w) => {
      const v = Monetra.currency.convert(w.balance, w.currency, displayCurrency);
      total += v;
      breakdown.push({ id: w.id, label: w.name, type: 'wallet', value: v });
    });
    return { total, breakdown };
  }

  function totalDebts(displayCurrency) {
    const state = Monetra.storage.getState();
    let total = 0;
    const breakdown = [];
    state.debts.forEach((d) => {
      const v = Monetra.currency.convert(d.currentDebt, d.currency, displayCurrency);
      total += v;
      breakdown.push({ id: d.id, label: d.name, value: v });
    });
    (state.paylaters || []).forEach((p) => {
      const v = Monetra.currency.convert(p.outstanding, p.currency, displayCurrency);
      total += v;
      breakdown.push({ id: p.id, label: p.provider, value: v });
    });
    return { total, breakdown };
  }

  function totalInvestments(displayCurrency) {
    const state = Monetra.storage.getState();
    let total = 0;
    state.investments.forEach((inv) => {
      total += Monetra.currency.convert((inv.quantity || 0) * (inv.currentPrice || 0), inv.currency, displayCurrency);
    });
    return total;
  }

  function netWorth(displayCurrency) {
    const assets = totalAssets(displayCurrency);
    const debts = totalDebts(displayCurrency);
    return { net: assets.total - debts.total, assets, debts };
  }

  // Currencies in use (accounts, investments, debts) that can't currently be
  // converted to displayCurrency — figures involving these are shown
  // unconverted rather than silently wrong.
  function unconvertedCurrencies(displayCurrency) {
    const state = Monetra.storage.getState();
    const used = new Set();
    state.accounts.forEach((a) => used.add(a.currency));
    state.investments.forEach((inv) => used.add(inv.currency));
    state.debts.forEach((d) => used.add(d.currency));
    (state.wallets || []).forEach((w) => used.add(w.currency));
    (state.paylaters || []).forEach((p) => used.add(p.currency));
    const missing = new Set();
    used.forEach((code) => {
      if (code && !Monetra.currency.canConvert(code, displayCurrency)) missing.add(code);
    });
    return Array.from(missing);
  }

  // Native total held directly in a given currency — accounts and
  // investments denominated in that currency, unconverted. Used for the
  // "money in INR / EUR / USD" cards on the dashboard.
  function moneyByCurrency(code) {
    const state = Monetra.storage.getState();
    let total = 0;
    let count = 0;
    state.accounts.forEach((a) => {
      if (a.currency === code) { total += a.balance; count++; }
    });
    state.investments.forEach((inv) => {
      if (inv.currency === code) { total += (inv.quantity || 0) * (inv.currentPrice || 0); count++; }
    });
    (state.wallets || []).forEach((w) => {
      if (w.currency === code) { total += w.balance; count++; }
    });
    return { total, count };
  }

  function transactionsInMonth(monthKey) {
    const state = Monetra.storage.getState();
    return state.transactions.filter((t) => t.date && t.date.slice(0, 7) === monthKey);
  }

  function monthSummary(monthKey, displayCurrency) {
    const txs = transactionsInMonth(monthKey);
    let income = 0, expense = 0;
    const byCategory = {};
    txs.forEach((t) => {
      const amt = Monetra.currency.convert(t.amount, t.currency || displayCurrency, displayCurrency);
      if (t.type === 'income') {
        income += amt;
      } else if (t.type === 'expense') {
        expense += amt;
        byCategory[t.category] = (byCategory[t.category] || 0) + amt;
      }
      // Transfer/Withdraw/Deposit just move money between the user's own
      // accounts — they're neither income nor spending, so they're
      // deliberately excluded from both totals (and from the category
      // breakdown, since they don't carry a spending category anyway).
    });
    return { income, expense, byCategory, count: txs.length };
  }

  // Calendar days in a "YYYY-MM" month key.
  function daysInMonth(monthKey) {
    const [y, m] = monthKey.split('-').map(Number);
    return new Date(y, m, 0).getDate();
  }

  // Real expense total per calendar day of the given month, for a daily
  // spending trend chart. Days with no expense transactions are 0 — that's
  // an honest reading (nothing was spent), not a gap to fill in.
  function dailySpendTrend(monthKey, displayCurrency) {
    const days = daysInMonth(monthKey);
    const totals = new Array(days).fill(0);
    transactionsInMonth(monthKey).forEach((t) => {
      if (t.type !== 'expense' || !t.date) return;
      const day = Number(t.date.slice(8, 10));
      if (day >= 1 && day <= days) {
        totals[day - 1] += Monetra.currency.convert(t.amount, t.currency || displayCurrency, displayCurrency);
      }
    });
    return totals.map((value, i) => ({ day: i + 1, value }));
  }

  // Last `n` months (including the current one), each with real income,
  // expense, and savings (income - expense) — all from real transactions,
  // never planner estimates.
  function lastNMonthsTrend(n, displayCurrency) {
    const now = new Date();
    const months = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      const s = monthSummary(key, displayCurrency);
      months.push({ key, label: d.toLocaleString('en-US', { month: 'short' }), income: s.income, expense: s.expense, savings: s.income - s.expense });
    }
    return months;
  }

  function last6MonthsTrend(displayCurrency) {
    return lastNMonthsTrend(6, displayCurrency);
  }

  Monetra.calc = { totalAssets, totalDebts, totalInvestments, netWorth, moneyByCurrency, transactionsInMonth, monthSummary, daysInMonth, dailySpendTrend, last6MonthsTrend, lastNMonthsTrend, unconvertedCurrencies };
})();
