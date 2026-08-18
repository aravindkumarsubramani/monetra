window.Monetra = window.Monetra || {};

/* Debts (loans, EMIs, personal debts, etc.) — instead of a fixed monthly EMI,
   each debt has a manually-built payment schedule: a list of {date, amount}
   entries the user adds one at a time. The date is optional (some debts have
   no fixed due date, just an amount owed). There's no separate "current
   debt" field — the remaining balance is derived automatically as
   totalDebt minus whatever schedule rows are checked off as paid. Checking a
   row is reversible: unchecking it restores the amount to the remaining
   balance.

   The page is a small dashboard: KPI stat cards, a payment calendar with an
   upcoming-payments agenda, a row of rich debt cards, a debt-progress panel,
   an upcoming-payments table, and a full payment table (all dates, then
   undated payments) at the bottom. */
(function () {
  function escape(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

  function formatDate(iso) {
    if (!iso) return 'No due date';
    // Delegates to the shared, Profile -> Date format-aware formatter so
    // this page always matches the user's chosen date style.
    return Monetra.storage.formatDate(iso);
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  function sortSchedule(schedule) {
    return (schedule || []).slice().sort((a, b) => {
      const ad = a.date || '9999-99-99';
      const bd = b.date || '9999-99-99';
      return ad < bd ? -1 : ad > bd ? 1 : 0;
    });
  }

  // Split a schedule into the known-date rows (sorted soonest to latest, for
  // the "date wise to pay" ordering) and the no-date rows.
  function splitSchedule(schedule) {
    const known = [];
    const unknown = [];
    (schedule || []).forEach((row) => (row.date ? known.push(row) : unknown.push(row)));
    known.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return { known, unknown };
  }

  // Debts still owed appear above fully paid-off debts.
  function sortDebtsForDisplay(debts) {
    return (debts || []).slice().sort((a, b) => {
      const aActive = (a.currentDebt || 0) > 0 ? 0 : 1;
      const bActive = (b.currentDebt || 0) > 0 ? 0 : 1;
      return aActive - bActive;
    });
  }

  function scheduleMiniHtml(rows, currency, emptyText) {
    if (!rows.length) return `<div class="schedule-empty">${emptyText}</div>`;
    return rows.map((row) => `
      <div class="schedule-mini" data-row-id="${row.id}">
        <label class="schedule-check">
          <input type="checkbox" data-schedule-id="${row.id}" ${row.paid ? 'checked' : ''}>
          <span>${row.date ? formatDate(row.date) : 'Payment'}</span>
        </label>
        <span class="schedule-mini-amount">${Monetra.storage.formatMoney(row.amount, currency)}</span>
      </div>`).join('');
  }

  function nextUnpaidDated(d) {
    const rows = (d.schedule || []).filter((r) => !r.paid && r.date);
    if (!rows.length) return null;
    rows.sort((a, b) => (a.date < b.date ? -1 : 1));
    return rows[0];
  }

  // ---- Icons (inline SVG, currentColor) ----------------------------------
  const ICON_GRID = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>';
  const ICON_WALLET = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/><circle cx="16" cy="14" r="1.2" fill="currentColor" stroke="none"/></svg>';
  const ICON_CAL_DOT = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/><circle cx="16" cy="16" r="2.2"/></svg>';
  const ICON_CAL = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>';
  const ICON_PERSON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.5-7 8-7s8 3 8 7"/></svg>';

  const GRAD_CLASSES = ['debt-grad-1', 'debt-grad-2', 'debt-grad-3'];

  // Which month the mini calendar grid is currently showing. Kept in module
  // scope so it survives re-renders (e.g. paying off a debt elsewhere) but
  // resets on page reload — that's fine, it just starts back on this month.
  let calendarMonth = new Date();

  // Debts now live in the database, requiring login — same login-gate +
  // syncedForUserId pattern used for PayLater/Accounts/Planner/Transactions.
  function isLoggedIn() {
    return !!(Monetra.auth && Monetra.auth.isLoggedIn());
  }
  let syncedForUserId = null;

  function buildDueMap(debts) {
    const map = {};
    (debts || []).forEach((d) => {
      (d.schedule || []).forEach((r) => {
        if (!r.date) return;
        if (!map[r.date]) map[r.date] = [];
        map[r.date].push({ debtName: d.name, amount: r.amount, currency: d.currency, paid: !!r.paid });
      });
    });
    return map;
  }

  // Stats for the top KPI row: total remaining debt, this month's total
  // scheduled payments, this month's still-unpaid total, and the next
  // unpaid payment due across every debt.
  function computeStats(state, disp) {
    const today = Monetra.storage.todayISO();
    const monthPrefix = today.slice(0, 7);
    let totalDebtDisp = 0;
    let monthlyDisp = 0;
    let dueThisMonthDisp = 0;
    let nextEntry = null;

    (state.debts || []).forEach((d) => {
      totalDebtDisp += Monetra.currency.convert(d.currentDebt, d.currency, disp);
      (d.schedule || []).forEach((r) => {
        if (r.date && r.date.slice(0, 7) === monthPrefix) {
          const conv = Monetra.currency.convert(r.amount, d.currency, disp);
          monthlyDisp += conv;
          if (!r.paid) dueThisMonthDisp += conv;
        }
        if (!r.paid && r.date && (!nextEntry || r.date < nextEntry.date)) {
          nextEntry = { date: r.date, amount: r.amount, currency: d.currency, debtName: d.name };
        }
      });
    });

    return { totalDebtDisp, monthlyDisp, dueThisMonthDisp, nextEntry, monthPrefix };
  }

  function buildKpiHtml(stats, disp) {
    const monthName = new Date(stats.monthPrefix + '-01T00:00:00').toLocaleString('en-US', { month: 'long' });
    return `
      <div class="debts-kpis">
        <div class="debt-kpi">
          <div class="debt-kpi-icon kpi-blue">${ICON_GRID}</div>
          <div>
            <div class="debt-kpi-label">Total Debt</div>
            <div class="debt-kpi-value">${Monetra.storage.formatMoney(stats.totalDebtDisp, disp)}</div>
            <div class="debt-kpi-sub">Total outstanding</div>
          </div>
        </div>
        <div class="debt-kpi">
          <div class="debt-kpi-icon kpi-green">${ICON_WALLET}</div>
          <div>
            <div class="debt-kpi-label">Monthly EMI</div>
            <div class="debt-kpi-value">${Monetra.storage.formatMoney(stats.monthlyDisp, disp)}</div>
            <div class="debt-kpi-sub">Total monthly payment</div>
          </div>
        </div>
        <div class="debt-kpi">
          <div class="debt-kpi-icon kpi-orange">${ICON_CAL_DOT}</div>
          <div>
            <div class="debt-kpi-label">Due This Month</div>
            <div class="debt-kpi-value">${Monetra.storage.formatMoney(stats.dueThisMonthDisp, disp)}</div>
            <div class="debt-kpi-sub">Total due in ${monthName}</div>
          </div>
        </div>
        <div class="debt-kpi">
          <div class="debt-kpi-icon kpi-violet">${ICON_CAL}</div>
          <div>
            <div class="debt-kpi-label">Next Payment</div>
            <div class="debt-kpi-value">${stats.nextEntry ? formatDate(stats.nextEntry.date) : '—'}</div>
            <div class="debt-kpi-sub">Next payment date</div>
          </div>
        </div>
      </div>`;
  }

  function buildUpcomingAgendaHtml(debts) {
    const today = Monetra.storage.todayISO();
    const entries = [];
    (debts || []).forEach((d) => {
      (d.schedule || []).forEach((r) => {
        if (r.date && !r.paid && r.date >= today) entries.push({ date: r.date, debtName: d.name, amount: r.amount, currency: d.currency });
      });
    });
    entries.sort((a, b) => (a.date < b.date ? -1 : 1));
    const top = entries.slice(0, 5);
    const title = top.length ? 'Upcoming in ' + new Date(top[0].date + 'T00:00:00').toLocaleString('en-US', { month: 'long' }) : 'Upcoming';
    const rows = top.length
      ? top.map((x) => `
        <div class="debt-cal-agenda-row">
          <span class="debt-cal-agenda-date">${formatDate(x.date)}</span>
          <span class="debt-cal-agenda-name">${escape(x.debtName)}</span>
          <span class="debt-cal-agenda-amount">${Monetra.storage.formatMoney(x.amount, x.currency)}</span>
        </div>`).join('')
      : `<div class="empty-state" style="padding:12px 0;">No upcoming payments.</div>`;
    return `
      <div class="debt-cal-agenda">
        <div class="debt-cal-agenda-title">${title}</div>
        ${rows}
        <a href="#debtFullTable" class="panel-link debt-cal-view-full" id="viewFullScheduleLink">View full schedule →</a>
      </div>`;
  }

  function buildCalendarHtml(debts) {
    const dueMap = buildDueMap(debts);
    const year = calendarMonth.getFullYear();
    const month = calendarMonth.getMonth();
    const firstDay = new Date(year, month, 1);
    const startWeekday = firstDay.getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const monthLabel = firstDay.toLocaleString('en-US', { month: 'long', year: 'numeric' });
    const todayISO = Monetra.storage.todayISO();
    const monthPrefix = year + '-' + pad2(month + 1);

    const weekdayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    let cells = '';
    for (let i = 0; i < startWeekday; i++) cells += `<div class="debt-cal-day empty"></div>`;
    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = monthPrefix + '-' + pad2(day);
      const due = dueMap[dateStr] || [];
      const hasUnpaid = due.some((x) => !x.paid);
      const hasAny = due.length > 0;
      const isToday = dateStr === todayISO;
      let cls = 'debt-cal-day';
      if (isToday) cls += ' today';
      if (hasUnpaid) cls += ' has-due';
      else if (hasAny) cls += ' has-paid';
      const title = due.length
        ? due.map((x) => `${x.debtName}: ${Monetra.storage.formatMoney(x.amount, x.currency)}${x.paid ? ' (paid)' : ''}`).join(' | ')
        : '';
      cells += `<div class="${cls}"${title ? ` title="${escape(title)}"` : ''}>
        <span class="debt-cal-num">${day}</span>
        ${hasAny ? `<span class="debt-cal-dot"></span>` : ''}
      </div>`;
    }
    const totalCells = startWeekday + daysInMonth;
    const trailing = (7 - (totalCells % 7)) % 7;
    for (let i = 0; i < trailing; i++) cells += `<div class="debt-cal-day empty"></div>`;

    return `
      <div class="debt-cal">
        <div class="debt-cal-header">
          <button type="button" class="btn btn-ghost btn-sm" id="calPrevBtn">‹</button>
          <div class="debt-cal-month">${monthLabel}</div>
          <button type="button" class="btn btn-ghost btn-sm" id="calNextBtn">›</button>
        </div>
        <div class="debt-cal-grid">
          ${weekdayLabels.map((w) => `<div class="debt-cal-weekday">${w}</div>`).join('')}
          ${cells}
        </div>
        ${buildUpcomingAgendaHtml(debts)}
      </div>`;
  }

  // A full table of every payment across every debt — dated entries sorted
  // chronologically first, then entries with no known date grouped below.
  function buildDebtTableHtml(debts) {
    const dated = [];
    const undated = [];
    (debts || []).forEach((d) => {
      (d.schedule || []).forEach((r) => {
        const entry = { debtName: d.name, amount: r.amount, currency: d.currency, paid: !!r.paid, date: r.date || '' };
        if (r.date) dated.push(entry);
        else undated.push(entry);
      });
    });
    dated.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    const rowHtml = (x, dateLabel) => `
      <tr class="${x.paid ? 'paid' : ''}">
        <td>${dateLabel}</td>
        <td>${escape(x.debtName)}</td>
        <td>${Monetra.storage.formatMoney(x.amount, x.currency)}</td>
        <td>${x.paid ? 'Paid' : 'Due'}</td>
      </tr>`;

    const datedRowsHtml = dated.map((x) => rowHtml(x, formatDate(x.date))).join('');
    const undatedRowsHtml = undated.map((x) => rowHtml(x, 'No due date')).join('');

    if (!dated.length && !undated.length) {
      return `<div class="debt-table"><div class="panel-title">All payments</div><div class="empty-state" style="padding:24px 10px;">No payments added yet.</div></div>`;
    }

    return `
      <div class="debt-table" style="max-width:none;">
        <div class="panel-title">All payments</div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>Date</th><th>Debt</th><th>Amount</th><th>Status</th></tr>
            </thead>
            <tbody>
              ${datedRowsHtml}
              ${undatedRowsHtml ? `<tr class="debt-table-divider"><td colspan="4">No due date</td></tr>${undatedRowsHtml}` : ''}
            </tbody>
          </table>
        </div>
      </div>`;
  }

  function buildProgressPanelHtml(debts) {
    const rows = (debts || []).map((d) => {
      const total = parseFloat(d.totalDebt) || 0;
      const remaining = parseFloat(d.currentDebt) || 0;
      const pct = total > 0 ? Math.max(0, Math.min(100, ((total - remaining) / total) * 100)) : 0;
      return `
        <div class="debt-progress-row">
          <div class="debt-progress-name">${escape(d.name)}</div>
          <div class="meter"><div class="meter-fill" style="width:${pct.toFixed(0)}%; background: var(--good);"></div></div>
          <div class="debt-progress-pct">${pct.toFixed(0)}%</div>
          <div class="debt-progress-frac">${Monetra.storage.formatMoney(remaining, d.currency)} / ${Monetra.storage.formatMoney(total, d.currency)}</div>
        </div>`;
    }).join('');
    return `
      <div class="card debt-progress-panel">
        <div class="panel-title">Debt Progress</div>
        ${rows || `<div class="empty-state" style="padding:20px 0;">No debts yet.</div>`}
      </div>`;
  }

  function buildUpcomingPanelHtml(debts) {
    const today = Monetra.storage.todayISO();
    const entries = [];
    (debts || []).forEach((d) => {
      (d.schedule || []).forEach((r) => {
        if (r.date && !r.paid) entries.push({ date: r.date, debtName: d.name, amount: r.amount, currency: d.currency });
      });
    });
    entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const top = entries.slice(0, 6);
    const rowsHtml = top.map((x) => {
      const daysAway = Math.round((new Date(x.date + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400000);
      let pillClass = 'pill-neutral', pillLabel = 'Upcoming';
      if (daysAway < 0) { pillClass = 'pill-overdue'; pillLabel = 'Overdue'; }
      else if (daysAway <= 7) { pillClass = 'pill-unpaid'; pillLabel = 'Due Soon'; }
      return `<tr>
        <td>${formatDate(x.date)}</td>
        <td>${escape(x.debtName)}</td>
        <td>${Monetra.storage.formatMoney(x.amount, x.currency)}</td>
        <td><span class="pill ${pillClass}">${pillLabel}</span></td>
      </tr>`;
    }).join('');
    return `
      <div class="card debt-upcoming-panel">
        <div class="panel-title-row">
          <div class="panel-title">Upcoming Payments</div>
          <a href="#debtFullTable" class="panel-link" id="viewAllPaymentsLink">View all →</a>
        </div>
        ${top.length ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Debt</th><th>EMI Amount</th><th>Status</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>` : `<div class="empty-state" style="padding:20px 0;">No upcoming payments.</div>`}
      </div>`;
  }

  function debtCard2Html(d, idx, disp) {
    const grad = GRAD_CLASSES[idx % GRAD_CLASSES.length];
    const next = nextUnpaidDated(d);
    const remainingCount = (d.schedule || []).filter((r) => !r.paid).length;
    return `
      <div class="debt-card2 ${grad}" data-id="${d.id}">
        <div class="debt-card2-top">
          <span class="card-type-pill">DEBT</span>
          <div class="debt-card2-menu-wrap">
            <button type="button" class="debt-card2-menu" data-action="menu">⋮</button>
            <div class="debt-card2-menu-dropdown">
              <button type="button" data-action="edit">Edit</button>
              <button type="button" data-action="delete">Delete</button>
            </div>
          </div>
        </div>
        <div class="debt-card2-name">${escape(d.name)}</div>
        ${d.notes ? `<div class="debt-card2-sub">${escape(d.notes)}</div>` : ''}
        <div class="debt-card2-avatar-row">
          <div class="debt-card2-avatar">${ICON_PERSON}</div>
          <div>
            <div class="debt-card2-label">Remaining Amount</div>
            <div class="debt-card2-amount">${Monetra.storage.formatMoney(d.currentDebt, d.currency)}</div>
          </div>
        </div>
        <div class="debt-card2-divider"></div>
        <div class="debt-card2-row2">
          <div>
            <div class="debt-card2-label">Next Payment</div>
            <div class="debt-card2-value">${next ? Monetra.storage.formatMoney(next.amount, d.currency) : '—'}</div>
          </div>
          <div>
            <div class="debt-card2-label">Due Date</div>
            <div class="debt-card2-value">${next ? formatDate(next.date) : 'No due date'}</div>
          </div>
        </div>
        <div class="debt-card2-label" style="margin-top:12px;">Payments Left</div>
        <div class="debt-card2-value-lg">${remainingCount} payment${remainingCount === 1 ? '' : 's'}</div>
        <button type="button" class="debt-card2-details-btn" data-action="details">View details →</button>
      </div>`;
  }

  // Close any open card menu when clicking elsewhere on the page. Registered
  // once at module load (not inside render) so it never stacks up.
  document.addEventListener('click', (e) => {
    if (e.target.closest('.debt-card2-menu-wrap')) return;
    document.querySelectorAll('.debt-card2-menu-dropdown.open').forEach((el) => el.classList.remove('open'));
  });

  function render() {
    const el = document.getElementById('tab-debts');
    if (!el) return;

    if (!isLoggedIn()) {
      syncedForUserId = null;
      el.innerHTML = `
        <div class="section-header"><div><h2>Debts</h2></div></div>
        <div class="card" style="max-width:520px;">
          <h3 style="margin-top:0;">Log in to use Debts</h3>
          <p class="hint" style="margin-top:0;">Your debts and payment schedules are saved to your Monetra account, not this browser — so you'll need to be logged in to add or view them. Everything else in Monetra still works without logging in.</p>
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
      // account's debts, cached from before that account logged out (the
      // same class of bug already fixed once for the Settings API keys).
      // Show a loading state and only draw real cards once the server has
      // answered for whoever is actually logged in right now.
      el.innerHTML = `<div class="section-header"><div><h2>Debts</h2></div></div><div class="hint">Loading your debts…</div>`;
      Monetra.auth.authFetch('/api/debts', { method: 'GET' })
        .then((result) => {
          const state = Monetra.storage.getState();
          state.debts = result.debts || [];
          Monetra.storage.save();
          syncedForUserId = userId;
          Monetra.app.renderAll();
        })
        .catch((err) => {
          el.innerHTML = `<div class="section-header"><div><h2>Debts</h2></div></div><div class="hint" style="color:var(--critical);">Could not load your debts: ${escape(err.message)}</div>`;
        });
      return;
    }

    renderList(el);
  }

  function renderList(el) {
    const state = Monetra.storage.getState();
    const disp = state.settings.displayCurrency;

    const sorted = sortDebtsForDisplay(state.debts);
    const stats = computeStats(state, disp);
    const kpiHtml = buildKpiHtml(stats, disp);
    const calendarHtml = buildCalendarHtml(state.debts);
    const cardsHtml = sorted.length
      ? sorted.map((d, i) => debtCard2Html(d, i, disp)).join('')
      : `<div class="empty-state" style="padding:30px 0;">No debts yet. Click "+ Add debt" to get started.</div>`;
    const progressHtml = buildProgressPanelHtml(sorted);
    const upcomingHtml = buildUpcomingPanelHtml(state.debts);
    const tableHtml = buildDebtTableHtml(state.debts);

    el.innerHTML = `
      <div class="section-header">
        <div>
          <h2>Debts</h2>
          <p class="section-subtitle">Track and manage all your loans and debts</p>
        </div>
        <button class="btn btn-primary btn-sm" id="addDebtBtn">+ Add debt</button>
      </div>

      ${kpiHtml}

      <div class="debts-columns">
        <div class="debts-column">${calendarHtml}</div>
        <div class="debts-column">
          <div class="debts-cards-row">${cardsHtml}</div>
        </div>
      </div>

      <div class="debts-bottom-row">
        ${progressHtml}
        ${upcomingHtml}
      </div>

      <div id="debtFullTable" style="margin-top:24px;">${tableHtml}</div>
    `;

    document.getElementById('calPrevBtn').onclick = () => {
      calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1);
      render();
    };
    document.getElementById('calNextBtn').onclick = () => {
      calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1);
      render();
    };

    ['viewFullScheduleLink', 'viewAllPaymentsLink'].forEach((linkId) => {
      const link = document.getElementById(linkId);
      if (link) link.addEventListener('click', (e) => {
        e.preventDefault();
        const target = document.getElementById('debtFullTable');
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });

    document.getElementById('addDebtBtn').onclick = () => openForm();

    el.querySelectorAll('.debt-card2').forEach((card) => {
      const id = card.dataset.id;
      const dropdown = card.querySelector('.debt-card2-menu-dropdown');
      card.querySelector('[data-action="menu"]').addEventListener('click', (e) => {
        e.stopPropagation();
        const wasOpen = dropdown.classList.contains('open');
        document.querySelectorAll('.debt-card2-menu-dropdown.open').forEach((d) => d.classList.remove('open'));
        if (!wasOpen) dropdown.classList.add('open');
      });
      card.querySelector('[data-action="edit"]').addEventListener('click', (e) => {
        e.stopPropagation();
        dropdown.classList.remove('open');
        openForm(id);
      });
      card.querySelector('[data-action="delete"]').addEventListener('click', (e) => {
        e.stopPropagation();
        dropdown.classList.remove('open');
        if (confirm('Delete this debt? This cannot be undone.')) {
          Monetra.auth.authFetch('/api/debts/' + id, { method: 'DELETE' })
            .then(() => {
              syncedForUserId = null; // force a fresh refetch
              Monetra.app.renderAll();
            })
            .catch((err) => alert('Could not delete that debt: ' + err.message));
        }
      });
      card.querySelector('[data-action="details"]').addEventListener('click', (e) => {
        e.stopPropagation();
        openDetails(id);
      });
    });
  }

  // Toggles one schedule row's paid state on the server, then patches the
  // local cache with the server's authoritative (recomputed currentDebt,
  // updated row) response — no need to invalidate syncedForUserId/refetch,
  // since the response already reflects the true new state. Returns a
  // Promise so callers (the "View details" modal) can redraw once it lands.
  function togglePaid(debtId, scheduleId, paid) {
    return Monetra.auth.authFetch(`/api/debts/${debtId}/schedule/${scheduleId}`, { method: 'PUT', body: JSON.stringify({ paid }) })
      .then((result) => {
        const state = Monetra.storage.getState();
        const idx = state.debts.findIndex((d) => d.id === debtId);
        if (idx !== -1 && result.debt) state.debts[idx] = result.debt;
        Monetra.storage.save();
        return result.debt;
      });
  }

  // Read-only-ish "View details" modal: full schedule with paid checkboxes
  // (so the core paid/unpaid toggle stays reachable without editing), plus
  // a shortcut into the edit form.
  function openDetails(id) {
    const disp = Monetra.storage.getState().settings.displayCurrency;

    function bodyHtml() {
      const dd = Monetra.storage.getState().debts.find((x) => x.id === id);
      if (!dd) return '<p>This debt was deleted.</p>';
      const remainingDisp = Monetra.currency.convert(dd.currentDebt, dd.currency, disp);
      const { known, unknown } = splitSchedule(dd.schedule);
      return `
        <div class="back-rows" style="max-height:none;">
          <div class="back-row"><span class="back-label">Total debt</span><span>${Monetra.storage.formatMoney(dd.totalDebt, dd.currency)}</span></div>
          <div class="back-row"><span class="back-label">Remaining</span><span>${Monetra.storage.formatMoney(dd.currentDebt, dd.currency)}</span></div>
          <div class="back-row"><span class="back-label">Currency</span><span>${dd.currency}</span></div>
          ${dd.currency !== disp ? `<div class="back-row"><span class="back-label">≈ ${disp}</span><span>${Monetra.storage.formatMoney(remainingDisp, disp)}</span></div>` : ''}
          ${dd.notes ? `<div class="back-row"><span class="back-label">Notes</span><span>${escape(dd.notes)}</span></div>` : ''}
          <div class="back-row"><span class="back-label">Payment schedule</span><span></span></div>
          <div class="schedule-columns">
            <div class="schedule-col"><div class="schedule-col-title">Date known</div>${scheduleMiniHtml(known, dd.currency, 'None')}</div>
            <div class="schedule-col"><div class="schedule-col-title">Date unknown</div>${scheduleMiniHtml(unknown, dd.currency, 'None')}</div>
          </div>
        </div>`;
    }

    const debt = Monetra.storage.getState().debts.find((x) => x.id === id);
    if (!debt) return;

    const html = `
      <h2>${escape(debt.name)}</h2>
      <div id="debtDetailsBody">${bodyHtml()}</div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="detailsCloseBtn">Close</button>
        <button type="button" class="btn btn-primary" id="detailsEditBtn">Edit</button>
      </div>`;

    Monetra.modal.open(html, (root) => {
      function wireCheckboxes() {
        root.querySelectorAll('[data-schedule-id]').forEach((cb) => {
          cb.addEventListener('change', () => {
            const wasChecked = cb.checked;
            cb.disabled = true;
            togglePaid(id, cb.dataset.scheduleId, wasChecked)
              .then(() => {
                const bodyEl = root.querySelector('#debtDetailsBody');
                if (bodyEl) { bodyEl.innerHTML = bodyHtml(); wireCheckboxes(); }
                // Redraws the main Debts tab (cards/KPIs) behind the modal
                // from the already-patched local cache — syncedForUserId is
                // unchanged, so this doesn't trigger another server fetch.
                Monetra.app.renderAll();
              })
              .catch((err) => {
                cb.disabled = false;
                cb.checked = !wasChecked;
                alert('Could not update that payment: ' + err.message);
              });
          });
        });
      }
      wireCheckboxes();
      root.querySelector('#detailsCloseBtn').onclick = () => Monetra.modal.close();
      root.querySelector('#detailsEditBtn').onclick = () => { Monetra.modal.close(); openForm(id); };
    });
  }

  function openForm(id) {
    const state = Monetra.storage.getState();
    const existing = id ? state.debts.find((d) => d.id === id) : null;
    // Working copy of schedule rows for the row-builder UI; only committed
    // to the debt on form submit.
    let scheduleRows = existing ? (existing.schedule || []).map((r) => Object.assign({}, r)) : [];

    const html = `
      <h2>${existing ? 'Edit debt' : 'Add debt'}</h2>
      <form id="debtForm">
        <div class="form-row"><label>Name</label><input name="name" required value="${existing ? escape(existing.name) : ''}" placeholder="e.g. Car loan, Home loan, Personal loan"></div>
        <div class="form-grid-2">
          <div class="form-row"><label>Total debt</label><input name="totalDebt" type="number" step="0.01" required value="${existing ? existing.totalDebt : ''}"></div>
          <div class="form-row"><label>Currency</label>
            <select name="currency">${Monetra.storage.CURRENCIES.map((c) => `<option value="${c}" ${existing && existing.currency === c ? 'selected' : (!existing && c === state.settings.displayCurrency ? 'selected' : '')}>${c}</option>`).join('')}</select>
          </div>
        </div>
        <div class="form-row"><label>Notes (optional)</label><input name="notes" value="${existing ? escape(existing.notes || '') : ''}"></div>

        <div class="form-row">
          <label>Payment schedule</label>
          <div class="hint">Build the payment schedule manually — enter an amount and add it. The due date is optional; leave it blank for payments with no fixed date.</div>
          <div id="scheduleRowsContainer"></div>
          <div class="form-grid-2" style="margin-top: 8px;">
            <div class="form-row" style="margin-bottom:0;"><label style="font-weight:400;">Due date (optional)</label><input type="date" id="newScheduleDate"></div>
            <div class="form-row" style="margin-bottom:0;"><label style="font-weight:400;">Amount</label><input type="number" step="0.01" id="newScheduleAmount" placeholder="Amount"></div>
          </div>
          <button type="button" class="btn btn-ghost btn-sm" id="addScheduleBtn" style="margin-top:8px;">+ Add payment</button>
        </div>

        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" id="cancelBtn">Cancel</button>
          <button type="submit" class="btn btn-primary">${existing ? 'Save changes' : 'Add debt'}</button>
        </div>
      </form>`;

    Monetra.modal.open(html, (root) => {
      const rowsContainer = root.querySelector('#scheduleRowsContainer');

      function renderRows() {
        const sorted = sortSchedule(scheduleRows);
        rowsContainer.innerHTML = sorted.length
          ? sorted.map((row) => `
            <div class="back-row schedule-row" data-row-id="${row.id}">
              <span>${formatDate(row.date)}${row.paid ? ' · paid' : ''}</span>
              <span style="display:flex; align-items:center; gap:8px;">
                <span>${row.amount}</span>
                <button type="button" class="btn btn-ghost btn-sm" data-remove-row="${row.id}">Remove</button>
              </span>
            </div>`).join('')
          : `<div class="back-row"><span class="back-label">No payments added yet</span><span></span></div>`;

        rowsContainer.querySelectorAll('[data-remove-row]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const rid = btn.dataset.removeRow;
            scheduleRows = scheduleRows.filter((r) => r.id !== rid);
            renderRows();
          });
        });
      }
      renderRows();

      root.querySelector('#addScheduleBtn').addEventListener('click', () => {
        const dateInput = root.querySelector('#newScheduleDate');
        const amountInput = root.querySelector('#newScheduleAmount');
        const date = dateInput.value || '';
        const amount = parseFloat(amountInput.value);
        if (isNaN(amount)) {
          alert('Enter an amount before adding.');
          return;
        }
        scheduleRows.push({ id: Monetra.storage.uid('sch'), date, amount, paid: false });
        dateInput.value = '';
        amountInput.value = '';
        renderRows();
      });

      root.querySelector('#cancelBtn').onclick = () => Monetra.modal.close();
      root.querySelector('#debtForm').onsubmit = (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const data = {
          name: fd.get('name').trim(),
          totalDebt: parseFloat(fd.get('totalDebt')),
          currency: fd.get('currency'),
          notes: fd.get('notes').trim(),
          // currentDebt is always recomputed server-side from the schedule's
          // paid rows — only date/amount/paid are sent per row, dropping the
          // client-only 'id' used to key the row-builder UI above.
          schedule: scheduleRows.map((r) => ({ date: r.date || null, amount: r.amount, paid: !!r.paid }))
        };

        const submitBtn = root.querySelector('#debtForm button[type="submit"]');
        submitBtn.disabled = true;
        const req = existing
          ? Monetra.auth.authFetch('/api/debts/' + existing.id, { method: 'PUT', body: JSON.stringify(data) })
          : Monetra.auth.authFetch('/api/debts', { method: 'POST', body: JSON.stringify(data) });
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

  // buildProgressPanelHtml/sortDebtsForDisplay are also exported so the
  // Dashboard can render its own copy of the Debt Progress panel from the
  // same real debt data — it's markup-only (no canvas), so it can be
  // embedded as-is with no id collision risk.
  Monetra.debts = { render, buildProgressPanelHtml, sortDebtsForDisplay };
})();
