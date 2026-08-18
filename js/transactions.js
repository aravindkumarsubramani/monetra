window.Monetra = window.Monetra || {};

/* Day-to-day transaction log. Five kinds of entry:
   - Pay (expense)    — money leaves one account, in that account's currency
   - Receive (income) — money arrives in one account, in that account's currency
   - Transfer          — money moves between any two of your own accounts,
     which may be in different currencies (e.g. INR account -> EUR account)
   - Withdraw          — a guided transfer from a bank account to a cash
     account (an ATM withdrawal)
   - Deposit           — a guided transfer from a cash account to a bank
     account (banking cash you're holding)
   Transfer/Withdraw/Deposit all share the same underlying "money moves from
   one account to another" bookkeeping; Withdraw/Deposit just pre-filter the
   account pickers to the right account types so there's less to choose. The
   received amount is suggested from the app's exchange rate but is always
   editable, since a real transfer's rate can differ (bank fees, spread).
   Pay/Receive also carry a payment method (Card / Cash / UPI / Bank
   Transfer / Other) — which account you pick already tells you "which
   bank" (accounts show their bank name in the picker).

   Templates: a saved preset (name + every field except date) that a new
   transaction can start from, so a recurring entry (e.g. "Pay Rent,
   Housing, Card") doesn't need retyping every time — only the date
   (already defaults to today) and, if it varies, the amount need
   touching. Managed via the "Templates" button in the header.

   Add form: lives inline at the top of the Transactions tab (no click
   needed to reveal it) so it's always right there. Editing an existing row
   still opens in a modal. Both share the same field-building/wiring code,
   parameterized by an id `prefix` ("txAdd" inline, "tx" in the modal) so
   the two can never collide if a row's Edit modal is opened while the
   inline Add form is still on the page. */
(function () {
  function escape(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

  const METHODS = ['Card', 'Cash', 'UPI', 'Bank Transfer', 'Other'];
  // Types whose balance effect is "amount leaves fromAccountId, toAmount
  // arrives in toAccountId" — Transfer, Withdraw, and Deposit are all the
  // same shape underneath, just with different account-picker defaults.
  const MOVE_TYPES = ['transfer', 'withdraw', 'deposit'];
  const MOVE_TYPE_LABELS = { transfer: 'Transfer', withdraw: 'Withdraw', deposit: 'Deposit' };

  let currentMonth = Monetra.storage.monthKey();
  let categoryChart = null;
  let trendChart = null;

  // Transactions now live in the database, requiring login — same
  // login-gate + syncedForUserId pattern used for PayLater/Accounts/
  // Planner. syncedForUserId tracks which account's ledger + templates are
  // currently mirrored into state.transactions/state.transactionTemplates;
  // it's reset to null on logout (forcing a fresh fetch next login) and
  // after every mutation (forcing a fresh refetch of the authoritative
  // server copy, rather than hand-patching the local cache).
  function isLoggedIn() {
    return !!(Monetra.auth && Monetra.auth.isLoggedIn());
  }
  let syncedForUserId = null;

  const ICON_DOWN = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v16"/><path d="M6 14l6 6 6-6"/></svg>';
  const ICON_UP = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20V4"/><path d="M6 10l6-6 6 6"/></svg>';
  const ICON_WAVE = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2 6 4-12 2 6h6"/></svg>';
  const ICON_CALENDAR = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M8 3v4M16 3v4"/></svg>';

  // Categories keep a fixed color order — their position in the master
  // EXPENSE_CATEGORIES list — so a category's color never shifts just
  // because its share of this month's spending changed relative to others.
  // A folded "Other" bucket gets the neutral muted tone, never a real
  // category's hue.
  function categoryColor(category) {
    const idx = Monetra.storage.EXPENSE_CATEGORIES.indexOf(category);
    return idx === -1 ? Monetra.palette.muted : Monetra.palette.categoryColor(idx);
  }

  function foldCategories(byCategory, max) {
    const entries = Object.keys(byCategory).map((label) => ({ label, value: byCategory[label], color: categoryColor(label) }));
    entries.sort((a, b) => b.value - a.value);
    if (entries.length <= max) return entries;
    const top = entries.slice(0, max - 1);
    const rest = entries.slice(max - 1);
    const otherTotal = rest.reduce((s, e) => s + e.value, 0);
    top.push({ label: 'Other', value: otherTotal, color: Monetra.palette.muted });
    return top;
  }

  function kpiCardHtml(label, value, colorClass, icon, subText, deltaClass) {
    return `<div class="debt-kpi">
      <div class="debt-kpi-icon ${colorClass}">${icon}</div>
      <div>
        <div class="debt-kpi-label">${label}</div>
        <div class="debt-kpi-value">${value}</div>
        <div class="debt-kpi-sub ${deltaClass || ''}">${escape(subText)}</div>
      </div>
    </div>`;
  }

  // Turns a month-over-month % change into display text + a favorability
  // color class. The arrow always reflects the real direction of change;
  // the color separately reflects whether that direction is good news for
  // this particular metric (e.g. spending going down is good, so it's
  // colored green even though the arrow points down). `lowerIsBetter`
  // decides which direction counts as favorable. Returns a neutral
  // (uncolored) result when there's no prior-month baseline to compare to,
  // rather than fabricating a percentage against zero.
  function deltaInfo(pctChange, prevLabel, lowerIsBetter) {
    if (pctChange === null) return { text: `No ${prevLabel} data to compare`, cls: '' };
    if (pctChange === Infinity) return { text: `New this month — no ${prevLabel} data`, cls: '' };
    const favorable = lowerIsBetter ? pctChange <= 0 : pctChange >= 0;
    const arrow = pctChange >= 0 ? '▲' : '▼';
    return { text: `${arrow} ${Math.abs(pctChange).toFixed(1)}% vs ${prevLabel}`, cls: 'stat-delta ' + (favorable ? 'up' : 'down') };
  }

  // Days to divide by for an "average per day" figure: the full month for
  // any month that has already fully elapsed, but only the days elapsed so
  // far for the real current month in progress — otherwise a partial
  // month's average would be diluted by future days that haven't happened.
  function daysElapsedForAvg(monthKey) {
    const todayIso = Monetra.storage.todayISO();
    const totalDays = Monetra.calc.daysInMonth(monthKey);
    if (monthKey === todayIso.slice(0, 7)) {
      return Math.max(1, Math.min(Number(todayIso.slice(8, 10)), totalDays));
    }
    return totalDays;
  }

  function prevMonthInfo(monthKey) {
    const [y, m] = monthKey.split('-').map(Number);
    const d = new Date(y, m - 2, 1);
    const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    return { key, label: d.toLocaleString('en-US', { month: 'short' }) };
  }

  function pctChange(curVal, prevVal) {
    if (prevVal === 0) return curVal === 0 ? null : Infinity;
    return ((curVal - prevVal) / Math.abs(prevVal)) * 100;
  }

  // Everything the Spending Overview panel needs for one month: real
  // totals (Pay/Receive only — transfers never count as spend or income),
  // and month-over-month deltas against whichever month came right before
  // the one being viewed.
  function computeSpendingOverview(monthKey, disp) {
    const cur = Monetra.calc.monthSummary(monthKey, disp);
    const prev = prevMonthInfo(monthKey);
    const prevSummary = Monetra.calc.monthSummary(prev.key, disp);

    const avgDailySpend = cur.expense / daysElapsedForAvg(monthKey);
    const prevAvgDailySpend = prevSummary.expense / daysElapsedForAvg(prev.key);
    const netCashFlow = cur.income - cur.expense;
    const prevNetCashFlow = prevSummary.income - prevSummary.expense;

    return {
      monthKey, prevLabel: prev.label,
      totalSpent: cur.expense, totalIncome: cur.income, netCashFlow, avgDailySpend,
      totalSpentDeltaPct: pctChange(cur.expense, prevSummary.expense),
      totalIncomeDeltaPct: pctChange(cur.income, prevSummary.income),
      netCashFlowDeltaPct: pctChange(netCashFlow, prevNetCashFlow),
      avgDailySpendDeltaPct: pctChange(avgDailySpend, prevAvgDailySpend),
      byCategory: cur.byCategory,
      txCount: cur.count,
      prevTxCount: prevSummary.count
    };
  }

  function renderCategoryChart(segments, disp) {
    const ctx = document.getElementById('spendCategoryChartCanvas');
    if (!ctx || typeof Chart === 'undefined' || !segments.length) return;
    if (categoryChart) categoryChart.destroy();
    categoryChart = new Chart(ctx, {
      type: 'doughnut',
      data: { labels: segments.map((s) => s.label), datasets: [{ data: segments.map((s) => s.value), backgroundColor: segments.map((s) => s.color), borderColor: '#fcfcfb', borderWidth: 2 }] },
      options: { cutout: '68%', plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.label}: ${Monetra.storage.formatMoney(c.parsed, disp)}` } } } }
    });
  }

  // Single-series daily spend, so no legend is needed (the chart title
  // already names the one series) — thin line, light fill, recessive grid.
  function renderTrendChart(trend, disp) {
    const ctx = document.getElementById('spendTrendChartCanvas');
    if (!ctx || typeof Chart === 'undefined') return;
    if (trendChart) trendChart.destroy();
    trendChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: trend.map((t) => t.day),
        datasets: [{ data: trend.map((t) => t.value), borderColor: Monetra.palette.expense, backgroundColor: Monetra.palette.expense + '1a', borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, pointHoverBackgroundColor: Monetra.palette.expense, tension: 0.25, fill: true }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { title: (items) => 'Day ' + items[0].label, label: (c) => Monetra.storage.formatMoney(c.parsed.y, disp) } }
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: Monetra.palette.ink2, maxTicksLimit: 8 }, border: { display: false } },
          y: { grid: { color: Monetra.palette.grid }, ticks: { color: Monetra.palette.ink2 }, border: { display: false }, beginAtZero: true }
        }
      }
    });
  }

  function accountName(state, id) {
    const a = state.accounts.find((x) => x.id === id);
    return a ? a.name : '(deleted account)';
  }

  function accountOptionLabel(a) {
    return `${a.name}${a.bank ? ' — ' + a.bank : ''} (${a.currency})`;
  }

  function accountOptionsHtml(accounts, selectedId) {
    return accounts.map((a) => `<option value="${a.id}" ${a.id === selectedId ? 'selected' : ''}>${escape(accountOptionLabel(a))}</option>`).join('');
  }

  function templateSummary(state, t) {
    if (MOVE_TYPES.includes(t.type)) {
      return `${MOVE_TYPE_LABELS[t.type] || 'Transfer'}: ${accountName(state, t.fromAccountId)} → ${accountName(state, t.toAccountId)}`;
    }
    return `${t.type === 'income' ? 'Receive' : 'Pay'} · ${t.category || 'Uncategorized'} · ${accountName(state, t.accountId)}`;
  }

  function templateCurrency(state, t) {
    const accId = MOVE_TYPES.includes(t.type) ? t.fromAccountId : t.accountId;
    const acc = state.accounts.find((a) => a.id === accId);
    return acc ? acc.currency : state.settings.displayCurrency;
  }

  function render() {
    const el = document.getElementById('tab-transactions');
    if (!el) return;

    if (!isLoggedIn()) {
      syncedForUserId = null;
      el.innerHTML = `
        <div class="section-header"><h2>Transactions</h2></div>
        <div class="card" style="max-width:520px;">
          <h3 style="margin-top:0;">Log in to use Transactions</h3>
          <p class="hint" style="margin-top:0;">Your transaction ledger and templates are saved to your Monetra account, not this browser — so you'll need to be logged in to add or view them. Everything else in Monetra still works without logging in.</p>
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
      // account's transactions, cached from before that account logged out
      // (the same class of bug already fixed once for the Settings API
      // keys). Show a loading state and only draw real rows once the
      // server has answered for whoever is actually logged in right now.
      el.innerHTML = `<div class="section-header"><h2>Transactions</h2></div><div class="hint">Loading your transactions…</div>`;

      Promise.all([
        Monetra.auth.authFetch('/api/transactions', { method: 'GET' }),
        Monetra.auth.authFetch('/api/transaction-templates', { method: 'GET' })
      ]).then(([txResult, tplResult]) => {
        const state = Monetra.storage.getState();
        state.transactions = txResult.transactions || [];
        state.transactionTemplates = tplResult.templates || [];
        Monetra.storage.save();
        syncedForUserId = userId;
        // Safe to call renderAll here: render() will now take the
        // "already synced" branch below and just redraw from the cache it
        // was just given, instead of fetching again.
        Monetra.app.renderAll();
      }).catch((err) => {
        el.innerHTML = `<div class="section-header"><h2>Transactions</h2></div><div class="hint" style="color:var(--critical);">Could not load your transactions: ${escape(err.message)}</div>`;
      });
      return;
    }

    renderList(el);
  }

  function renderList(el) {
    const state = Monetra.storage.getState();

    const txs = state.transactions
      .filter((t) => t.date && t.date.slice(0, 7) === currentMonth)
      .sort((a, b) => (a.date < b.date ? 1 : -1));

    const rows = txs.map((t) => {
      if (MOVE_TYPES.includes(t.type)) {
        return `<tr data-id="${t.id}">
          <td>${Monetra.storage.formatDate(t.date)}</td>
          <td><span class="pill pill-transfer">${MOVE_TYPE_LABELS[t.type] || 'Transfer'}</span></td>
          <td>${escape(accountName(state, t.fromAccountId))} → ${escape(accountName(state, t.toAccountId))}</td>
          <td class="muted">—</td>
          <td>${Monetra.storage.formatMoney(t.amount, t.currency)} → ${Monetra.storage.formatMoney(t.toAmount, t.toCurrency)}</td>
          <td class="muted">—</td>
          <td class="muted">${escape(t.note || '')}</td>
          <td>
            <button class="btn btn-ghost btn-sm" data-action="edit">Edit</button>
            <button class="btn btn-danger btn-sm" data-action="delete">Delete</button>
          </td>
        </tr>`;
      }
      return `<tr data-id="${t.id}">
        <td>${Monetra.storage.formatDate(t.date)}</td>
        <td><span class="pill ${t.type === 'income' ? 'pill-income' : 'pill-expense'}">${t.type === 'income' ? 'Income' : 'Expense'}</span></td>
        <td>${escape(accountName(state, t.accountId))}</td>
        <td>${escape(t.category)}</td>
        <td>${Monetra.storage.formatMoney(t.amount, t.currency)}</td>
        <td>${escape(t.method || '—')}</td>
        <td class="muted">${escape(t.note || '')}</td>
        <td>
          <button class="btn btn-ghost btn-sm" data-action="edit">Edit</button>
          <button class="btn btn-danger btn-sm" data-action="delete">Delete</button>
        </td>
      </tr>`;
    }).join('');

    const hasAccounts = state.accounts.length > 0;
    const disp = state.settings.displayCurrency;
    const overview = computeSpendingOverview(currentMonth, disp);
    const hasOverviewData = overview.txCount > 0 || overview.prevTxCount > 0;
    const categorySegments = foldCategories(overview.byCategory, 6);
    const trend = Monetra.calc.dailySpendTrend(currentMonth, disp);
    const spentDelta = deltaInfo(overview.totalSpentDeltaPct, overview.prevLabel, true);
    const incomeDelta = deltaInfo(overview.totalIncomeDeltaPct, overview.prevLabel, false);
    const cashFlowDelta = deltaInfo(overview.netCashFlowDeltaPct, overview.prevLabel, false);
    const avgSpendDelta = deltaInfo(overview.avgDailySpendDeltaPct, overview.prevLabel, true);
    const catPct = (part) => (overview.totalSpent > 0 ? ((part / overview.totalSpent) * 100).toFixed(1) : '0');

    const overviewHtml = !hasAccounts ? '' : !hasOverviewData ? `
      <div class="hint" style="margin-bottom:18px;">Add a transaction to see your spending overview for ${currentMonth}.</div>` : `
      <div class="debts-kpis">
        ${kpiCardHtml('TOTAL SPENT', Monetra.storage.formatMoney(overview.totalSpent, disp), 'kpi-red', ICON_DOWN, spentDelta.text, spentDelta.cls)}
        ${kpiCardHtml('TOTAL INCOME', Monetra.storage.formatMoney(overview.totalIncome, disp), 'kpi-green', ICON_UP, incomeDelta.text, incomeDelta.cls)}
        ${kpiCardHtml('NET CASH FLOW', Monetra.storage.formatMoney(overview.netCashFlow, disp), 'kpi-violet', ICON_WAVE, cashFlowDelta.text, cashFlowDelta.cls)}
        ${kpiCardHtml('AVG. DAILY SPEND', Monetra.storage.formatMoney(overview.avgDailySpend, disp), 'kpi-orange', ICON_CALENDAR, avgSpendDelta.text, avgSpendDelta.cls)}
      </div>
      <div class="planner-row" style="margin-bottom:20px;">
        <div style="flex:1 1 260px;"><div class="card">
          <div class="panel-title">Spending overview <span class="muted small" style="font-weight:400;">${currentMonth}</span></div>
          ${categorySegments.length ? `
          <div style="position:relative; max-width:190px; margin:0 auto;">
            <canvas id="spendCategoryChartCanvas"></canvas>
            <div class="donut-center-label">
              <div class="donut-center-value" style="font-size:14px;">${Monetra.storage.formatMoney(overview.totalSpent, disp)}</div>
              <div class="donut-center-sub">Total spent</div>
            </div>
          </div>
          <div class="cashflow-legend">
            ${categorySegments.map((s) => `<div class="cashflow-legend-row"><span class="cashflow-legend-label"><span class="cashflow-dot" style="background:${s.color};"></span>${escape(s.label)}</span><span>${Monetra.storage.formatMoney(s.value, disp)} · ${catPct(s.value)}%</span></div>`).join('')}
          </div>` : '<div class="empty-state">No spending recorded this month.</div>'}
        </div></div>
        <div style="flex:1.5 1 340px;"><div class="card">
          <div class="panel-title">Spending trend <span class="muted small" style="font-weight:400;">daily, ${currentMonth}</span></div>
          ${overview.totalSpent > 0 ? `<div class="chart-wrap" style="height:230px;"><canvas id="spendTrendChartCanvas"></canvas></div>` : '<div class="empty-state">No spending recorded this month.</div>'}
        </div></div>
        <div style="flex:1 1 260px;"><div class="card">
          <div class="panel-title">Spending by category</div>
          ${categorySegments.length ? categorySegments.map((s) => `
            <div class="meter-row"><span>${escape(s.label)}</span><span>${Monetra.storage.formatMoney(s.value, disp)}</span></div>
            <div class="meter" style="margin-bottom:12px;"><div class="meter-fill" style="width:${catPct(s.value)}%; background:${s.color};"></div></div>
          `).join('') : '<div class="empty-state">No spending recorded this month.</div>'}
        </div></div>
      </div>`;

    el.innerHTML = `
      <div class="section-header">
        <h2>Transactions</h2>
        <div class="section-actions">
          <div class="month-picker">
            <button class="btn btn-ghost btn-sm" id="prevMonthBtn">‹</button>
            <input type="month" id="monthInput" value="${currentMonth}">
            <button class="btn btn-ghost btn-sm" id="nextMonthBtn">›</button>
          </div>
          <button class="btn btn-ghost btn-sm" id="manageTemplatesBtn">Templates</button>
        </div>
      </div>
      ${overviewHtml}
      ${hasAccounts ? `
      <div class="card" style="margin-bottom:18px;">
        <div class="panel-title">Add transaction</div>
        ${formHtml(state, null, 'txAdd', { showCancel: false, showTemplatePicker: true, submitLabel: '+ Add transaction' })}
      </div>` : `<div class="empty-state">Add a bank or cash account first, then record transactions against it.</div>`}
      <div class="card">
        <div class="table-wrap">
          <table>
            <thead><tr><th>Date</th><th>Type</th><th>Account</th><th>Category</th><th>Amount</th><th>Method</th><th>Note</th><th></th></tr></thead>
            <tbody>${rows || `<tr><td colspan="8" class="empty-state">No transactions in ${currentMonth}.</td></tr>`}</tbody>
          </table>
        </div>
      </div>
    `;

    document.getElementById('monthInput').onchange = (e) => { currentMonth = e.target.value || Monetra.storage.monthKey(); render(); };
    document.getElementById('prevMonthBtn').onclick = () => { currentMonth = shiftMonth(currentMonth, -1); render(); };
    document.getElementById('nextMonthBtn').onclick = () => { currentMonth = shiftMonth(currentMonth, 1); render(); };
    document.getElementById('manageTemplatesBtn').onclick = () => openTemplatesManager();

    if (hasAccounts && hasOverviewData) {
      renderCategoryChart(categorySegments, disp);
      if (overview.totalSpent > 0) renderTrendChart(trend, disp);
    }

    if (hasAccounts) {
      wireForm(el, null, 'txAdd', {
        onSaved: (date) => { currentMonth = date.slice(0, 7); Monetra.app.renderAll(); }
      });
    }

    el.querySelectorAll('tbody tr[data-id]').forEach((row) => {
      const id = row.dataset.id;
      row.querySelector('[data-action="edit"]').onclick = () => openEditModal(id);
      row.querySelector('[data-action="delete"]').onclick = () => {
        if (confirm('Delete this transaction? The linked account balance(s) will be adjusted back.')) {
          removeTransaction(id);
        }
      };
    });
  }

  function shiftMonth(key, delta) {
    const [y, m] = key.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  function applyAccountDelta(state, accountId, delta) {
    const account = state.accounts.find((a) => a.id === accountId);
    if (account) account.balance += delta;
  }

  // sign = +1 to apply a transaction's effect on balances, -1 to reverse it.
  function applyTransactionEffect(state, tx, sign) {
    if (!tx) return;
    if (tx.type === 'income') applyAccountDelta(state, tx.accountId, sign * tx.amount);
    else if (tx.type === 'expense') applyAccountDelta(state, tx.accountId, -sign * tx.amount);
    else if (MOVE_TYPES.includes(tx.type)) {
      applyAccountDelta(state, tx.fromAccountId, -sign * tx.amount);
      applyAccountDelta(state, tx.toAccountId, sign * tx.toAmount);
    }
  }

  function affectedAccountIds(tx) {
    if (!tx) return [];
    if (MOVE_TYPES.includes(tx.type)) return [tx.fromAccountId, tx.toAccountId].filter(Boolean);
    return tx.accountId ? [tx.accountId] : [];
  }

  // Accounts now live in the database (js/accounts.js) — a transaction
  // changes an account's balance locally and instantly (unchanged, so the
  // app still feels the same to use), but if logged in, that new balance
  // also needs pushing to the server in the background so it doesn't only
  // exist in this browser. Silent on failure (console.warn only) — a
  // transaction shouldn't be blocked or interrupted by a background sync
  // hiccup; accounts.js's own tab-open sync will reconcile it later anyway.
  function syncAffectedAccounts(ids) {
    if (!(Monetra.auth && Monetra.auth.isLoggedIn())) return;
    Array.from(new Set(ids.filter(Boolean))).forEach((id) => Monetra.accounts.syncOne(id));
  }

  function removeTransaction(id) {
    const state = Monetra.storage.getState();
    const tx = state.transactions.find((t) => t.id === id);
    Monetra.auth.authFetch('/api/transactions/' + id, { method: 'DELETE' })
      .then(() => {
        if (tx) applyTransactionEffect(state, tx, -1); // reverse locally so account balances stay correct
        Monetra.storage.save();
        if (tx) syncAffectedAccounts(affectedAccountIds(tx));
        syncedForUserId = null; // force a fresh refetch of the ledger
        Monetra.app.renderAll();
      })
      .catch((err) => alert('Could not delete that transaction: ' + err.message));
  }

  function openTemplatesManager() {
    const state = Monetra.storage.getState();
    const rows = state.transactionTemplates.map((t) => `
      <div class="list-item" data-id="${t.id}">
        <div class="item-main">
          <div class="item-title">${escape(t.name)}</div>
          <div class="item-sub">${escape(templateSummary(state, t))}${t.amount ? ' · ' + Monetra.storage.formatMoney(t.amount, templateCurrency(state, t)) : ''}</div>
        </div>
        <div class="item-actions">
          <button class="btn btn-danger btn-sm" data-action="delete">Delete</button>
        </div>
      </div>`).join('');
    const html = `
      <h2>Manage templates</h2>
      <div class="list">${rows || '<div class="empty-state">No templates saved yet — check "Save this as a reusable template" when adding a transaction.</div>'}</div>
      <div class="modal-actions"><button type="button" class="btn btn-ghost" id="closeTemplatesBtn">Close</button></div>`;
    Monetra.modal.open(html, (root) => {
      root.querySelector('#closeTemplatesBtn').onclick = () => Monetra.modal.close();
      root.querySelectorAll('[data-action="delete"]').forEach((btn) => {
        btn.onclick = () => {
          const id = btn.closest('[data-id]').dataset.id;
          if (confirm('Delete this template? Transactions already created from it are not affected.')) {
            btn.disabled = true;
            Monetra.auth.authFetch('/api/transaction-templates/' + id, { method: 'DELETE' })
              .then(() => {
                syncedForUserId = null; // force a fresh refetch of templates
                Monetra.modal.close();
                Monetra.app.renderAll();
              })
              .catch((err) => { btn.disabled = false; alert('Could not delete that template: ' + err.message); });
          }
        };
      });
    });
  }

  // Shared create/update path so any tab can commit a transaction without
  // duplicating the account-balance bookkeeping. Persists to the server
  // first (transactions now live in the database, requiring login); once
  // that succeeds, the affected account balance(s) are updated locally and
  // pushed to the server in the background (same as before), and the local
  // ledger cache is invalidated so the next render() re-fetches the
  // authoritative copy from the server rather than being hand-patched here.
  // Returns a Promise. Does not touch the UI — callers close their own
  // modal/re-render afterwards via onSaved.
  function saveTransaction(id, data) {
    const st = Monetra.storage.getState();
    if (id) {
      const existing = st.transactions.find((t) => t.id === id);
      if (!existing) return Promise.resolve(null);
      const affected = affectedAccountIds(existing).concat(affectedAccountIds(data));
      return Monetra.auth.authFetch('/api/transactions/' + id, { method: 'PUT', body: JSON.stringify(data) })
        .then(() => {
          applyTransactionEffect(st, existing, -1); // reverse old
          applyTransactionEffect(st, data, 1); // apply new
          Monetra.storage.save();
          syncAffectedAccounts(affected);
          syncedForUserId = null; // force a fresh refetch of the ledger
          return existing;
        });
    }
    data.id = Monetra.storage.uid('tx');
    return Monetra.auth.authFetch('/api/transactions', { method: 'POST', body: JSON.stringify(data) })
      .then(() => {
        applyTransactionEffect(st, data, 1);
        Monetra.storage.save();
        syncAffectedAccounts(affectedAccountIds(data));
        syncedForUserId = null; // force a fresh refetch of the ledger
        return data;
      });
  }

  function categoryOptions(type, selected) {
    const list = type === 'income' ? Monetra.storage.INCOME_CATEGORIES : Monetra.storage.EXPENSE_CATEGORIES;
    return list.map((c) => `<option value="${c}" ${c === selected ? 'selected' : ''}>${c}</option>`).join('');
  }

  function payReceiveFieldsHtml(state, type, existing) {
    return `
      <div class="form-row"><label>Account</label>
        <select name="accountId">${accountOptionsHtml(state.accounts, existing ? existing.accountId : null)}</select>
      </div>
      <div class="form-grid-2">
        <div class="form-row"><label>Category</label><select name="category">${categoryOptions(type, existing ? existing.category : null)}</select></div>
        <div class="form-row"><label>Amount</label><input name="amount" type="number" step="0.01" min="0.01" required value="${existing ? existing.amount : ''}"></div>
      </div>
      <div class="form-grid-2">
        <div class="form-row"><label>Payment method</label>
          <select name="method">${METHODS.map((m) => `<option value="${m}" ${existing && existing.method === m ? 'selected' : ''}>${m}</option>`).join('')}</select>
        </div>
        <div class="form-row"><label>Note (optional)</label><input name="note" value="${existing ? escape(existing.note || '') : ''}"></div>
      </div>`;
  }

  // Shared field layout for Transfer / Withdraw / Deposit — only the
  // account lists offered and the field labels change between them.
  // `prefix` keeps the From/To account+amount element ids unique between
  // the inline Add form and the Edit modal, since both can be in the DOM
  // at the same time.
  function moveFieldsHtml(fromAccounts, toAccounts, labels, existing, prefix) {
    if (!fromAccounts.length || !toAccounts.length) {
      return `<div class="empty-state" style="padding:20px 0;">${escape(labels.missing)}</div>`;
    }
    // Default "To account" to a different account than "From account" when
    // creating a new entry, so the form doesn't start on an invalid
    // same-account pairing.
    const fromId = existing ? existing.fromAccountId : fromAccounts[0].id;
    const toId = existing ? existing.toAccountId : ((toAccounts.find((a) => a.id !== fromId) || toAccounts[0]).id);
    return `
      <div class="form-grid-2">
        <div class="form-row"><label>${labels.from}</label><select name="fromAccountId" id="${prefix}FromAccount">${accountOptionsHtml(fromAccounts, fromId)}</select></div>
        <div class="form-row"><label>${labels.to}</label><select name="toAccountId" id="${prefix}ToAccount">${accountOptionsHtml(toAccounts, toId)}</select></div>
      </div>
      <div class="form-grid-2">
        <div class="form-row"><label>${labels.amountFrom}</label><input name="amount" type="number" step="0.01" min="0.01" required id="${prefix}FromAmount" value="${existing ? existing.amount : ''}"></div>
        <div class="form-row"><label>${labels.amountTo}</label><input name="toAmount" type="number" step="0.01" min="0.01" required id="${prefix}ToAmount" value="${existing ? existing.toAmount : ''}"></div>
      </div>
      <div class="hint">${labels.hint}</div>
      <div class="form-row"><label>Note (optional)</label><input name="note" value="${existing ? escape(existing.note || '') : ''}"></div>`;
  }

  function transferFieldsHtml(state, existing, prefix) {
    return moveFieldsHtml(state.accounts, state.accounts, {
      from: 'From account', to: 'To account',
      amountFrom: 'Amount sent', amountTo: 'Amount received',
      hint: 'Amount received is suggested from the current exchange rate — edit it if your bank used a different rate.',
      missing: 'Add at least two accounts first, then record a transfer between them.'
    }, existing, prefix);
  }

  function withdrawFieldsHtml(state, existing, prefix) {
    const banks = state.accounts.filter((a) => a.type === 'bank');
    const cash = state.accounts.filter((a) => a.type === 'cash');
    return moveFieldsHtml(banks, cash, {
      from: 'From bank account', to: 'To cash',
      amountFrom: 'Amount withdrawn', amountTo: 'Amount received as cash',
      hint: 'Amount received is suggested from the current exchange rate — usually the same as amount withdrawn unless your bank and cash are in different currencies.',
      missing: !banks.length && !cash.length ? 'Add a bank account and a cash account first to record a withdrawal.' : !banks.length ? 'Add a bank account first to record a withdrawal.' : 'Add a cash account first to record a withdrawal.'
    }, existing, prefix);
  }

  function depositFieldsHtml(state, existing, prefix) {
    const banks = state.accounts.filter((a) => a.type === 'bank');
    const cash = state.accounts.filter((a) => a.type === 'cash');
    return moveFieldsHtml(cash, banks, {
      from: 'From cash', to: 'To bank account',
      amountFrom: 'Amount deposited', amountTo: 'Amount received in bank',
      hint: 'Amount received is suggested from the current exchange rate — usually the same as amount deposited unless your bank and cash are in different currencies.',
      missing: !cash.length && !banks.length ? 'Add a cash account and a bank account first to record a deposit.' : !cash.length ? 'Add a cash account first to record a deposit.' : 'Add a bank account first to record a deposit.'
    }, existing, prefix);
  }

  function fieldsHtml(state, type, existing, prefix) {
    if (type === 'transfer') return transferFieldsHtml(state, existing, prefix);
    if (type === 'withdraw') return withdrawFieldsHtml(state, existing, prefix);
    if (type === 'deposit') return depositFieldsHtml(state, existing, prefix);
    return payReceiveFieldsHtml(state, type, existing);
  }

  // Builds the full form markup (template picker + date/type + dynamic
  // fields + save-as-template controls + actions). Used both inline (Add,
  // prefix "txAdd") and inside the Edit modal (prefix "tx").
  function formHtml(state, existing, prefix, opts) {
    const type = existing ? existing.type : 'expense';
    const templateOptionsHtml = opts.showTemplatePicker && !existing && state.transactionTemplates.length
      ? state.transactionTemplates.map((t) => `<option value="${t.id}">${escape(t.name)} — ${escape(templateSummary(state, t))}</option>`).join('')
      : '';

    return `
      <form id="${prefix}Form">
        ${templateOptionsHtml ? `
        <div class="form-row"><label>Start from a template <span class="muted small" style="font-weight:400;">(optional)</span></label>
          <select id="${prefix}TemplateSelect">
            <option value="">— None, start blank —</option>
            ${templateOptionsHtml}
          </select>
        </div>` : ''}
        <div class="form-grid-2">
          <div class="form-row"><label>Date</label><input name="date" type="date" required value="${existing ? existing.date : Monetra.storage.todayISO()}"></div>
          <div class="form-row"><label>Type</label>
            <select name="type" id="${prefix}Type">
              <option value="expense" ${type === 'expense' ? 'selected' : ''}>Pay (expense)</option>
              <option value="income" ${type === 'income' ? 'selected' : ''}>Receive (income)</option>
              <option value="transfer" ${type === 'transfer' ? 'selected' : ''}>Transfer between accounts</option>
              <option value="withdraw" ${type === 'withdraw' ? 'selected' : ''}>Withdraw (bank → cash)</option>
              <option value="deposit" ${type === 'deposit' ? 'selected' : ''}>Deposit (cash → bank)</option>
            </select>
          </div>
        </div>
        <div id="${prefix}DynamicFields">${fieldsHtml(state, type, existing, prefix)}</div>
        <div class="form-row" style="margin-top:2px;">
          <label style="display:flex; align-items:center; gap:7px; font-weight:400;"><input type="checkbox" id="${prefix}SaveTemplate"> Save this as a reusable template</label>
        </div>
        <div class="form-row" id="${prefix}TemplateNameRow" style="display:none;"><label>Template name</label><input type="text" id="${prefix}TemplateName" placeholder="e.g. Monthly rent"></div>
        <div class="modal-actions" style="${opts.showCancel ? '' : 'justify-content:flex-end;'}">
          ${opts.showCancel ? `<button type="button" class="btn btn-ghost" id="${prefix}CancelBtn">Cancel</button>` : ''}
          <button type="submit" class="btn btn-primary">${opts.submitLabel}</button>
        </div>
      </form>`;
  }

  // Wires every interactive bit of a form built by formHtml() — transfer
  // amount auto-conversion, the template picker, type switching, the
  // save-as-template checkbox, and submit. `root` is the DOM ancestor that
  // contains the form (the whole tab element for the inline Add form, the
  // modal root for Edit). `existing` is the transaction being edited, or
  // null for Add. `opts.onSaved(date)` runs after a successful save.
  function wireForm(root, existing, prefix, opts) {
    const cancelBtn = root.querySelector(`#${prefix}CancelBtn`);
    if (cancelBtn) cancelBtn.onclick = () => Monetra.modal.close();

    function wireTransferAutoConvert() {
      const fromSel = root.querySelector(`#${prefix}FromAccount`);
      if (!fromSel) return;
      const toSel = root.querySelector(`#${prefix}ToAccount`);
      const fromAmt = root.querySelector(`#${prefix}FromAmount`);
      const toAmt = root.querySelector(`#${prefix}ToAmount`);
      let toAmountEdited = false;
      function recompute() {
        const st = Monetra.storage.getState();
        const fromAcc = st.accounts.find((a) => a.id === fromSel.value);
        const toAcc = st.accounts.find((a) => a.id === toSel.value);
        const amt = parseFloat(fromAmt.value);
        if (fromAcc && toAcc && !isNaN(amt)) {
          const converted = Monetra.currency.convert(amt, fromAcc.currency, toAcc.currency);
          toAmt.value = converted ? converted.toFixed(2) : '';
        }
      }
      fromAmt.addEventListener('input', () => { if (!toAmountEdited) recompute(); });
      fromSel.addEventListener('change', () => { toAmountEdited = false; recompute(); });
      toSel.addEventListener('change', () => { toAmountEdited = false; recompute(); });
      toAmt.addEventListener('input', () => { toAmountEdited = true; });
      if (!existing) recompute(); // seed a suggested value for a brand-new transfer
    }
    wireTransferAutoConvert();

    const saveTemplateCheckbox = root.querySelector(`#${prefix}SaveTemplate`);
    const templateNameRow = root.querySelector(`#${prefix}TemplateNameRow`);
    saveTemplateCheckbox.addEventListener('change', () => {
      templateNameRow.style.display = saveTemplateCheckbox.checked ? '' : 'none';
      if (saveTemplateCheckbox.checked) root.querySelector(`#${prefix}TemplateName`).focus();
    });

    const templateSelect = root.querySelector(`#${prefix}TemplateSelect`);
    if (templateSelect) {
      templateSelect.addEventListener('change', () => {
        const st = Monetra.storage.getState();
        const tmpl = st.transactionTemplates.find((t) => t.id === templateSelect.value);
        const typeSel = root.querySelector(`#${prefix}Type`);
        typeSel.value = tmpl ? tmpl.type : 'expense';
        root.querySelector(`#${prefix}DynamicFields`).innerHTML = fieldsHtml(st, typeSel.value, tmpl || null, prefix);
        wireTransferAutoConvert();
      });
    }

    root.querySelector(`#${prefix}Type`).onchange = (e) => {
      const newType = e.target.value;
      root.querySelector(`#${prefix}DynamicFields`).innerHTML = fieldsHtml(Monetra.storage.getState(), newType, null, prefix);
      wireTransferAutoConvert();
    };

    root.querySelector(`#${prefix}Form`).onsubmit = (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const st = Monetra.storage.getState();
      const txType = fd.get('type');
      const date = fd.get('date');
      let newData;

      if (MOVE_TYPES.includes(txType)) {
        const fromAccountId = fd.get('fromAccountId');
        const toAccountId = fd.get('toAccountId');
        if (!fromAccountId || !toAccountId) { alert('Add the accounts needed for this first — see the message in the form above.'); return; }
        if (fromAccountId === toAccountId) { alert('Choose two different accounts.'); return; }
        const fromAcc = st.accounts.find((a) => a.id === fromAccountId);
        const toAcc = st.accounts.find((a) => a.id === toAccountId);
        const amount = parseFloat(fd.get('amount'));
        const toAmount = parseFloat(fd.get('toAmount'));
        if (isNaN(amount) || amount <= 0 || isNaN(toAmount) || toAmount <= 0) { alert('Enter valid amounts for both accounts.'); return; }
        newData = {
          date, type: txType, fromAccountId, toAccountId, amount, toAmount,
          currency: fromAcc ? fromAcc.currency : st.settings.displayCurrency,
          toCurrency: toAcc ? toAcc.currency : st.settings.displayCurrency,
          note: fd.get('note').trim()
        };
      } else {
        const accountId = fd.get('accountId');
        const account = st.accounts.find((a) => a.id === accountId);
        newData = {
          date, type: txType, accountId,
          category: fd.get('category'),
          amount: parseFloat(fd.get('amount')),
          currency: account ? account.currency : st.settings.displayCurrency,
          method: fd.get('method'),
          note: fd.get('note').trim()
        };
      }

      let tplName = null;
      if (saveTemplateCheckbox.checked) {
        tplName = (root.querySelector(`#${prefix}TemplateName`).value || '').trim();
        if (!tplName) { alert('Enter a name for the template, or uncheck "Save this as a reusable template".'); return; }
      }

      const submitBtn = root.querySelector(`#${prefix}Form button[type="submit"]`);
      if (submitBtn) submitBtn.disabled = true;

      saveTransaction(existing ? existing.id : null, newData)
        .then(() => {
          if (!tplName) return null;
          const tplData = Object.assign({}, newData);
          delete tplData.date;
          tplData.id = Monetra.storage.uid('tpl');
          tplData.name = tplName;
          return Monetra.auth.authFetch('/api/transaction-templates', { method: 'POST', body: JSON.stringify(tplData) });
        })
        .then(() => { opts.onSaved(date); })
        .catch((err) => {
          if (submitBtn) submitBtn.disabled = false;
          alert('Could not save: ' + err.message);
        });
    };
  }

  function openEditModal(id) {
    const state = Monetra.storage.getState();
    const existing = state.transactions.find((t) => t.id === id);
    if (!existing) return;
    const html = `
      <h2>Edit transaction</h2>
      ${formHtml(state, existing, 'tx', { showCancel: true, showTemplatePicker: false, submitLabel: 'Save changes' })}`;
    Monetra.modal.open(html, (root) => {
      wireForm(root, existing, 'tx', {
        onSaved: (date) => {
          Monetra.modal.close();
          currentMonth = date.slice(0, 7);
          Monetra.app.renderAll();
        }
      });
    });
  }

  // computeSpendingOverview/foldCategories are also exported so the
  // Dashboard can render its own copy of the Spending overview panel from
  // the same real transaction data, instead of re-deriving the math
  // separately.
  Monetra.transactions = { render, saveTransaction, removeTransaction, computeSpendingOverview, foldCategories };
})();
