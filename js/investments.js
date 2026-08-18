window.Monetra = window.Monetra || {};

/* Investments dashboard: KPI summary, allocation-by-market donut, a
   per-stock Invested-vs-Current-value comparison chart, a filterable
   holdings table, and two ranked side panels (top 5 by gain %, top 3 by
   value). Average buy price is required for new holdings so Total
   Invested / Gain-Loss are always real numbers going forward; older
   holdings added before this requirement can still be missing one and
   just show "—" until edited. */
(function () {
  function escape(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function hexToRgba(hex, alpha) {
    const h = (hex || '#898781').replace('#', '');
    const r = parseInt(h.substring(0, 2), 16), g = parseInt(h.substring(2, 4), 16), b = parseInt(h.substring(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  function fmtPct(pct) { return (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%'; }
  // Stable per-holding color (hashes the symbol) so a stock's color never
  // shifts just because the table got sorted/filtered differently.
  function colorForSymbol(symbol) {
    let hash = 0;
    const s = symbol || '';
    for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
    return Monetra.palette.categoryColor(hash);
  }

  const ICON_VALUE = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 6-7"/></svg>';
  const ICON_INVESTED = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/></svg>';
  const ICON_GAIN = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17 10 11 14 15 20 7"/><path d="M14 7h6v6"/></svg>';
  const ICON_PULSE = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2 7 4-14 2 7h6"/></svg>';

  // Investments now live in the database, requiring login — same
  // login-gate + syncedForUserId pattern used for PayLater/Accounts/
  // Planner/Transactions/Debts.
  function isLoggedIn() {
    return !!(Monetra.auth && Monetra.auth.isLoggedIn());
  }
  let syncedForUserId = null;

  let allocationChart = null;
  // Keyed by canvas id, not a single variable — the Performance chart is
  // reused as-is on the Dashboard (see renderPerformanceChart below), so two
  // independent Chart.js instances can be alive on two different canvases
  // at once (this tab's own canvas, plus the Dashboard's copy).
  const performanceCharts = {};
  let activeFilter = 'all'; // 'all' | 'IN' | 'INTL'

  function exchangeLabel(inv) {
    if (inv.exchangeName) return inv.exchangeName;
    const idx = (inv.symbol || '').indexOf(':');
    if (idx !== -1) return inv.symbol.slice(idx + 1);
    return inv.market === 'IN' ? 'Indian' : 'International';
  }

  function computeRows(state, disp) {
    return state.investments.map((inv) => {
      const qty = inv.quantity || 0;
      const price = inv.currentPrice || 0;
      const valueNative = qty * price;
      const valueDisp = Monetra.currency.convert(valueNative, inv.currency, disp);
      const hasCost = inv.avgCost != null;
      const investedDisp = hasCost ? Monetra.currency.convert(qty * inv.avgCost, inv.currency, disp) : null;
      const gainDisp = hasCost ? valueDisp - investedDisp : null;
      const gainPct = hasCost && investedDisp ? (gainDisp / investedDisp) * 100 : null;
      const dayChangePercent = (inv.dayChangePercent !== undefined && inv.dayChangePercent !== null && !Number.isNaN(inv.dayChangePercent)) ? inv.dayChangePercent : null;
      const dayChangeDisp = dayChangePercent !== null ? valueDisp - (valueDisp / (1 + dayChangePercent / 100)) : null;
      return {
        inv, id: inv.id, symbol: inv.symbol, name: inv.name, market: inv.market,
        exchange: exchangeLabel(inv), qty, price, currency: inv.currency,
        valueDisp, hasCost, investedDisp, gainDisp, gainPct,
        dayChangePercent, dayChangeDisp, color: colorForSymbol(inv.symbol)
      };
    });
  }

  function computeKpis(rows) {
    const totalValueDisp = rows.reduce((s, r) => s + r.valueDisp, 0);
    const costRows = rows.filter((r) => r.hasCost);
    const totalInvestedDisp = costRows.length ? costRows.reduce((s, r) => s + r.investedDisp, 0) : null;
    const costValueDisp = costRows.length ? costRows.reduce((s, r) => s + r.valueDisp, 0) : null;
    const totalGainDisp = costRows.length ? costValueDisp - totalInvestedDisp : null;
    const totalGainPct = (costRows.length && totalInvestedDisp) ? (totalGainDisp / totalInvestedDisp) * 100 : null;

    const dayRows = rows.filter((r) => r.dayChangePercent !== null);
    let todaysChangeDisp = null, todaysChangePct = null;
    if (dayRows.length) {
      const curSum = dayRows.reduce((s, r) => s + r.valueDisp, 0);
      const prevSum = dayRows.reduce((s, r) => s + (r.valueDisp - r.dayChangeDisp), 0);
      todaysChangeDisp = curSum - prevSum;
      todaysChangePct = prevSum ? (todaysChangeDisp / prevSum) * 100 : null;
    }

    return { totalValueDisp, totalInvestedDisp, investedCount: costRows.length, totalCount: rows.length, totalGainDisp, totalGainPct, todaysChangeDisp, todaysChangePct };
  }

  // Fixed color order (International = categorical[0], Indian = categorical[1])
  // regardless of which is bigger — identity, never re-cycled by rank.
  function computeAllocation(rows) {
    const intlTotal = rows.filter((r) => r.market !== 'IN').reduce((s, r) => s + r.valueDisp, 0);
    const inTotal = rows.filter((r) => r.market === 'IN').reduce((s, r) => s + r.valueDisp, 0);
    return [
      { label: 'International', value: intlTotal, color: Monetra.palette.categoryColor(0) },
      { label: 'Indian', value: inTotal, color: Monetra.palette.categoryColor(1) }
    ].filter((s) => s.value > 0);
  }

  // Ranked by best gain % — only holdings with a real cost basis qualify,
  // since gain % can't be computed (let alone ranked) without one.
  function computeTopByGain(rows, n) {
    return rows.filter((r) => r.hasCost)
      .slice().sort((a, b) => b.gainPct - a.gainPct)
      .slice(0, n || 5);
  }

  // Ranked by current value — works for every holding, cost basis or not.
  function computeTopByValue(rows, n) {
    return rows.slice().sort((a, b) => b.valueDisp - a.valueDisp).slice(0, n || 3);
  }

  function kpiCardHtml(label, value, colorClass, icon, subText, deltaPct) {
    const subClass = (deltaPct === null || deltaPct === undefined) ? '' : 'stat-delta ' + (deltaPct >= 0 ? 'up' : 'down');
    return `<div class="debt-kpi">
      <div class="debt-kpi-icon ${colorClass}">${icon}</div>
      <div>
        <div class="debt-kpi-label">${label}</div>
        <div class="debt-kpi-value">${value}</div>
        <div class="debt-kpi-sub ${subClass}">${escape(subText)}</div>
      </div>
    </div>`;
  }

  function holdingRowHtml(r, disp) {
    const initial = escape((r.symbol || '?').charAt(0));
    return `<tr data-id="${r.id}">
      <td>
        <div style="display:flex; align-items:center; gap:10px;">
          <div class="budget-icon" style="background:${hexToRgba(r.color, .14)}; color:${r.color};">${initial}</div>
          <div>
            <div style="font-weight:600;">${escape(r.symbol)}</div>
            ${r.name ? `<div class="muted small">${escape(r.name)}</div>` : ''}
          </div>
        </div>
      </td>
      <td><span class="pill pill-neutral">${escape(r.exchange)}</span></td>
      <td>${r.qty}</td>
      <td>${r.hasCost ? Monetra.storage.formatMoney(r.inv.avgCost, r.currency) : '—'}</td>
      <td>${r.hasCost ? Monetra.storage.formatMoney(r.investedDisp, disp) : '—'}</td>
      <td>${Monetra.storage.formatMoney(r.price, r.currency)}${r.dayChangePercent !== null ? `<div class="stat-delta ${r.dayChangePercent >= 0 ? 'up' : 'down'}" style="font-size:11px;">${fmtPct(r.dayChangePercent)}</div>` : ''}</td>
      <td>${Monetra.storage.formatMoney(r.valueDisp, disp)}</td>
      <td>${r.hasCost ? `<span class="stat-delta ${r.gainDisp >= 0 ? 'up' : 'down'}">${r.gainDisp >= 0 ? '+' : ''}${Monetra.storage.formatMoney(r.gainDisp, disp)} (${fmtPct(r.gainPct)})</span>` : '—'}</td>
      <td>
        <button class="btn btn-ghost btn-sm" data-action="edit">Edit</button>
        <button class="btn btn-danger btn-sm" data-action="delete">Delete</button>
      </td>
    </tr>`;
  }

  // A single, compact "ranked holding" row — reused for both the top-gain
  // and top-value side panels, just with different right-hand figures.
  function rankedRowHtml(r, rightTop, rightBottomHtml) {
    return `<div class="mover-row">
      <div class="mover-icon" style="background:${hexToRgba(r.color, .14)}; color:${r.color};">${escape((r.symbol || '?').charAt(0))}</div>
      <div class="mover-info">
        <div class="mover-name">${escape(r.symbol)}</div>
        <div class="mover-sub">${escape(r.exchange)}</div>
      </div>
      <div class="mover-value">
        <div>${rightTop}</div>
        ${rightBottomHtml}
      </div>
    </div>`;
  }

  function renderAllocationChart(segments, disp) {
    const ctx = document.getElementById('allocationChartCanvas');
    if (!ctx || typeof Chart === 'undefined' || !segments.length) return;
    if (allocationChart) allocationChart.destroy();
    allocationChart = new Chart(ctx, {
      type: 'doughnut',
      data: { labels: segments.map((s) => s.label), datasets: [{ data: segments.map((s) => s.value), backgroundColor: segments.map((s) => s.color), borderColor: '#fcfcfb', borderWidth: 2 }] },
      options: { cutout: '70%', plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.label}: ${Monetra.storage.formatMoney(c.parsed, disp)}` } } } }
    });
  }

  // Per-stock Invested vs Current-value comparison, as a horizontal grouped
  // bar chart — stays readable whether there are 2 holdings or 30, since
  // rows stack downward (scrolling if needed) instead of squeezing bars
  // sideways into a fixed width. Only holdings with a real cost basis are
  // plotted — there's nothing honest to compare a holding to without a
  // recorded buy price. Both bars use one fixed color each (not
  // gain/loss-colored per bar), so the legend swatch always matches what's
  // on screen; the gain or loss reads directly off which bar is longer.
  // Sorted by current value, largest first (top of chart). `canvasId`
  // defaults to this tab's own canvas but can point at another canvas
  // (e.g. the Dashboard's copy of this chart) — each canvas keeps its own
  // Chart.js instance so re-rendering one never destroys the other.
  // `opts.onlyCurrentValue` (used by the Dashboard's copy) drops the
  // Invested bar entirely and plots every holding by current value alone —
  // since that doesn't need a cost basis to be honest, it can include
  // holdings without a recorded buy price too, not just the cost-basis ones.
  function renderPerformanceChart(rows, disp, canvasId, opts) {
    canvasId = canvasId || 'performanceChartCanvas';
    opts = opts || {};
    const ctx = document.getElementById(canvasId);
    if (!ctx || typeof Chart === 'undefined') return;
    const sourceRows = opts.onlyCurrentValue ? rows : rows.filter((r) => r.hasCost);
    const sortedRows = sourceRows.slice().sort((a, b) => b.valueDisp - a.valueDisp);
    if (!sortedRows.length) return;
    if (performanceCharts[canvasId]) performanceCharts[canvasId].destroy();
    // Chart.js draws the first category at the BOTTOM of a horizontal (y
    // indexAxis) chart by default, so reverse the sorted array to get the
    // largest holding at the top, matching normal top-to-bottom ranking.
    const ranked = sortedRows.slice().reverse();
    const datasets = opts.onlyCurrentValue
      ? [{ label: 'Current value', data: ranked.map((r) => r.valueDisp), backgroundColor: Monetra.palette.categoryColor(0), borderRadius: 4, maxBarThickness: 16 }]
      : [
          { label: 'Invested', data: ranked.map((r) => r.investedDisp), backgroundColor: Monetra.palette.muted, borderRadius: 4, maxBarThickness: 16 },
          { label: 'Current value', data: ranked.map((r) => r.valueDisp), backgroundColor: Monetra.palette.categoryColor(0), borderRadius: 4, maxBarThickness: 16 }
        ];
    performanceCharts[canvasId] = new Chart(ctx, {
      type: 'bar',
      data: { labels: ranked.map((r) => r.symbol), datasets },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          // A single series doesn't need a legend box — the chart title
          // already names it, and there's nothing to distinguish by color.
          legend: opts.onlyCurrentValue ? { display: false } : { position: 'top', align: 'end', labels: { color: Monetra.palette.ink2, boxWidth: 10, boxHeight: 10, font: { size: 11 } } },
          tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${Monetra.storage.formatMoney(c.parsed.x, disp)}` } }
        },
        scales: {
          x: { grid: { color: Monetra.palette.grid, drawTicks: false }, ticks: { color: Monetra.palette.ink2 }, border: { display: false }, beginAtZero: true },
          y: { grid: { display: false }, ticks: { color: Monetra.palette.ink2 }, border: { display: false } }
        }
      }
    });
  }

  function render() {
    const el = document.getElementById('tab-investments');
    if (!el) return;

    if (!isLoggedIn()) {
      syncedForUserId = null;
      el.innerHTML = `
        <div class="section-header"><h2>Investments</h2></div>
        <div class="card" style="max-width:520px;">
          <h3 style="margin-top:0;">Log in to use Investments</h3>
          <p class="hint" style="margin-top:0;">Your investment holdings are saved to your Monetra account, not this browser — so you'll need to be logged in to add or view them. Everything else in Monetra still works without logging in.</p>
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
      // account's holdings, cached from before that account logged out
      // (the same class of bug already fixed once for the Settings API
      // keys). Show a loading state and only draw real rows once the
      // server has answered for whoever is actually logged in right now.
      el.innerHTML = `<div class="section-header"><h2>Investments</h2></div><div class="hint">Loading your investments…</div>`;
      Monetra.auth.authFetch('/api/investments', { method: 'GET' })
        .then((result) => {
          const state = Monetra.storage.getState();
          state.investments = result.investments || [];
          Monetra.storage.save();
          syncedForUserId = userId;
          Monetra.app.renderAll();
        })
        .catch((err) => {
          el.innerHTML = `<div class="section-header"><h2>Investments</h2></div><div class="hint" style="color:var(--critical);">Could not load your investments: ${escape(err.message)}</div>`;
        });
      return;
    }

    renderList(el);
  }

  function renderList(el) {
    const state = Monetra.storage.getState();
    const disp = state.settings.displayCurrency;
    const hasKey = !!(state.settings.twelveDataApiKey || state.settings.alphaVantageApiKey);

    const rows = computeRows(state, disp);
    const kpis = computeKpis(rows);
    const allocation = computeAllocation(rows);
    const topByGain = computeTopByGain(rows, 5);
    const topByValue = computeTopByValue(rows, 3);
    const costRowCount = rows.filter((r) => r.hasCost).length;

    const filteredRows = activeFilter === 'all' ? rows : rows.filter((r) => r.market === activeFilter);
    const pct = (part) => (kpis.totalValueDisp > 0 ? ((part / kpis.totalValueDisp) * 100).toFixed(0) : '0');

    el.innerHTML = `
      <div class="section-header">
        <h2>Investments</h2>
        <div class="section-actions">
          <button class="btn btn-ghost btn-sm" id="refreshPricesBtn" ${hasKey ? '' : 'disabled title="Add an API key in Settings"'}>Refresh prices</button>
          <button class="btn btn-primary btn-sm" id="addInvBtn">+ Add investment</button>
        </div>
      </div>
      <div class="hint" style="margin-top:-8px; margin-bottom:18px;">Track all your stocks and investments in one place.</div>
      ${hasKey ? '' : '<div class="hint" style="margin-bottom:16px;">Add a free Twelve Data API key (international stocks) and/or Alpha Vantage API key (Indian stocks) in Settings to refresh prices automatically — otherwise update the current price manually on each investment.</div>'}

      <div class="debts-kpis">
        ${kpiCardHtml('TOTAL INVESTMENT VALUE', Monetra.storage.formatMoney(kpis.totalValueDisp, disp), 'kpi-blue', ICON_VALUE, kpis.todaysChangePct !== null ? fmtPct(kpis.todaysChangePct) + ' today' : `${kpis.totalCount} holding${kpis.totalCount === 1 ? '' : 's'}`, kpis.todaysChangePct)}
        ${kpiCardHtml('TOTAL INVESTED', kpis.totalInvestedDisp !== null ? Monetra.storage.formatMoney(kpis.totalInvestedDisp, disp) : '—', 'kpi-green', ICON_INVESTED, kpis.totalCount === 0 ? 'No holdings yet' : (kpis.investedCount < kpis.totalCount ? `${kpis.investedCount} of ${kpis.totalCount} have a buy price` : 'All holdings have a buy price'), null)}
        ${kpiCardHtml('TOTAL GAIN / LOSS', kpis.totalGainDisp !== null ? (kpis.totalGainDisp >= 0 ? '+' : '') + Monetra.storage.formatMoney(kpis.totalGainDisp, disp) : '—', 'kpi-violet', ICON_GAIN, kpis.totalGainPct !== null ? fmtPct(kpis.totalGainPct) : 'Add a buy price to see gain', kpis.totalGainPct)}
        ${kpiCardHtml("TODAY'S CHANGE", kpis.todaysChangeDisp !== null ? (kpis.todaysChangeDisp >= 0 ? '+' : '') + Monetra.storage.formatMoney(kpis.todaysChangeDisp, disp) : '—', 'kpi-orange', ICON_PULSE, kpis.todaysChangePct !== null ? fmtPct(kpis.todaysChangePct) : 'Refresh prices to see today’s change', kpis.todaysChangePct)}
      </div>

      <div class="planner-row" style="margin-bottom:20px;">
        <div class="planner-col-narrow"><div class="card">
          <div class="panel-title">Portfolio allocation <span class="muted small" style="font-weight:400;">by market</span></div>
          ${allocation.length ? `
            <div style="position:relative; max-width:200px; margin:0 auto;">
              <canvas id="allocationChartCanvas"></canvas>
              <div class="donut-center-label">
                <div class="donut-center-value" style="font-size:14px;">${Monetra.storage.formatMoney(kpis.totalValueDisp, disp)}</div>
                <div class="donut-center-sub">Total value</div>
              </div>
            </div>
            <div class="cashflow-legend">
              ${allocation.map((s) => `<div class="cashflow-legend-row"><span class="cashflow-legend-label"><span class="cashflow-dot" style="background:${s.color};"></span>${escape(s.label)}</span><span>${Monetra.storage.formatMoney(s.value, disp)} · ${pct(s.value)}%</span></div>`).join('')}
            </div>` : '<div class="empty-state">Add a holding to see your allocation.</div>'}
        </div></div>

        <div class="planner-col-wide"><div class="card">
          <div class="panel-title-row">
            <div class="panel-title">Performance <span class="muted small" style="font-weight:400;">invested vs. current value, per stock, in ${disp}</span></div>
            ${kpis.totalGainPct !== null ? `<span class="pill ${kpis.totalGainPct >= 0 ? 'pill-paid' : 'pill-overdue'}">${fmtPct(kpis.totalGainPct)}</span>` : ''}
          </div>
          ${costRowCount ? `<div style="max-height:420px; overflow-y:${costRowCount * 32 > 420 ? 'auto' : 'visible'};"><div style="position:relative; height:${Math.max(costRowCount * 32, 90)}px;"><canvas id="performanceChartCanvas"></canvas></div></div>${costRowCount < rows.length ? `<div class="hint" style="margin-top:10px;">${rows.length - costRowCount} holding${rows.length - costRowCount === 1 ? '' : 's'} not shown — add a buy price to include ${costRowCount < rows.length - 1 ? 'them' : 'it'}.</div>` : ''}` : '<div class="empty-state">Add a buy price to a holding to compare invested vs. current value here.</div>'}
        </div></div>
      </div>

      <div class="planner-row">
        <div class="planner-col-wide"><div class="card">
          <div class="panel-title-row">
            <div class="panel-title" style="margin-bottom:0;">Holdings</div>
            <div class="seg-tabs">
              <button type="button" class="seg-tab ${activeFilter === 'all' ? 'active' : ''}" data-filter="all">All holdings</button>
              <button type="button" class="seg-tab ${activeFilter === 'IN' ? 'active' : ''}" data-filter="IN">Indian stocks</button>
              <button type="button" class="seg-tab ${activeFilter === 'INTL' ? 'active' : ''}" data-filter="INTL">International</button>
            </div>
          </div>
          <div class="table-wrap" style="margin-top:14px;">
            <table>
              <thead><tr><th>Stock</th><th>Market</th><th>Units</th><th>Avg. price</th><th>Invested</th><th>Current price</th><th>Current value</th><th>Gain/Loss</th><th></th></tr></thead>
              <tbody>${filteredRows.length ? filteredRows.map((r) => holdingRowHtml(r, disp)).join('') : `<tr><td colspan="9" class="empty-state">${rows.length ? 'No holdings in this filter.' : 'No investments yet. Add an Indian or international stock holding to start tracking it.'}</td></tr>`}</tbody>
            </table>
          </div>
        </div></div>

        <div class="planner-col-narrow" style="display:flex; flex-direction:column; gap:20px;">
          <div class="card">
            <div class="panel-title">Holdings by market</div>
            ${allocation.length ? allocation.map((s) => `
              <div class="meter-row"><span>${escape(s.label)}</span><span>${Monetra.storage.formatMoney(s.value, disp)} (${pct(s.value)}%)</span></div>
              <div class="meter" style="margin-bottom:12px;"><div class="meter-fill" style="width:${pct(s.value)}%; background:${s.color};"></div></div>
            `).join('') : '<div class="empty-state">No holdings yet.</div>'}
          </div>
          <div class="card">
            <div class="panel-title">Top 5 investments <span class="muted small" style="font-weight:400;">by gain %</span></div>
            ${topByGain.length ? topByGain.map((r) => rankedRowHtml(
              r,
              `${r.gainDisp >= 0 ? '+' : ''}${Monetra.storage.formatMoney(r.gainDisp, disp)}`,
              `<div class="stat-delta ${r.gainPct >= 0 ? 'up' : 'down'}">${fmtPct(r.gainPct)}</div>`
            )).join('') : '<div class="empty-state">Add a buy price to your holdings to rank them by gain.</div>'}
          </div>
          <div class="card">
            <div class="panel-title">Top 3 highest value <span class="muted small" style="font-weight:400;">stocks</span></div>
            ${topByValue.length ? topByValue.map((r) => rankedRowHtml(
              r,
              Monetra.storage.formatMoney(r.valueDisp, disp),
              `<div class="mover-sub">${(kpis.totalValueDisp > 0 ? (r.valueDisp / kpis.totalValueDisp) * 100 : 0).toFixed(0)}% of portfolio</div>`
            )).join('') : '<div class="empty-state">No holdings yet.</div>'}
          </div>
        </div>
      </div>
    `;

    document.getElementById('addInvBtn').onclick = () => openForm();
    document.getElementById('refreshPricesBtn').onclick = async () => {
      const btn = document.getElementById('refreshPricesBtn');
      btn.disabled = true; btn.textContent = 'Refreshing…';
      try {
        const result = await Monetra.stocks.refreshAll();
        if (result.failed.length) alert('Updated ' + result.updated + ' price(s). Some failed:\n' + result.failed.join('\n'));
      } catch (e) {
        alert(e.message);
      }
      Monetra.app.renderAll();
    };

    el.querySelectorAll('.seg-tab').forEach((btn) => {
      btn.onclick = () => { activeFilter = btn.dataset.filter; render(); };
    });

    el.querySelectorAll('tbody tr[data-id]').forEach((tr) => {
      const id = tr.dataset.id;
      const editBtn = tr.querySelector('[data-action="edit"]');
      const delBtn = tr.querySelector('[data-action="delete"]');
      if (editBtn) editBtn.onclick = () => openForm(id);
      if (delBtn) delBtn.onclick = () => {
        const target = state.investments.find((i) => i.id === id);
        if (!target) return;
        if (confirm('Delete this investment? This cannot be undone.')) {
          Monetra.auth.authFetch('/api/investments/' + id, { method: 'DELETE' })
            .then(() => {
              syncedForUserId = null; // force a fresh refetch
              Monetra.app.renderAll();
            })
            .catch((err) => alert('Could not delete that investment: ' + err.message));
        }
      };
    });

    renderAllocationChart(allocation, disp);
    renderPerformanceChart(rows, disp);
  }

  // Splits a stored symbol like "IRFC:NSE" back into its raw ticker and
  // exchange for re-populating the two separate form fields when editing.
  function splitSymbol(sym) {
    if (!sym) return { raw: '', exchange: 'NSE' };
    const idx = sym.indexOf(':');
    if (idx === -1) return { raw: sym, exchange: '' };
    return { raw: sym.slice(0, idx), exchange: sym.slice(idx + 1) };
  }

  function openForm(id) {
    const state = Monetra.storage.getState();
    const existing = id ? state.investments.find((i) => i.id === id) : null;
    const hasKey = !!(state.settings.twelveDataApiKey || state.settings.alphaVantageApiKey);
    const split = splitSymbol(existing ? existing.symbol : '');
    const initialExchange = existing ? split.exchange : 'NSE';

    const html = `
      <h2>${existing ? 'Edit investment' : 'Add investment'}</h2>
      <form id="invForm">
        <div class="form-grid-2">
          <div class="form-row"><label>Symbol</label><input name="symbolRaw" id="invSymbolRaw" required value="${escape(split.raw)}" placeholder="e.g. IRFC, AAPL"></div>
          <div class="form-row"><label>Exchange</label>
            <select name="exchange" id="invExchange">
              <option value="NSE" ${initialExchange === 'NSE' ? 'selected' : ''}>NSE (India)</option>
              <option value="BSE" ${initialExchange === 'BSE' ? 'selected' : ''}>BSE (India)</option>
              <option value="" ${initialExchange === '' ? 'selected' : ''}>International / US</option>
            </select>
          </div>
        </div>
        <div class="form-row" style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
          <button type="button" class="btn btn-ghost btn-sm" id="autofillBtn">Fetch price &amp; details</button>
          <span class="hint" id="autofillStatus" style="margin:0;">${hasKey ? 'Type the symbol and pick the exchange — name, price and currency fill in automatically.' : 'Add a free Twelve Data (international) or Alpha Vantage (Indian) API key in Settings to auto-fill these.'}</span>
        </div>
        <div class="form-row"><label>Name</label><input name="name" id="invName" value="${existing ? escape(existing.name || '') : ''}" placeholder="Fetched automatically"></div>
        <div class="form-grid-2">
          <div class="form-row"><label>Quantity</label><input name="quantity" type="number" step="0.0001" required value="${existing ? existing.quantity : ''}"></div>
          <div class="form-row"><label>Average buy price${existing ? ' (optional)' : ''}</label><input name="avgCost" type="number" step="0.01" ${existing ? '' : 'required'} value="${existing && existing.avgCost != null ? existing.avgCost : ''}" placeholder="What you paid per unit"></div>
        </div>
        <div class="form-grid-2">
          <div class="form-row"><label>Currency</label>
            <select name="currency" id="invCurrency">${Monetra.storage.CURRENCIES.map((c) => `<option value="${c}" ${existing && existing.currency === c ? 'selected' : (!existing && c === 'INR') ? 'selected' : ''}>${c}</option>`).join('')}</select>
          </div>
          <div class="form-row"><label>Current price</label><input name="currentPrice" id="invPrice" type="number" step="0.01" required value="${existing ? existing.currentPrice : ''}"></div>
        </div>
        <div class="hint">Symbol + exchange are combined automatically (IRFC + NSE → <code>IRFC:NSE</code>). For US/international stocks, set Exchange to "International / US" and just use the plain ticker (e.g. <code>AAPL</code>).</div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" id="cancelBtn">Cancel</button>
          <button type="submit" class="btn btn-primary">${existing ? 'Save changes' : 'Add investment'}</button>
        </div>
      </form>`;

    Monetra.modal.open(html, (root) => {
      root.querySelector('#cancelBtn').onclick = () => Monetra.modal.close();

      let fetchedExchange = existing ? (existing.exchangeName || null) : null;
      let fetchedDayChangePct = existing ? (existing.dayChangePercent != null ? existing.dayChangePercent : null) : null;

      async function tryAutofill() {
        const symbolRaw = root.querySelector('#invSymbolRaw').value.trim().toUpperCase();
        const exchange = root.querySelector('#invExchange').value;
        const statusEl = root.querySelector('#autofillStatus');
        if (!symbolRaw) return;
        const st = Monetra.storage.getState();
        const apiKey = st.settings.twelveDataApiKey;
        const alphaKey = st.settings.alphaVantageApiKey;
        const isIndian = exchange === 'NSE' || exchange === 'BSE';
        if (!apiKey && !(isIndian && alphaKey)) {
          statusEl.textContent = isIndian
            ? 'Add a free Alpha Vantage (or Twelve Data) API key in Settings to auto-fill these.'
            : 'Add a free Twelve Data API key in Settings to auto-fill these.';
          return;
        }
        const fullSymbol = exchange ? `${symbolRaw}:${exchange}` : symbolRaw;
        statusEl.textContent = 'Fetching ' + fullSymbol + '…';
        try {
          const q = await Monetra.stocks.fetchQuoteSmart(fullSymbol, apiKey, alphaKey);
          root.querySelector('#invPrice').value = q.price;
          if (q.name) root.querySelector('#invName').value = q.name;
          const curSel = root.querySelector('#invCurrency');
          if (q.currency && Array.from(curSel.options).some((o) => o.value === q.currency)) curSel.value = q.currency;
          fetchedExchange = q.exchange || fetchedExchange;
          fetchedDayChangePct = (q.percentChange !== null && q.percentChange !== undefined && !Number.isNaN(q.percentChange)) ? q.percentChange : fetchedDayChangePct;
          statusEl.textContent = `Fetched: ${q.name || fullSymbol} — ${Monetra.storage.formatMoney(q.price, curSel.value)}`;
        } catch (e) {
          statusEl.textContent = 'Could not fetch (' + e.message + ') — you can enter the details manually below.';
        }
      }

      root.querySelector('#autofillBtn').onclick = tryAutofill;
      root.querySelector('#invSymbolRaw').addEventListener('blur', tryAutofill);
      root.querySelector('#invExchange').addEventListener('change', tryAutofill);

      root.querySelector('#invForm').onsubmit = (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const avgCostRaw = fd.get('avgCost');
        const symbolRaw = fd.get('symbolRaw').trim().toUpperCase();
        const exchange = fd.get('exchange');
        const data = {
          symbol: exchange ? `${symbolRaw}:${exchange}` : symbolRaw,
          market: exchange ? 'IN' : 'INTL',
          name: fd.get('name').trim(),
          quantity: parseFloat(fd.get('quantity')),
          avgCost: avgCostRaw ? parseFloat(avgCostRaw) : null,
          currency: fd.get('currency'),
          currentPrice: parseFloat(fd.get('currentPrice')),
          exchangeName: fetchedExchange,
          dayChangePercent: fetchedDayChangePct,
          lastUpdated: new Date().toISOString()
        };

        const submitBtn = root.querySelector('#invForm button[type="submit"]');
        submitBtn.disabled = true;
        const req = existing
          ? Monetra.auth.authFetch('/api/investments/' + existing.id, { method: 'PUT', body: JSON.stringify(data) })
          : Monetra.auth.authFetch('/api/investments', { method: 'POST', body: JSON.stringify(data) });
        req.then(() => {
          Monetra.modal.close();
          syncedForUserId = null; // force a fresh refetch
          Monetra.app.renderAll();
        }).catch((err) => {
          submitBtn.disabled = false;
          alert('Could not save: ' + err.message);
        });
      };
    });
  }

  // computeRows/renderPerformanceChart are also exported so the Dashboard
  // can render its own copy of the Performance chart from the same
  // real holdings data, instead of re-deriving the math separately.
  Monetra.investments = { render, computeRows, renderPerformanceChart };
})();
