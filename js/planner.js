window.Monetra = window.Monetra || {};

/* Monthly Planner — a small, self-contained dashboard: KPI stat cards
   (expected income/expenses/savings/left-to-spend), a Budget Overview panel,
   a Monthly Cash Flow donut chart broken down by category, always-visible
   inline "build-in" forms for adding income and bills (no modal), a
   Payments & Bills table, an Upcoming Payments panel, and a full cross-month
   payments table at the bottom.

   Like PayLater, this requires being logged in and lives in the database
   (server/server.js, /api/planner/*) rather than the browser — chosen not
   to migrate pre-existing local planner data, so every account starts with
   an empty planner. `state.planner` is kept as a mirror, refreshed from the
   server whenever this tab opens (see the login-gate/sync pattern in
   js/paylater.js and js/accounts.js for why it's structured this way).

   Everything here is planner-only data, kept deliberately separate from the
   real Transactions/Accounts records — income and bills entered here are
   estimates/plans, not actual transactions, and never touch account
   balances or the Dashboard's real totals (though the Dashboard does render
   its own copy of the Cash Flow panel from this same data — see
   computePlannerStats/computeCashFlowSegments, exported below). */
(function () {
  function escape(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function ordinal(n) { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }

  function hexToRgba(hex, alpha) {
    const h = (hex || '#898781').replace('#', '');
    const r = parseInt(h.substring(0, 2), 16), g = parseInt(h.substring(2, 4), 16), b = parseInt(h.substring(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function isLoggedIn() {
    return !!(Monetra.auth && Monetra.auth.isLoggedIn());
  }

  // See js/paylater.js for why this pattern (only re-fetch when the tab
  // opens or the logged-in account changes, never inside the fetch's own
  // success handler) is what keeps this safe from both stale-account leaks
  // and infinite refresh loops.
  let syncedForUserId = null;

  // Bill categories are the same list as the budget categories (Budget
  // Overview uses Monetra.storage.EXPENSE_CATEGORIES too) so that a bill
  // filed under e.g. "Housing" counts toward the Housing budget below.
  const BILL_CATEGORIES = Monetra.storage.EXPENSE_CATEGORIES;

  // Bills used to store the category directly in `name`, with no separate
  // free-text name. New bills carry both `name` (free text, e.g. "Netflix")
  // and `category` (from BILL_CATEGORIES). These helpers fall back cleanly
  // for older bills that only have `name`.
  function billCategory(p) { return p.category || (BILL_CATEGORIES.includes(p.name) ? p.name : BILL_CATEGORIES[0]); }
  function billName(p) { return p.name || billCategory(p); }
  function billCategoryColor(p) {
    const idx = BILL_CATEGORIES.indexOf(billCategory(p));
    return Monetra.palette.categoryColor(idx >= 0 ? idx : 0);
  }

  let currentMonth = Monetra.storage.monthKey();
  let budgetOverviewExpanded = false;
  let cashflowChart = null;

  function shiftMonth(key, delta) {
    const [y, m] = key.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  // Re-fetches everything from the server and re-renders — used after every
  // add/edit/delete so the local mirror never drifts from the database.
  function refresh() {
    syncedForUserId = null;
    Monetra.app.renderAll();
  }

  // Spend for a budget category = planner bills filed under that category
  // this month (a bill's category is shared with the budget category list,
  // so adding a "Rent" payment under "Housing" immediately shows up on the
  // Housing budget row, whether or not it's been marked paid). This is
  // planner-only — it deliberately does not look at real transactions.
  function categorySpend(monthKey, category, targetCurrency) {
    const state = Monetra.storage.getState();
    const monthData = (state.planner.months && state.planner.months[monthKey]) || { payments: [] };
    return (monthData.payments || [])
      .filter((p) => billCategory(p) === category)
      .reduce((sum, p) => sum + Monetra.currency.convert(p.amount, p.currency, targetCurrency), 0);
  }

  function meterColor(pct) {
    if (pct >= 100) return Monetra.palette.critical;
    if (pct >= 80) return Monetra.palette.warning;
    return Monetra.palette.income;
  }

  function pctOfIncome(value, income) { return income > 0 ? (value / income) * 100 : 0; }

  // ---- Icons (inline SVG, currentColor) ----------------------------------
  const ICON_INCOME = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
  const ICON_EXPENSE = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>';
  const ICON_SAVINGS = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v9M9.2 9.3c0-1.3 1.2-2.1 2.8-2.1s2.8.9 2.8 2c0 2.2-5.6 1-5.6 3.2 0 1.1 1.2 2 2.8 2s2.8-.8 2.8-2.1"/></svg>';
  const ICON_TARGET = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r=".6" fill="currentColor"/></svg>';

  function computePlannerStats(state, monthData, monthKey, disp) {
    const income = (monthData.incomes || []).reduce((sum, i) => sum + Monetra.currency.convert(i.amount, i.currency, disp), 0);
    const incomeSources = (monthData.incomes || []).length;
    const expense = (monthData.payments || []).reduce((sum, p) => sum + Monetra.currency.convert(p.amount, p.currency, disp), 0);
    const savings = income - expense;

    let totalPlanned = 0;
    let totalSpentBudgeted = 0;
    (monthData.budgets || []).forEach((b) => {
      totalPlanned += Monetra.currency.convert(b.planned, b.currency, disp);
      totalSpentBudgeted += categorySpend(monthKey, b.category, disp);
    });
    const leftToSpend = totalPlanned - totalSpentBudgeted;

    return { income, expense, incomeSources, savings, leftToSpend };
  }

  function buildKpiHtml(stats, disp) {
    const expensePct = pctOfIncome(stats.expense, stats.income);
    const savingsPct = pctOfIncome(stats.savings, stats.income);
    const leftPct = pctOfIncome(stats.leftToSpend, stats.income);
    const hasIncome = stats.income > 0;
    return `
      <div class="debts-kpis">
        <div class="debt-kpi">
          <div class="debt-kpi-icon kpi-green">${ICON_INCOME}</div>
          <div>
            <div class="debt-kpi-label">Expected Income</div>
            <div class="debt-kpi-value">${Monetra.storage.formatMoney(stats.income, disp)}</div>
            <div class="debt-kpi-sub">${stats.incomeSources} source${stats.incomeSources === 1 ? '' : 's'}</div>
          </div>
        </div>
        <div class="debt-kpi">
          <div class="debt-kpi-icon kpi-red">${ICON_EXPENSE}</div>
          <div>
            <div class="debt-kpi-label">Expected Expenses</div>
            <div class="debt-kpi-value">${Monetra.storage.formatMoney(stats.expense, disp)}</div>
            <div class="debt-kpi-sub">${hasIncome ? expensePct.toFixed(0) + '% of income' : 'From planned payments'}</div>
          </div>
        </div>
        <div class="debt-kpi">
          <div class="debt-kpi-icon kpi-violet">${ICON_SAVINGS}</div>
          <div>
            <div class="debt-kpi-label">Expected Savings</div>
            <div class="debt-kpi-value">${Monetra.storage.formatMoney(stats.savings, disp)}</div>
            <div class="debt-kpi-sub">${hasIncome ? savingsPct.toFixed(0) + '% of income' : 'No income logged'}</div>
          </div>
        </div>
        <div class="debt-kpi">
          <div class="debt-kpi-icon kpi-orange">${ICON_TARGET}</div>
          <div>
            <div class="debt-kpi-label">Left to Spend</div>
            <div class="debt-kpi-value">${Monetra.storage.formatMoney(stats.leftToSpend, disp)}</div>
            <div class="debt-kpi-sub">${hasIncome ? leftPct.toFixed(0) + '% of income' : 'Based on budgets'}</div>
          </div>
        </div>
      </div>`;
  }

  function budgetStatus(pct) {
    if (pct >= 100) return { cls: 'pill-overdue', label: 'Over Budget' };
    if (pct >= 80) return { cls: 'pill-unpaid', label: 'Near Limit' };
    return { cls: 'pill-paid', label: 'On Track' };
  }

  function buildBudgetOverviewHtml(monthData, monthKey) {
    const budgets = monthData.budgets || [];
    const visible = budgetOverviewExpanded ? budgets : budgets.slice(0, 5);

    const rows = visible.map((b) => {
      const spent = categorySpend(monthKey, b.category, b.currency);
      const pct = b.planned > 0 ? Math.min(999, (spent / b.planned) * 100) : 0;
      const barColor = meterColor(pct);
      const status = budgetStatus(pct);
      const idx = Monetra.storage.EXPENSE_CATEGORIES.indexOf(b.category);
      const iconColor = Monetra.palette.categoryColor(idx >= 0 ? idx : 0);
      const initial = (b.category || '?').charAt(0).toUpperCase();
      return `
        <div class="budget-row" data-id="${b.id}">
          <div class="budget-icon" style="background:${hexToRgba(iconColor, .14)}; color:${iconColor};">${initial}</div>
          <div class="budget-name">${escape(b.category)}</div>
          <div>
            <div class="meter"><div class="meter-fill" style="width:${Math.min(100, pct)}%; background:${barColor};"></div></div>
            <div class="budget-amounts">${Monetra.storage.formatMoney(spent, b.currency)} of ${Monetra.storage.formatMoney(b.planned, b.currency)}</div>
          </div>
          <div class="budget-pct">${pct.toFixed(0)}%</div>
          <span class="pill ${status.cls}">${status.label}</span>
          <div class="row-menu-wrap">
            <button type="button" class="row-menu-btn" data-action="menu">⋮</button>
            <div class="row-menu-dropdown">
              <button type="button" data-action="editBudget">Edit</button>
              <button type="button" data-action="deleteBudget">Delete</button>
            </div>
          </div>
        </div>`;
    }).join('');

    const showToggle = budgets.length > 5;

    return `
      <div class="card">
        <div class="panel-title-row">
          <div class="panel-title">Budget Overview</div>
          <button type="button" class="btn btn-primary btn-sm" id="addBudgetBtn">+ Add budget</button>
        </div>
        <div id="budgetOverviewRows">${rows || `<div class="empty-state" style="padding:20px 0;">No budgets set for this month yet.</div>`}</div>
        ${showToggle ? `<a href="#" class="panel-link" id="toggleBudgetsLink" style="display:block; margin-top:10px;">${budgetOverviewExpanded ? 'Show less' : 'View all budgets →'}</a>` : ''}
      </div>`;
  }

  // One segment per bill category in use this month (fixed categorical
  // color, same order/assignment as Budget Overview and the bill category
  // pills — a category is always the same color everywhere), folded to the
  // top 5 + "Other" if there are more, plus a Savings segment when there's
  // income left over. Segment values always sum to Expected Income when
  // there's income to show (categories + Savings = Income, no fabricated
  // math); with no income logged yet, they just sum to Expected Expenses.
  function computeCashFlowSegments(monthData, stats, disp) {
    const byCategory = {};
    (monthData.payments || []).forEach((p) => {
      const cat = billCategory(p);
      byCategory[cat] = (byCategory[cat] || 0) + Monetra.currency.convert(p.amount, p.currency, disp);
    });
    let entries = Object.entries(byCategory)
      .map(([label, value]) => ({ label, value, color: Monetra.palette.categoryColor(Math.max(0, BILL_CATEGORIES.indexOf(label))) }))
      .filter((e) => e.value > 0)
      .sort((a, b) => b.value - a.value);

    const MAX = 5;
    let segments = entries;
    if (entries.length > MAX) {
      const top = entries.slice(0, MAX);
      const otherTotal = entries.slice(MAX).reduce((s, e) => s + e.value, 0);
      segments = top.concat([{ label: 'Other', value: otherTotal, color: Monetra.palette.muted }]);
    }

    if (stats.income > 0 && stats.savings > 0) {
      segments = segments.concat([{ label: 'Savings', value: stats.savings, color: Monetra.palette.good }]);
    }
    return segments;
  }

  function buildCashFlowHtml(stats, segments, disp) {
    if (!segments.length) {
      return `
        <div class="card">
          <div class="panel-title">Monthly Cash Flow</div>
          <div class="empty-state" style="padding:30px 0;">Add expected income and payments to see your cash flow breakdown.</div>
        </div>`;
    }
    const overspend = stats.income > 0 && stats.expense > stats.income;
    const pctBase = stats.income > 0 ? stats.income : stats.expense;
    const centerValue = stats.income > 0 ? stats.income : stats.expense;
    const centerLabel = stats.income > 0 ? 'Expected Income' : 'Expected Expenses';

    const legendRows = segments.map((s) => `
      <div class="cashflow-legend-row"><span class="cashflow-legend-label"><span class="cashflow-dot" style="background:${s.color};"></span>${escape(s.label)}</span><span>${Monetra.storage.formatMoney(s.value, disp)} (${pctOfIncome(s.value, pctBase).toFixed(0)}%)</span></div>`).join('');

    let insightHtml;
    if (stats.income > 0) {
      const expensePct = pctOfIncome(stats.expense, stats.income);
      const savingsPct = pctOfIncome(stats.savings, stats.income);
      insightHtml = `<div class="insight-banner ${overspend ? 'negative' : ''}">${overspend
        ? `You are expecting to spend ${(expensePct - 100).toFixed(0)}% more than your expected income this month.`
        : `You are expecting to save ${savingsPct.toFixed(0)}% of your expected income this month.`}</div>`;
    } else {
      insightHtml = `<div class="insight-banner">Add expected income above to see your expected savings.</div>`;
    }

    return `
      <div class="card">
        <div class="panel-title">Monthly Cash Flow</div>
        <div class="chart-wrap" style="height:190px;">
          <canvas id="cashflowChartCanvas"></canvas>
          <div class="donut-center-label">
            <div class="donut-center-value">${Monetra.storage.formatMoney(centerValue, disp)}</div>
            <div class="donut-center-sub">${centerLabel}</div>
          </div>
        </div>
        <div class="cashflow-legend">${legendRows}</div>
        ${insightHtml}
      </div>`;
  }

  function renderCashflowChart(segments, disp) {
    const ctx = document.getElementById('cashflowChartCanvas');
    if (!ctx || typeof Chart === 'undefined' || !segments.length) return;
    if (cashflowChart) cashflowChart.destroy();
    cashflowChart = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: segments.map((s) => s.label),
        datasets: [{ data: segments.map((s) => s.value), backgroundColor: segments.map((s) => s.color), borderColor: '#fcfcfb', borderWidth: 2 }]
      },
      options: {
        cutout: '70%',
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (c) => `${c.label}: ${Monetra.storage.formatMoney(c.parsed, disp)}` } }
        }
      }
    });
  }

  // Expected Income is planner-only, just like bills: entries here are
  // plans/estimates (e.g. "Salary — ₹80,000"), not real transactions, and
  // never touch account balances or the Transactions tab.
  function buildIncomeSectionHtml(monthData, monthKey, disp) {
    const formHtml = `
      <div class="card" style="margin-bottom:14px;">
        <div class="form-grid-2">
          <div class="form-row"><label>Source</label><input type="text" id="incomeName" placeholder="e.g. Salary, Freelance client"></div>
          <div class="form-row"><label>Category</label>
            <select id="incomeCategory">${Monetra.storage.INCOME_CATEGORIES.map((c) => `<option value="${c}">${c}</option>`).join('')}</select>
          </div>
        </div>
        <div class="form-grid-2">
          <div class="form-row"><label>Month</label><input type="month" id="incomeMonth" value="${monthKey}"></div>
          <div class="form-row"><label>Amount</label><input type="number" step="0.01" id="incomeAmount" placeholder="Amount"></div>
        </div>
        <div class="form-row"><label>Currency</label>
          <select id="incomeCurrency">${Monetra.storage.CURRENCIES.map((c) => `<option value="${c}" ${c === disp ? 'selected' : ''}>${c}</option>`).join('')}</select>
        </div>
        <button type="button" class="btn btn-primary btn-sm" id="addIncomeBtn">+ Add income</button>
      </div>`;

    const rowsHtml = (monthData.incomes || []).map((inc) => `
      <tr data-id="${inc.id}">
        <td>${escape(inc.name || inc.category)}</td>
        <td>${escape(inc.category)}</td>
        <td>${Monetra.storage.formatMoney(inc.amount, inc.currency)}</td>
        <td>
          <button class="btn btn-ghost btn-sm" data-action="editIncome">Edit</button>
          <button class="btn btn-danger btn-sm" data-action="deleteIncome">Delete</button>
        </td>
      </tr>`).join('');

    return `
      <div class="section-header" style="margin-top:26px;"><h2 style="font-size:14px;">Income sources</h2></div>
      ${formHtml}
      <div class="card">
        <div class="panel-title">Income this month</div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Source</th><th>Category</th><th>Amount</th><th></th></tr></thead>
            <tbody>${rowsHtml || `<tr><td colspan="4" class="empty-state">No income planned for ${monthKey} yet.</td></tr>`}</tbody>
          </table>
        </div>
      </div>`;
  }

  function paymentRowHtml(p, isCurrentCycle, todayDate) {
    const cat = billCategory(p);
    const color = billCategoryColor(p);
    const name = billName(p);
    const overdue = isCurrentCycle && !p.paid && p.dueDay && todayDate > p.dueDay;
    const statusPill = p.paid ? '<span class="pill pill-paid">Paid</span>' : overdue ? '<span class="pill pill-overdue">Overdue</span>' : '<span class="pill pill-unpaid">Due ' + ordinal(p.dueDay) + '</span>';
    return `<tr data-id="${p.id}">
      <td>
        <div style="display:flex; align-items:center; gap:10px;">
          <div class="budget-icon" style="width:28px; height:28px; font-size:12px; background:${hexToRgba(color, .14)}; color:${color};">${escape(name).charAt(0).toUpperCase()}</div>
          <span>${escape(name)}</span>
        </div>
      </td>
      <td><span class="cat-pill" style="background:${hexToRgba(color, .14)}; color:${color};">${escape(cat)}</span></td>
      <td>${Monetra.storage.formatMoney(p.amount, p.currency)}</td>
      <td>${ordinal(p.dueDay)}</td>
      <td>${statusPill}</td>
      <td><label class="checkbox-row"><input type="checkbox" data-action="togglePaid" ${p.paid ? 'checked' : ''}></label></td>
      <td>
        <button class="btn btn-ghost btn-sm" data-action="editPayment">Edit</button>
        <button class="btn btn-danger btn-sm" data-action="deletePayment">Delete</button>
      </td>
    </tr>`;
  }

  function buildUpcomingPaymentsHtml(monthData, monthKey, isCurrentCycle, todayDate) {
    const unpaid = (monthData.payments || []).filter((p) => !p.paid).slice().sort((a, b) => (a.dueDay || 0) - (b.dueDay || 0)).slice(0, 6);
    const monthAbbr = new Date(monthKey + '-01T00:00:00').toLocaleString('en-US', { month: 'short' });

    const rows = unpaid.map((p) => {
      const cat = billCategory(p);
      const color = billCategoryColor(p);
      const daysAway = isCurrentCycle ? p.dueDay - todayDate : null;
      let dueLabel;
      if (!isCurrentCycle) dueLabel = `Day ${p.dueDay}`;
      else if (daysAway < 0) dueLabel = 'Overdue';
      else if (daysAway === 0) dueLabel = 'Due today';
      else dueLabel = `Due in ${daysAway} day${daysAway === 1 ? '' : 's'}`;
      return `
        <div class="date-badge-row">
          <div class="date-badge" style="background:${color};">
            <div class="date-badge-month">${monthAbbr}</div>
            <div class="date-badge-day">${p.dueDay}</div>
          </div>
          <div class="date-badge-info">
            <div class="date-badge-name">${escape(billName(p))}</div>
            <div class="date-badge-cat">${escape(cat)}</div>
          </div>
          <div style="text-align:right; flex-shrink:0;">
            <div class="date-badge-amount">${Monetra.storage.formatMoney(p.amount, p.currency)}</div>
            <div class="date-badge-due">${dueLabel}</div>
          </div>
        </div>`;
    }).join('');

    return `
      <div class="card">
        <div class="panel-title-row">
          <div class="panel-title">Upcoming Payments</div>
          <a href="#plannerFullTable" class="panel-link" id="viewFullPlannerScheduleLink">View full schedule →</a>
        </div>
        ${unpaid.length ? rows : `<div class="empty-state" style="padding:20px 0;">No upcoming payments.</div>`}
      </div>`;
  }

  function buildAllPaymentsTableHtml(state) {
    const months = Object.keys(state.planner.months || {}).sort();
    const rows = [];
    months.forEach((mk) => {
      (state.planner.months[mk].payments || []).forEach((p) => rows.push({ mk, p }));
    });
    if (!rows.length) {
      return `<div class="debt-table" style="max-width:none;"><div class="panel-title">All payments</div><div class="empty-state" style="padding:24px 10px;">No payments added yet.</div></div>`;
    }
    rows.sort((a, b) => (a.mk === b.mk ? (a.p.dueDay || 0) - (b.p.dueDay || 0) : (a.mk < b.mk ? -1 : 1)));

    const bodyRows = rows.map(({ mk, p }) => {
      const cat = billCategory(p);
      const color = billCategoryColor(p);
      const label = new Date(mk + '-01T00:00:00').toLocaleString('en-US', { month: 'short', year: 'numeric' }) + ' · ' + ordinal(p.dueDay);
      return `<tr class="${p.paid ? 'paid' : ''}">
        <td>${label}</td>
        <td>${escape(billName(p))}</td>
        <td><span class="cat-pill" style="background:${hexToRgba(color, .14)}; color:${color};">${escape(cat)}</span></td>
        <td>${Monetra.storage.formatMoney(p.amount, p.currency)}</td>
        <td>${p.paid ? 'Paid' : 'Due'}</td>
      </tr>`;
    }).join('');

    return `
      <div class="debt-table" style="max-width:none;">
        <div class="panel-title">All payments</div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Month · Day</th><th>Payment</th><th>Category</th><th>Amount</th><th>Status</th></tr></thead>
            <tbody>${bodyRows}</tbody>
          </table>
        </div>
      </div>`;
  }

  // Close any open row menu when clicking elsewhere on the page. Registered
  // once at module load (not inside render) so it never stacks up.
  document.addEventListener('click', (e) => {
    if (e.target.closest('.row-menu-wrap')) return;
    document.querySelectorAll('.row-menu-dropdown.open').forEach((el) => el.classList.remove('open'));
  });

  function render() {
    const el = document.getElementById('tab-planner');
    if (!el) return;

    if (!isLoggedIn()) {
      syncedForUserId = null;
      el.innerHTML = `
        <div class="section-header"><h2>Monthly planner</h2></div>
        <div class="card" style="max-width:520px;">
          <h3 style="margin-top:0;">Log in to use the Monthly Planner</h3>
          <p class="hint" style="margin-top:0;">Budgets, planned bills, and planned income are saved to your Monetra account, not this browser — so you'll need to be logged in to add or view them.</p>
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
      // account's planner data, cached from before that account logged out
      // (the same class of bug already fixed once for the Settings API
      // keys). Show a loading state and only draw real data once the server
      // has answered for whoever is actually logged in right now.
      el.innerHTML = `<div class="section-header"><h2>Monthly planner</h2></div><div class="hint">Loading your planner…</div>`;
      Monetra.auth.authFetch('/api/planner', { method: 'GET' })
        .then((result) => {
          const state = Monetra.storage.getState();
          state.planner = { months: result.months || {} };
          Monetra.storage.save();
          syncedForUserId = userId;
          Monetra.app.renderAll();
        })
        .catch((err) => {
          el.innerHTML = `<div class="section-header"><h2>Monthly planner</h2></div><div class="hint" style="color:var(--critical);">Could not load your planner: ${escape(err.message)}</div>`;
        });
      return;
    }

    renderList(el);
  }

  function renderList(el) {
    const state = Monetra.storage.getState();
    const disp = state.settings.displayCurrency;
    const monthData = Monetra.storage.ensureMonth(currentMonth);
    const todayDate = new Date().getDate();
    const isCurrentCycle = currentMonth === Monetra.storage.monthKey();

    const stats = computePlannerStats(state, monthData, currentMonth, disp);
    const kpiHtml = buildKpiHtml(stats, disp);
    const budgetOverviewHtml = buildBudgetOverviewHtml(monthData, currentMonth);
    const cashFlowSegments = computeCashFlowSegments(monthData, stats, disp);
    const cashFlowHtml = buildCashFlowHtml(stats, cashFlowSegments, disp);

    const billFormHtml = `
      <div class="card" style="margin-bottom:14px;">
        <div class="form-grid-2">
          <div class="form-row"><label>Payment name</label><input type="text" id="billName" placeholder="e.g. Netflix, Rent - Apartment"></div>
          <div class="form-row"><label>Category</label>
            <select id="billCategory">${BILL_CATEGORIES.map((c) => `<option value="${c}">${c}</option>`).join('')}</select>
          </div>
        </div>
        <div class="form-grid-2">
          <div class="form-row"><label>Month</label><input type="month" id="billMonth" value="${currentMonth}"></div>
          <div class="form-row"><label>Amount</label><input type="number" step="0.01" id="billAmount" placeholder="Amount"></div>
        </div>
        <div class="form-grid-2">
          <div class="form-row"><label>Currency</label>
            <select id="billCurrency">${Monetra.storage.CURRENCIES.map((c) => `<option value="${c}" ${c === state.settings.displayCurrency ? 'selected' : ''}>${c}</option>`).join('')}</select>
          </div>
          <div class="form-row"><label>Due day (1–31)</label><input type="number" min="1" max="31" id="billDueDay" placeholder="e.g. 5"></div>
        </div>
        <button type="button" class="btn btn-primary btn-sm" id="addBillBtn">+ Add payment</button>
      </div>`;

    const paymentRowsHtml = (monthData.payments || []).map((p) => paymentRowHtml(p, isCurrentCycle, todayDate)).join('');
    const upcomingHtml = buildUpcomingPaymentsHtml(monthData, currentMonth, isCurrentCycle, todayDate);
    const allTableHtml = buildAllPaymentsTableHtml(state);
    const incomeSectionHtml = buildIncomeSectionHtml(monthData, currentMonth, disp);

    el.innerHTML = `
      <div class="section-header">
        <div>
          <h2>Monthly planner</h2>
          <p class="section-subtitle">Plan your income, manage expenses and track payments for the month.</p>
        </div>
        <div class="month-picker">
          <button class="btn btn-ghost btn-sm" id="plannerPrevMonthBtn">‹</button>
          <input type="month" id="plannerMonthInput" value="${currentMonth}">
          <button class="btn btn-ghost btn-sm" id="plannerNextMonthBtn">›</button>
        </div>
      </div>

      <div class="hint" style="margin:-6px 0 14px;">Saved to your Monetra account — only you can see this, even from a different browser.</div>

      ${kpiHtml}

      ${incomeSectionHtml}

      <div class="planner-row">
        <div class="planner-col-wide">${budgetOverviewHtml}</div>
        <div class="planner-col-narrow">${cashFlowHtml}</div>
      </div>

      <div class="section-header" style="margin-top:26px;"><h2 style="font-size:14px;">Monthly payments &amp; bills</h2></div>
      ${billFormHtml}
      <div class="card">
        <div class="panel-title-row">
          <div class="panel-title">Payments this month</div>
          <a href="#plannerFullTable" class="panel-link" id="viewAllPlannerPaymentsLink">View all payments →</a>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Payment</th><th>Category</th><th>Amount</th><th>Due day</th><th>Status</th><th>Mark paid</th><th></th></tr></thead>
            <tbody>${paymentRowsHtml || '<tr><td colspan="7" class="empty-state">No recurring payments planned for this month.</td></tr>'}</tbody>
          </table>
        </div>
      </div>

      <div class="planner-row" style="margin-top:20px;">
        <div class="planner-col-wide">${upcomingHtml}</div>
      </div>

      <div id="plannerFullTable" style="margin-top:24px;">${allTableHtml}</div>
    `;

    renderCashflowChart(cashFlowSegments, disp);

    document.getElementById('plannerMonthInput').onchange = (e) => { currentMonth = e.target.value || Monetra.storage.monthKey(); render(); };
    document.getElementById('plannerPrevMonthBtn').onclick = () => { currentMonth = shiftMonth(currentMonth, -1); render(); };
    document.getElementById('plannerNextMonthBtn').onclick = () => { currentMonth = shiftMonth(currentMonth, 1); render(); };
    document.getElementById('addBudgetBtn').onclick = () => openBudgetForm();

    const toggleLink = document.getElementById('toggleBudgetsLink');
    if (toggleLink) toggleLink.addEventListener('click', (e) => { e.preventDefault(); budgetOverviewExpanded = !budgetOverviewExpanded; render(); });

    ['viewFullPlannerScheduleLink', 'viewAllPlannerPaymentsLink'].forEach((linkId) => {
      const link = document.getElementById(linkId);
      if (link) link.addEventListener('click', (e) => {
        e.preventDefault();
        const target = document.getElementById('plannerFullTable');
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });

    document.getElementById('addIncomeBtn').onclick = () => {
      const name = document.getElementById('incomeName').value.trim();
      const category = document.getElementById('incomeCategory').value;
      const incomeMonth = document.getElementById('incomeMonth').value || currentMonth;
      const amount = parseFloat(document.getElementById('incomeAmount').value);
      const currency = document.getElementById('incomeCurrency').value;
      if (!name) { alert('Enter an income source.'); return; }
      if (isNaN(amount) || amount <= 0) { alert('Enter a valid amount.'); return; }
      const btn = document.getElementById('addIncomeBtn');
      btn.disabled = true;
      Monetra.auth.authFetch('/api/planner/incomes', { method: 'POST', body: JSON.stringify({ monthKey: incomeMonth, name, category, amount, currency }) })
        .then(() => { currentMonth = incomeMonth; refresh(); })
        .catch((err) => { btn.disabled = false; alert('Could not add income: ' + err.message); });
    };

    // Income table row actions.
    el.querySelectorAll('[data-action="editIncome"], [data-action="deleteIncome"]').forEach((btn) => {
      const row = btn.closest('tr[data-id]');
      const id = row.dataset.id;
      if (btn.dataset.action === 'editIncome') btn.onclick = () => openIncomeForm(id);
      else btn.onclick = () => {
        if (!confirm('Delete this income entry?')) return;
        Monetra.auth.authFetch('/api/planner/incomes/' + id, { method: 'DELETE' })
          .then(() => refresh())
          .catch((err) => alert('Could not delete: ' + err.message));
      };
    });

    document.getElementById('addBillBtn').onclick = () => {
      const name = document.getElementById('billName').value.trim();
      const category = document.getElementById('billCategory').value;
      const billMonth = document.getElementById('billMonth').value || currentMonth;
      const amount = parseFloat(document.getElementById('billAmount').value);
      const currency = document.getElementById('billCurrency').value;
      const dueDay = parseInt(document.getElementById('billDueDay').value, 10);
      if (!name) { alert('Enter a payment name.'); return; }
      if (isNaN(amount) || amount <= 0) { alert('Enter a valid amount.'); return; }
      if (isNaN(dueDay) || dueDay < 1 || dueDay > 31) { alert('Enter a due day between 1 and 31.'); return; }
      const btn = document.getElementById('addBillBtn');
      btn.disabled = true;
      Monetra.auth.authFetch('/api/planner/payments', { method: 'POST', body: JSON.stringify({ monthKey: billMonth, name, category, amount, currency, dueDay, paid: false }) })
        .then(() => { currentMonth = billMonth; refresh(); })
        .catch((err) => { btn.disabled = false; alert('Could not add payment: ' + err.message); });
    };

    // Budget Overview row menus (edit / delete).
    el.querySelectorAll('.budget-row').forEach((row) => {
      const id = row.dataset.id;
      const dropdown = row.querySelector('.row-menu-dropdown');
      row.querySelector('[data-action="menu"]').addEventListener('click', (e) => {
        e.stopPropagation();
        const wasOpen = dropdown.classList.contains('open');
        document.querySelectorAll('.row-menu-dropdown.open').forEach((d) => d.classList.remove('open'));
        if (!wasOpen) dropdown.classList.add('open');
      });
      row.querySelector('[data-action="editBudget"]').addEventListener('click', (e) => {
        e.stopPropagation();
        dropdown.classList.remove('open');
        openBudgetForm(id);
      });
      row.querySelector('[data-action="deleteBudget"]').addEventListener('click', (e) => {
        e.stopPropagation();
        dropdown.classList.remove('open');
        if (!confirm('Delete this budget?')) return;
        Monetra.auth.authFetch('/api/planner/budgets/' + id, { method: 'DELETE' })
          .then(() => refresh())
          .catch((err) => alert('Could not delete: ' + err.message));
      });
    });

    // Payments & bills table row actions.
    el.querySelectorAll('tr[data-id]').forEach((row) => {
      const id = row.dataset.id;
      const editPayment = row.querySelector('[data-action="editPayment"]');
      const deletePayment = row.querySelector('[data-action="deletePayment"]');
      const toggle = row.querySelector('[data-action="togglePaid"]');
      if (editPayment) editPayment.onclick = () => openPaymentForm(id);
      if (deletePayment) deletePayment.onclick = () => {
        if (!confirm('Delete this payment?')) return;
        Monetra.auth.authFetch('/api/planner/payments/' + id, { method: 'DELETE' })
          .then(() => refresh())
          .catch((err) => alert('Could not delete: ' + err.message));
      };
      if (toggle) toggle.onchange = (e) => {
        const p = monthData.payments.find((x) => x.id === id);
        const checked = e.target.checked;
        e.target.disabled = true;
        Monetra.auth.authFetch('/api/planner/payments/' + id, {
          method: 'PUT',
          body: JSON.stringify({ monthKey: currentMonth, name: billName(p), category: billCategory(p), amount: p.amount, currency: p.currency, dueDay: p.dueDay, paid: checked })
        })
          .then(() => refresh())
          .catch((err) => { e.target.disabled = false; e.target.checked = !checked; alert('Could not update: ' + err.message); });
      };
    });
  }

  function openBudgetForm(id) {
    const state = Monetra.storage.getState();
    const monthData = Monetra.storage.ensureMonth(currentMonth);
    const existing = id ? monthData.budgets.find((b) => b.id === id) : null;
    const html = `
      <h2>${existing ? 'Edit budget' : 'Add budget'} · ${currentMonth}</h2>
      <form id="budgetForm">
        <div class="form-row"><label>Category</label>
          <select name="category">${Monetra.storage.EXPENSE_CATEGORIES.map((c) => `<option value="${c}" ${existing && existing.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select>
        </div>
        <div class="form-grid-2">
          <div class="form-row"><label>Planned amount</label><input name="planned" type="number" step="0.01" required value="${existing ? existing.planned : ''}"></div>
          <div class="form-row"><label>Currency</label>
            <select name="currency">${Monetra.storage.CURRENCIES.map((c) => `<option value="${c}" ${(existing ? existing.currency : state.settings.displayCurrency) === c ? 'selected' : ''}>${c}</option>`).join('')}</select>
          </div>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" id="cancelBtn">Cancel</button>
          <button type="submit" class="btn btn-primary">${existing ? 'Save changes' : 'Add budget'}</button>
        </div>
      </form>`;
    Monetra.modal.open(html, (root) => {
      root.querySelector('#cancelBtn').onclick = () => Monetra.modal.close();
      root.querySelector('#budgetForm').onsubmit = (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const data = { monthKey: currentMonth, category: fd.get('category'), planned: parseFloat(fd.get('planned')), currency: fd.get('currency') };
        const submitBtn = root.querySelector('button[type="submit"]');
        submitBtn.disabled = true;
        const req = existing
          ? Monetra.auth.authFetch('/api/planner/budgets/' + existing.id, { method: 'PUT', body: JSON.stringify(data) })
          : Monetra.auth.authFetch('/api/planner/budgets', { method: 'POST', body: JSON.stringify(data) });
        req.then(() => { Monetra.modal.close(); refresh(); })
          .catch((err) => { submitBtn.disabled = false; alert('Could not save: ' + err.message); });
      };
    });
  }

  // Editing an existing bill only — new bills are added inline via the
  // always-visible "Monthly payments & bills" form (see addBillBtn above).
  function openPaymentForm(id) {
    const monthData = Monetra.storage.ensureMonth(currentMonth);
    const existing = monthData.payments.find((p) => p.id === id);
    if (!existing) return;
    const html = `
      <h2>Edit payment</h2>
      <form id="paymentForm">
        <div class="form-grid-2">
          <div class="form-row"><label>Payment name</label><input name="name" required value="${escape(billName(existing))}"></div>
          <div class="form-row"><label>Category</label>
            <select name="category">${BILL_CATEGORIES.map((c) => `<option value="${c}" ${billCategory(existing) === c ? 'selected' : ''}>${c}</option>`).join('')}</select>
          </div>
        </div>
        <div class="form-grid-2">
          <div class="form-row"><label>Month</label><input name="month" type="month" required value="${currentMonth}"></div>
          <div class="form-row"><label>Amount</label><input name="amount" type="number" step="0.01" required value="${existing.amount}"></div>
        </div>
        <div class="form-grid-2">
          <div class="form-row"><label>Currency</label>
            <select name="currency">${Monetra.storage.CURRENCIES.map((c) => `<option value="${c}" ${existing.currency === c ? 'selected' : ''}>${c}</option>`).join('')}</select>
          </div>
          <div class="form-row"><label>Due day (1–31)</label><input name="dueDay" type="number" min="1" max="31" required value="${existing.dueDay}"></div>
        </div>
        <div class="form-row">
          <label class="checkbox-row"><input type="checkbox" name="paid" ${existing.paid ? 'checked' : ''}> Already paid</label>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" id="cancelBtn">Cancel</button>
          <button type="submit" class="btn btn-primary">Save changes</button>
        </div>
      </form>`;
    Monetra.modal.open(html, (root) => {
      root.querySelector('#cancelBtn').onclick = () => Monetra.modal.close();
      root.querySelector('#paymentForm').onsubmit = (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const newMonth = fd.get('month') || currentMonth;
        const data = {
          monthKey: newMonth,
          name: fd.get('name').trim(),
          category: fd.get('category'),
          amount: parseFloat(fd.get('amount')),
          currency: fd.get('currency'),
          dueDay: parseInt(fd.get('dueDay'), 10),
          paid: fd.get('paid') === 'on'
        };
        const submitBtn = root.querySelector('button[type="submit"]');
        submitBtn.disabled = true;
        Monetra.auth.authFetch('/api/planner/payments/' + id, { method: 'PUT', body: JSON.stringify(data) })
          .then(() => { currentMonth = newMonth; Monetra.modal.close(); refresh(); })
          .catch((err) => { submitBtn.disabled = false; alert('Could not save: ' + err.message); });
      };
    });
  }

  // Editing an existing planned income entry only — new ones are added
  // inline via the always-visible "Income sources" form (see addIncomeBtn
  // above).
  function openIncomeForm(id) {
    const monthData = Monetra.storage.ensureMonth(currentMonth);
    const existing = (monthData.incomes || []).find((i) => i.id === id);
    if (!existing) return;
    const html = `
      <h2>Edit income</h2>
      <form id="incomeForm">
        <div class="form-grid-2">
          <div class="form-row"><label>Source</label><input name="name" required value="${escape(existing.name || '')}"></div>
          <div class="form-row"><label>Category</label>
            <select name="category">${Monetra.storage.INCOME_CATEGORIES.map((c) => `<option value="${c}" ${existing.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select>
          </div>
        </div>
        <div class="form-grid-2">
          <div class="form-row"><label>Month</label><input name="month" type="month" required value="${currentMonth}"></div>
          <div class="form-row"><label>Amount</label><input name="amount" type="number" step="0.01" required value="${existing.amount}"></div>
        </div>
        <div class="form-row"><label>Currency</label>
          <select name="currency">${Monetra.storage.CURRENCIES.map((c) => `<option value="${c}" ${existing.currency === c ? 'selected' : ''}>${c}</option>`).join('')}</select>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" id="cancelBtn">Cancel</button>
          <button type="submit" class="btn btn-primary">Save changes</button>
        </div>
      </form>`;
    Monetra.modal.open(html, (root) => {
      root.querySelector('#cancelBtn').onclick = () => Monetra.modal.close();
      root.querySelector('#incomeForm').onsubmit = (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const newMonth = fd.get('month') || currentMonth;
        const data = {
          monthKey: newMonth,
          name: fd.get('name').trim(),
          category: fd.get('category'),
          amount: parseFloat(fd.get('amount')),
          currency: fd.get('currency')
        };
        const submitBtn = root.querySelector('button[type="submit"]');
        submitBtn.disabled = true;
        Monetra.auth.authFetch('/api/planner/incomes/' + id, { method: 'PUT', body: JSON.stringify(data) })
          .then(() => { currentMonth = newMonth; Monetra.modal.close(); refresh(); })
          .catch((err) => { submitBtn.disabled = false; alert('Could not save: ' + err.message); });
      };
    });
  }

  // computePlannerStats/computeCashFlowSegments are also exported so the
  // Dashboard can render its own copy of the Monthly Cash Flow panel from
  // the same planner data, instead of re-deriving the math separately.
  Monetra.planner = { render, computePlannerStats, computeCashFlowSegments };
})();
