window.Monetra = window.Monetra || {};

(function () {
  function escape(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

  function render() {
    const el = document.getElementById('tab-settings');
    const state = Monetra.storage.getState();
    const missing = Monetra.calc.unconvertedCurrencies(state.settings.displayCurrency);
    // Once logged in, the two API keys are account-bound — the server is
    // the only source of truth for them. Never pre-fill from local storage
    // in that case (it may still hold a *different* account's key, cached
    // from before that account logged out); start blank/loading and let the
    // GET /api/settings fetch below fill in the real value for whoever is
    // actually logged in right now.
    const isLoggedIn = !!(Monetra.auth && Monetra.auth.isLoggedIn());
    const twelveVal = isLoggedIn ? '' : (state.settings.twelveDataApiKey || '');
    const alphaVal = isLoggedIn ? '' : (state.settings.alphaVantageApiKey || '');
    const overrides = state.exchangeRates.manualOverrides || {};
    const overrideRows = Object.keys(overrides).map((code) => `
      <div class="back-row" data-code="${escape(code)}">
        <span class="back-label">1 EUR = ${overrides[code]} ${escape(code)}</span>
        <button class="btn btn-ghost btn-sm" data-action="removeOverride">Remove</button>
      </div>`).join('');

    el.innerHTML = `
      <div class="card settings-block">
        <h3>Display currency</h3>
        <select id="settingsCurrency">${Monetra.storage.CURRENCIES.map((c) => `<option value="${c}" ${state.settings.displayCurrency === c ? 'selected' : ''}>${c}</option>`).join('')}</select>
        <div class="hint">Your net worth and totals are shown in this currency across the app.</div>
      </div>

      <div class="card settings-block">
        <h3>Exchange rates</h3>
        <div class="small muted">
          Status: ${state.exchangeRates.updated ? `fetched from ${escape(state.exchangeRates.source || 'unknown source')} · ${new Date(state.exchangeRates.updated).toLocaleString()}` : 'never fetched successfully'}
        </div>
        ${missing.length ? `<div class="small" style="color:var(--critical); margin-top:4px;">No rate available for: ${missing.join(', ')} — these balances won't convert correctly until fixed below or by a successful refresh.</div>` : ''}
        <div style="margin-top:10px;"><button class="btn btn-ghost btn-sm" id="refreshRatesBtn">Refresh exchange rates now</button></div>
        <div class="hint">Rates are pulled automatically from <a href="https://www.frankfurter.app" target="_blank" rel="noopener">frankfurter.app</a> (ECB reference rates), falling back to <a href="https://www.exchangerate-api.com" target="_blank" rel="noopener">open.er-api.com</a> if that's unreachable — both free, no signup. If your network blocks both (common on some corporate/school Wi-Fi or with certain browser extensions), add a manual rate below as a reliable fallback.</div>

        <h3 style="margin-top:20px;">Manual rate overrides</h3>
        <div class="hint" style="margin-top:0;">A manual rate always takes priority over the automatically fetched one for that currency — use this if live rates can't reach your browser, or if you just want to fix a rate yourself.</div>
        ${overrideRows ? `<div style="margin-top:10px;">${overrideRows}</div>` : ''}
        <form id="overrideForm" class="form-grid-2" style="margin-top:12px; align-items:end;">
          <div class="form-row"><label>Currency code</label><input name="code" placeholder="e.g. INR" maxlength="3" required></div>
          <div class="form-row"><label>1 EUR = ___ (this currency)</label><input name="rate" type="number" step="0.0001" min="0" placeholder="e.g. 90.5" required></div>
          <div class="form-row" style="grid-column: span 2;"><button type="submit" class="btn btn-ghost btn-sm">Save manual rate</button></div>
        </form>
      </div>

      <div class="card settings-block">
        <h3>Live stock prices</h3>
        <div class="form-row" style="max-width:420px;"><label>Twelve Data API key <span class="muted small">— international (US) stocks</span></label><input id="settingsApiKey" type="text" value="${escape(twelveVal)}" placeholder="${isLoggedIn ? 'Loading your saved key…' : 'Paste your free API key'}"></div>
        <button class="btn btn-ghost btn-sm" id="saveApiKeyBtn">Save key</button>
        <div class="hint">Get a free key at <a href="https://twelvedata.com/pricing" target="_blank" rel="noopener">twelvedata.com</a>. Covers international exchanges (NASDAQ, NYSE — e.g. <code>AAPL</code>, <code>MSFT</code>) on the free tier. Their free tier does <strong>not</strong> include NSE/BSE (Indian) data — that's a paid-only add-on there, which is why the Alpha Vantage key below exists instead.</div>

        <div class="form-row" style="max-width:420px; margin-top:16px;"><label>Alpha Vantage API key <span class="muted small">— Indian (NSE/BSE) stocks</span></label><input id="settingsAlphaKey" type="text" value="${escape(alphaVal)}" placeholder="${isLoggedIn ? 'Loading your saved key…' : 'Paste your free API key'}"></div>
        <button class="btn btn-ghost btn-sm" id="saveAlphaKeyBtn">Save key</button>
        <div class="hint">Get a free key at <a href="https://www.alphavantage.co/support/#api-key" target="_blank" rel="noopener">alphavantage.co</a> (instant, no card). Used as the fallback for symbols tagged NSE or BSE, since Twelve Data's free tier can't serve those. Their free tier is capped at 25 requests/day and only documents Indian coverage via the <code>.BSE</code> suffix — treat this as best-effort, not guaranteed to work for every symbol. If it fails, or you'd rather not add a second key, you can always type the current price in manually.</div>

        <div class="hint" style="margin-top:12px;">Once a key is saved, use "Refresh prices" on the Investments tab to pull the latest quotes for every holding, or "Fetch price &amp; details" when adding one. Without any key you can still update each stock's price manually at any time.</div>
      </div>

      <div class="card settings-block">
        <h3>Your data</h3>
        <div class="hint" style="margin-top:0;">Everything except your two stock-price API keys above is stored locally in this browser only — nothing else is sent to a server. Those two keys sync to your Monetra account when you're logged in, so they follow you and stay private to your account. Export a backup regularly, especially before clearing browser data.</div>
        <div style="display:flex; gap:10px; margin-top:12px; flex-wrap:wrap;">
          <button class="btn btn-ghost btn-sm" id="exportBtn">Export data (.json)</button>
          <label class="btn btn-ghost btn-sm" style="cursor:pointer;">Import data
            <input type="file" id="importInput" accept="application/json" style="display:none;">
          </label>
          <button class="btn btn-danger btn-sm" id="resetBtn">Reset all data</button>
        </div>
      </div>
    `;

    document.getElementById('settingsCurrency').onchange = (e) => {
      state.settings.displayCurrency = e.target.value;
      Monetra.storage.save();
      Monetra.app.renderAll();
    };

    document.getElementById('refreshRatesBtn').onclick = async () => {
      const btn = document.getElementById('refreshRatesBtn');
      btn.disabled = true; btn.textContent = 'Refreshing…';
      try { await Monetra.currency.fetchRates(); } catch (e) { alert('Could not refresh rates: ' + e.message); }
      Monetra.app.renderAll();
    };

    document.getElementById('overrideForm').onsubmit = (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const code = (fd.get('code') || '').toString().trim().toUpperCase();
      const rate = parseFloat(fd.get('rate'));
      if (!code || !rate || rate <= 0) return;
      Monetra.currency.setManualRate(code, rate);
      Monetra.app.renderAll();
    };

    el.querySelectorAll('[data-action="removeOverride"]').forEach((btn) => {
      btn.onclick = () => {
        const code = btn.closest('[data-code]').dataset.code;
        Monetra.currency.removeManualRate(code);
        Monetra.app.renderAll();
      };
    });

    document.getElementById('saveApiKeyBtn').onclick = () => saveKey('twelveDataApiKey', 'settingsApiKey', 'saveApiKeyBtn', 'Twelve Data API key saved.');
    document.getElementById('saveAlphaKeyBtn').onclick = () => saveKey('alphaVantageApiKey', 'settingsAlphaKey', 'saveAlphaKeyBtn', 'Alpha Vantage API key saved.');

    // If logged in, the account on the Monetra server is the ONLY source of
    // truth for these two keys (that's the whole point — so admin2 never
    // sees admin1's keys). Always set the fields from the response, even
    // when a key comes back empty — a logged-in account with no saved key
    // must show a blank field, never whatever happens to be cached locally
    // from a previously-logged-in account on this same browser.
    if (isLoggedIn) {
      Monetra.auth.authFetch('/api/settings', { method: 'GET' })
        .then((result) => {
          const s = result.settings || {};
          state.settings.twelveDataApiKey = s.twelveDataApiKey || '';
          state.settings.alphaVantageApiKey = s.alphaVantageApiKey || '';
          const inp1 = document.getElementById('settingsApiKey');
          if (inp1) { inp1.value = state.settings.twelveDataApiKey; inp1.placeholder = 'Paste your free API key'; }
          const inp2 = document.getElementById('settingsAlphaKey');
          if (inp2) { inp2.value = state.settings.alphaVantageApiKey; inp2.placeholder = 'Paste your free API key'; }
          Monetra.storage.save();
        })
        .catch((err) => {
          // Couldn't reach the server — leave the fields blank rather than
          // risk showing a stale/wrong-account value; swap the placeholder
          // back so it doesn't say "Loading…" forever.
          const inp1 = document.getElementById('settingsApiKey');
          if (inp1) inp1.placeholder = 'Paste your free API key (could not load your saved key — ' + err.message + ')';
          const inp2 = document.getElementById('settingsAlphaKey');
          if (inp2) inp2.placeholder = 'Paste your free API key (could not load your saved key)';
        });
    }

    document.getElementById('exportBtn').onclick = exportData;

    document.getElementById('importInput').onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(reader.result);
          if (!confirm('Import this file? It will replace all current data.')) return;
          Monetra.storage.replaceState(Object.assign(Monetra.storage.defaultState(), parsed));
          Monetra.app.renderAll();
          alert('Data imported.');
        } catch (err) {
          alert('That file could not be read as valid Monetra data.');
        }
      };
      reader.readAsText(file);
    };

    document.getElementById('resetBtn').onclick = () => resetAllData();
  }

  // Saves one API key locally (as always) and, if logged in, also syncs it
  // to the account on the Monetra server via PUT /api/settings — that's what
  // makes it private per account instead of shared by whoever opens this
  // browser. Not logged in (or server unreachable) just falls back to the
  // local-only behavior this already had.
  function saveKey(settingsField, inputId, btnId, savedMessage) {
    const state = Monetra.storage.getState();
    const value = document.getElementById(inputId).value.trim();
    state.settings[settingsField] = value;
    Monetra.storage.save();
    Monetra.app.renderAll();

    if (Monetra.auth && Monetra.auth.isLoggedIn()) {
      const btn = document.getElementById(btnId);
      const body = {};
      body[settingsField] = value;
      Monetra.auth.authFetch('/api/settings', { method: 'PUT', body: JSON.stringify(body) })
        .then(() => alert(savedMessage))
        .catch((err) => alert(savedMessage + ' (saved in this browser, but could not sync to your account: ' + err.message + ')'));
    } else {
      alert(savedMessage);
    }
  }

  // Shared with the Profile tab's "Export backup" action, so both call the
  // exact same real export logic instead of duplicating it.
  function exportData() {
    const blob = new Blob([JSON.stringify(Monetra.storage.getState(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'monetra-backup-' + Monetra.storage.todayISO() + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // Shared with the Profile tab's "Delete account" action (same underlying
  // operation — Monetra has no server-side account, so "deleting" it just
  // means wiping this browser's local data). `redirectTo` lets a caller send
  // the user somewhere other than the reloaded (now-empty) app afterwards.
  function resetAllData(opts) {
    const redirectTo = (opts && opts.redirectTo) || null;
    if (confirm('This will permanently delete all Monetra data in this browser. Continue?') && confirm('Are you absolutely sure? This cannot be undone.')) {
      localStorage.removeItem(Monetra.storage.STORAGE_KEY);
      if (redirectTo) window.location.href = redirectTo;
      else location.reload();
    }
  }

  Monetra.settings = { render, exportData, resetAllData, saveKey };
})();
