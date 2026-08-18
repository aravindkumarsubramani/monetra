window.Monetra = window.Monetra || {};

(function () {
  let assetsChart = null;
  let debtChart = null;
  let trendChart = null;
  let spendChart = null;
  let cashflowChart = null;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  const CURRENCY_ACCENT = { INR: 'var(--s4-yellow)', EUR: 'var(--s1-blue)', USD: 'var(--s6-green)' };

  function foldToTop(entries, max) {
    const sorted = entries.slice().sort((a, b) => b.value - a.value);
    if (sorted.length <= max) return sorted;
    const top = sorted.slice(0, max - 1);
    const rest = sorted.slice(max - 1);
    const otherTotal = rest.reduce((s, e) => s + e.value, 0);
    top.push({ label: 'Other', value: otherTotal });
    return top;
  }

  function render() {
    const el = document.getElementById('tab-dashboard');
    const state = Monetra.storage.getState();
    const disp = state.settings.displayCurrency;
    const nw = Monetra.calc.netWorth(disp);
    // One bar per debt showing its original total loan amount (not what's
    // still left to pay — that's the "Total debts" KPI above, and matches
    // the Debts tab's own currentDebt figure). PayLater providers are left
    // out here since they're a running balance with no fixed "total" to
    // show, unlike an actual loan.
    const debtTotalBreakdown = state.debts.map((d) => ({
      id: d.id, label: d.name, value: Monetra.currency.convert(d.totalDebt, d.currency, disp)
    }));
    const thisMonth = Monetra.storage.monthKey();
    const summary = Monetra.calc.monthSummary(thisMonth, disp);
    const trend = Monetra.calc.lastNMonthsTrend(12, disp);
    const missing = Monetra.calc.unconvertedCurrencies(disp);

    // Real copies of the headline chart from each of Transactions/Planner/
    // Investments, always for the real current month regardless of which
    // month those tabs happen to be scrolled to. Each panel reuses that
    // page's own computation function so the numbers can never drift from
    // what the source page shows.
    const overviewMonth = thisMonth;
    const spendOverview = Monetra.transactions.computeSpendingOverview(overviewMonth, disp);
    const spendSegments = Monetra.transactions.foldCategories(spendOverview.byCategory, 6);

    const plannerMonthData = Monetra.storage.ensureMonth(overviewMonth);
    const plannerStats = Monetra.planner.computePlannerStats(state, plannerMonthData, overviewMonth, disp);
    const cashFlowSegments = Monetra.planner.computeCashFlowSegments(plannerMonthData, plannerStats, disp);
    const cashFlowCenterValue = plannerStats.income > 0 ? plannerStats.income : plannerStats.expense;
    const cashFlowCenterLabel = plannerStats.income > 0 ? 'Expected income' : 'Expected expenses';

    const invRows = Monetra.investments.computeRows(state, disp);
    // Current value only, so every holding counts here — not just the ones
    // with a recorded buy price (that restriction only mattered for
    // comparing against an Invested bar, which this panel no longer shows).
    const invValueRowCount = invRows.filter((r) => r.valueDisp > 0).length;

    const warningBanner = missing.length ? `
      <div class="card" style="border-color: rgba(208,59,59,.35); background: rgba(208,59,59,.06); margin-bottom: 18px; display:flex; align-items:center; justify-content:space-between; gap:14px; flex-wrap:wrap;">
        <div style="font-size:13px; color:var(--ink);">
          <strong>Exchange rate${missing.length > 1 ? 's' : ''} unavailable for ${missing.join(', ')}.</strong>
          Balances in ${missing.length > 1 ? 'these currencies' : 'this currency'} are being added to totals unconverted, so figures above may be inaccurate until this is fixed.
        </div>
        <div style="display:flex; gap:8px; flex-shrink:0;">
          <button class="btn btn-ghost btn-sm" id="dashboardRetryRatesBtn">Retry fetching rates</button>
          <button class="btn btn-ghost btn-sm" id="dashboardGoSettingsBtn">Set rate manually</button>
        </div>
      </div>` : '';

    const currencyCards = ['INR', 'EUR', 'USD'].map((code) => {
      const m = Monetra.calc.moneyByCurrency(code);
      const accent = CURRENCY_ACCENT[code] || 'var(--muted)';
      const convertedLine = code !== disp && Monetra.currency.canConvert(code, disp)
        ? `<div class="stat-delta">≈ ${Monetra.storage.formatMoney(Monetra.currency.convert(m.total, code, disp), disp)}</div>`
        : '';
      return `<div class="card stat-tile currency-tile" style="border-left: 4px solid ${accent};">
        <div class="stat-label">Money in ${code}</div>
        <div class="stat-value">${Monetra.storage.formatMoney(m.total, code)}</div>
        ${convertedLine}
        <div class="item-sub" style="margin-top:6px;">${m.count} account${m.count === 1 ? '' : 's'}/holding${m.count === 1 ? '' : 's'}</div>
      </div>`;
    }).join('');

    el.innerHTML = `
      ${warningBanner}
      <div class="dashboard-layout">
        <div class="dashboard-main">
          <div class="grid stat-grid">
            <div class="card stat-tile hero">
              <div class="stat-label">Net worth (${disp})</div>
              <div class="stat-value">${Monetra.storage.formatMoney(nw.net, disp)}</div>
              <div class="stat-delta ${nw.net >= 0 ? 'up' : 'down'}">Assets minus debts, converted at the latest rates</div>
            </div>
            <div class="card stat-tile">
              <div class="stat-label">Total assets</div>
              <div class="stat-value">${Monetra.storage.formatMoney(nw.assets.total, disp)}</div>
            </div>
            <div class="card stat-tile">
              <div class="stat-label">Total debts</div>
              <div class="stat-value">${Monetra.storage.formatMoney(nw.debts.total, disp)}</div>
            </div>
            <div class="card stat-tile">
              <div class="stat-label">This month · income vs expense</div>
              <div class="stat-value" style="font-size:20px;">${Monetra.storage.formatMoney(summary.income, disp)} <span class="muted" style="font-size:14px;">/</span> ${Monetra.storage.formatMoney(summary.expense, disp)}</div>
            </div>
          </div>

          <div class="grid chart-row">
            <div class="card chart-card">
              <h3>Assets details</h3>
              <div class="chart-sub">Bank and cash balances converted to ${disp}</div>
              <div class="chart-wrap"><canvas id="assetsChartCanvas"></canvas></div>
            </div>
            <div class="card chart-card">
              <h3>Debt details</h3>
              <div class="chart-sub">Total debt per loan, converted to ${disp}</div>
              <div class="chart-wrap"><canvas id="debtChartCanvas"></canvas></div>
            </div>
          </div>

          <div class="card chart-card">
            <h3>Income vs expense trend</h3>
            <div class="chart-sub">Last 12 months, in ${disp}</div>
            <div class="chart-wrap"><canvas id="trendChartCanvas"></canvas></div>
          </div>

          <div class="grid chart-row" style="margin-top:20px;">
            <div class="card chart-card">
              <h3>Actual cashflow</h3>
              ${spendSegments.length ? `
                <div style="display:flex; gap:20px; align-items:center; flex-wrap:wrap;">
                  <div style="position:relative; width:150px; height:150px; flex-shrink:0;">
                    <canvas id="dashboardSpendChartCanvas"></canvas>
                    <div class="donut-center-label">
                      <div class="donut-center-value" style="font-size:13px;">${Monetra.storage.formatMoney(spendOverview.totalSpent, disp)}</div>
                      <div class="donut-center-sub">Total spent</div>
                    </div>
                  </div>
                  <div class="cashflow-legend" style="flex:1; min-width:170px; margin-top:0;">
                    ${spendSegments.map((s) => `<div class="cashflow-legend-row"><span class="cashflow-legend-label"><span class="cashflow-dot" style="background:${s.color};"></span>${esc(s.label)}</span><span>${Monetra.storage.formatMoney(s.value, disp)}</span></div>`).join('')}
                  </div>
                </div>` : '<div class="empty-state">No spending recorded this month — see the Transactions tab.</div>'}
            </div>
            <div class="card chart-card">
              <h3>Planned Cash flow</h3>
              ${cashFlowSegments.length ? `
                <div style="display:flex; gap:20px; align-items:center; flex-wrap:wrap;">
                  <div style="position:relative; width:150px; height:150px; flex-shrink:0;">
                    <canvas id="dashboardCashflowChartCanvas"></canvas>
                    <div class="donut-center-label">
                      <div class="donut-center-value" style="font-size:13px;">${Monetra.storage.formatMoney(cashFlowCenterValue, disp)}</div>
                      <div class="donut-center-sub">${cashFlowCenterLabel}</div>
                    </div>
                  </div>
                  <div class="cashflow-legend" style="flex:1; min-width:170px; margin-top:0;">
                    ${cashFlowSegments.map((s) => `<div class="cashflow-legend-row"><span class="cashflow-legend-label"><span class="cashflow-dot" style="background:${s.color};"></span>${esc(s.label)}</span><span>${Monetra.storage.formatMoney(s.value, disp)}</span></div>`).join('')}
                  </div>
                </div>` : '<div class="empty-state">Add expected income and payments in the Monthly Planner to see this.</div>'}
            </div>
          </div>
          <div class="card chart-card" style="margin-top:16px;">
            <h3>Stocks and investments</h3>
            <div class="chart-sub">Current value, per stock · from Investments</div>
            ${invValueRowCount ? `<div style="max-height:280px; overflow-y:${invValueRowCount * 32 > 280 ? 'auto' : 'visible'};"><div style="position:relative; height:${Math.max(invValueRowCount * 32, 90)}px;"><canvas id="dashboardPerformanceChartCanvas"></canvas></div></div>` : '<div class="empty-state">Add a holding in Investments to see this.</div>'}
          </div>
        </div>

        <div class="dashboard-side">
          ${currencyCards}
        </div>
      </div>
    `;

    // Stocks/investments already get their own "Stocks and investments"
    // panel below, so they're left out of this chart to avoid showing the
    // same holdings twice under two different names.
    renderAssetsChart(nw.assets.breakdown.filter((b) => b.type !== 'investment'), disp);
    renderDebtChart(debtTotalBreakdown, disp);
    renderTrendChart(trend);
    renderSpendChart(spendSegments, disp);
    renderCashflowChart(cashFlowSegments, disp);
    if (invValueRowCount) Monetra.investments.renderPerformanceChart(invRows, disp, 'dashboardPerformanceChartCanvas', { onlyCurrentValue: true });

    if (missing.length) {
      document.getElementById('dashboardRetryRatesBtn').onclick = async (e) => {
        const btn = e.target;
        btn.disabled = true; btn.textContent = 'Retrying…';
        try { await Monetra.currency.fetchRates(); } catch (err) { alert('Still could not fetch rates: ' + err.message); }
        Monetra.app.renderAll();
      };
      document.getElementById('dashboardGoSettingsBtn').onclick = () => Monetra.app.showTab('settings');
    }
  }

  function chartsAvailable(ctx) {
    if (typeof Chart === 'undefined') {
      ctx.parentElement.innerHTML = '<div class="empty-state">Chart library failed to load — figures above are still accurate.</div>';
      return false;
    }
    return true;
  }

  function renderAssetsChart(breakdown, disp) {
    const ctx = document.getElementById('assetsChartCanvas');
    if (!ctx || !chartsAvailable(ctx)) return;
    const entries = breakdown.filter((b) => b.value !== 0);
    if (!entries.length) {
      ctx.parentElement.innerHTML = '<div class="empty-state">Add a bank or cash account to see your asset breakdown.</div>';
      return;
    }
    const folded = foldToTop(entries, 8);
    const colors = folded.map((_, i) => Monetra.palette.categoryColor(i));
    if (assetsChart) assetsChart.destroy();
    assetsChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: folded.map((e) => e.label),
        datasets: [{ data: folded.map((e) => e.value), backgroundColor: colors, borderRadius: 4, maxBarThickness: 22 }]
      },
      options: {
        indexAxis: 'y',
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (c) => Monetra.storage.formatMoney(c.parsed.x, disp) } }
        },
        scales: {
          x: { grid: { color: Monetra.palette.grid, drawTicks: false }, ticks: { color: Monetra.palette.ink2 }, border: { display: false } },
          y: { grid: { display: false }, ticks: { color: Monetra.palette.ink2 }, border: { display: false } }
        }
      }
    });
  }

  // Same horizontal-bar chart style as Assets details, just for outstanding
  // debt balances instead of asset balances.
  function renderDebtChart(breakdown, disp) {
    const ctx = document.getElementById('debtChartCanvas');
    if (!ctx || !chartsAvailable(ctx)) return;
    const entries = breakdown.filter((b) => b.value !== 0);
    if (!entries.length) {
      ctx.parentElement.innerHTML = '<div class="empty-state">Add a debt to see the breakdown.</div>';
      return;
    }
    const folded = foldToTop(entries, 8);
    const colors = folded.map((_, i) => Monetra.palette.categoryColor(i));
    if (debtChart) debtChart.destroy();
    debtChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: folded.map((e) => e.label),
        datasets: [{ data: folded.map((e) => e.value), backgroundColor: colors, borderRadius: 4, maxBarThickness: 22 }]
      },
      options: {
        indexAxis: 'y',
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (c) => Monetra.storage.formatMoney(c.parsed.x, disp) } }
        },
        scales: {
          x: { grid: { color: Monetra.palette.grid, drawTicks: false }, ticks: { color: Monetra.palette.ink2 }, border: { display: false } },
          y: { grid: { display: false }, ticks: { color: Monetra.palette.ink2 }, border: { display: false } }
        }
      }
    });
  }

  function renderTrendChart(trend) {
    const ctx = document.getElementById('trendChartCanvas');
    if (!ctx || !chartsAvailable(ctx)) return;
    if (trendChart) trendChart.destroy();
    trendChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: trend.map((t) => t.label),
        datasets: [
          { label: 'Income', data: trend.map((t) => t.income), borderColor: Monetra.palette.income, backgroundColor: Monetra.palette.income + '1a', borderWidth: 2, pointRadius: 3, pointBackgroundColor: Monetra.palette.income, tension: 0.25, fill: true },
          { label: 'Expense', data: trend.map((t) => t.expense), borderColor: Monetra.palette.expense, backgroundColor: Monetra.palette.expense + '1a', borderWidth: 2, pointRadius: 3, pointBackgroundColor: Monetra.palette.expense, tension: 0.25, fill: true },
          { label: 'Savings', data: trend.map((t) => t.savings), borderColor: Monetra.palette.good, backgroundColor: Monetra.palette.good + '1a', borderWidth: 2, pointRadius: 3, pointBackgroundColor: Monetra.palette.good, tension: 0.25, fill: false }
        ]
      },
      options: {
        plugins: {
          legend: { position: 'top', align: 'end', labels: { color: Monetra.palette.ink2, boxWidth: 10, boxHeight: 10, font: { size: 11 } } }
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: Monetra.palette.ink2 }, border: { display: false } },
          y: { grid: { color: Monetra.palette.grid }, ticks: { color: Monetra.palette.ink2 }, border: { display: false } }
        }
      }
    });
  }

  function renderSpendChart(segments, disp) {
    const ctx = document.getElementById('dashboardSpendChartCanvas');
    if (!ctx || typeof Chart === 'undefined' || !segments.length) return;
    if (spendChart) spendChart.destroy();
    spendChart = new Chart(ctx, {
      type: 'doughnut',
      data: { labels: segments.map((s) => s.label), datasets: [{ data: segments.map((s) => s.value), backgroundColor: segments.map((s) => s.color), borderColor: '#fcfcfb', borderWidth: 2 }] },
      options: { cutout: '68%', plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.label}: ${Monetra.storage.formatMoney(c.parsed, disp)}` } } } }
    });
  }

  function renderCashflowChart(segments, disp) {
    const ctx = document.getElementById('dashboardCashflowChartCanvas');
    if (!ctx || typeof Chart === 'undefined' || !segments.length) return;
    if (cashflowChart) cashflowChart.destroy();
    cashflowChart = new Chart(ctx, {
      type: 'doughnut',
      data: { labels: segments.map((s) => s.label), datasets: [{ data: segments.map((s) => s.value), backgroundColor: segments.map((s) => s.color), borderColor: '#fcfcfb', borderWidth: 2 }] },
      options: { cutout: '68%', plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.label}: ${Monetra.storage.formatMoney(c.parsed, disp)}` } } } }
    });
  }

  Monetra.dashboard = { render };
})();
