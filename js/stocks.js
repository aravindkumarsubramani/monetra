window.Monetra = window.Monetra || {};

/* Live stock prices via Twelve Data (free tier, browser-CORS friendly).
   Requires a personal API key set in Settings. Indian exchange symbols use
   the "SYMBOL:EXCHANGE" form, e.g. "RELIANCE:NSE", "TCS:BSE". International
   symbols are plain tickers, e.g. "AAPL", "MSFT". Without a key, prices can
   still be entered and updated manually on each investment.

   Twelve Data's free tier does NOT include Indian exchange data (NSE/BSE
   are gated behind a paid plan) — international symbols (NASDAQ/NYSE etc.)
   work fine on the free tier. For NSE/BSE symbols, if a free Alpha Vantage
   key is also set, we fall back to Alpha Vantage's GLOBAL_QUOTE endpoint
   (documented to cover Indian equities via the ".BSE" suffix). Alpha
   Vantage's free tier is capped at 25 requests/day, so treat this as a
   best-effort fallback, not a guarantee — manual price entry is always
   the reliable option regardless. */
(function () {
  async function fetchQuote(symbol, apiKey) {
    if (!apiKey) throw new Error('No Twelve Data API key configured');
    const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.status === 'error' || data.code) {
      throw new Error(data.message || 'Quote request failed for ' + symbol);
    }
    const price = parseFloat(data.close ?? data.price);
    if (Number.isNaN(price)) throw new Error('No price returned for ' + symbol);
    return { price, currency: data.currency, name: data.name, percentChange: parseFloat(data.percent_change), exchange: data.exchange || null };
  }

  // Fallback for Indian symbols when Twelve Data can't serve them. `base` is
  // the ticker without any exchange suffix (e.g. "RELIANCE"); Alpha
  // Vantage's free tier documents support for the ".BSE" suffix only, so
  // that's what we query even if the holding is tagged NSE — same company,
  // same underlying price, just a different exchange listing.
  async function fetchQuoteAlphaVantage(base, apiKey) {
    if (!apiKey) throw new Error('No Alpha Vantage API key configured');
    const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(base)}.BSE&apikey=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url);
    const data = await res.json();
    const quote = data['Global Quote'];
    const priceStr = quote && quote['05. price'];
    if (!priceStr) {
      throw new Error(data['Note'] || data['Information'] || data['Error Message'] || 'No data returned for ' + base + '.BSE');
    }
    const price = parseFloat(priceStr);
    if (Number.isNaN(price)) throw new Error('No price returned for ' + base + '.BSE');
    const pctRaw = quote['10. change percent'];
    return { price, currency: 'INR', name: null, percentChange: pctRaw ? parseFloat(pctRaw.replace('%', '')) : null, exchange: 'BSE' };
  }

  // Tries Twelve Data first; for NSE/BSE-tagged symbols, falls back to
  // Alpha Vantage if that key is set and Twelve Data failed (e.g. the
  // free-plan restriction on Indian exchanges).
  async function fetchQuoteSmart(fullSymbol, twelveKey, alphaKey) {
    const idx = fullSymbol.indexOf(':');
    const base = idx === -1 ? fullSymbol : fullSymbol.slice(0, idx);
    const exchange = idx === -1 ? '' : fullSymbol.slice(idx + 1);
    const isIndian = exchange === 'NSE' || exchange === 'BSE';
    try {
      return await fetchQuote(fullSymbol, twelveKey);
    } catch (e1) {
      if (isIndian && alphaKey) {
        try {
          return await fetchQuoteAlphaVantage(base, alphaKey);
        } catch (e2) {
          throw new Error(e1.message + ' — Alpha Vantage fallback also failed: ' + e2.message);
        }
      }
      throw e1;
    }
  }

  // Investments now live in the database — this still updates state.investments
  // directly and instantly (so the UI feels unchanged), but also collects
  // every successful refresh into `updates` and pushes them to the server in
  // one bulk request at the end (see server.js's PUT /api/investments/
  // bulk-prices), same "instant locally, synced in the background" pattern
  // used for account balances in js/transactions.js. Silent on sync failure
  // (console.warn only) — a price refresh shouldn't be blocked by a
  // background sync hiccup; the Investments tab's own sync will reconcile it
  // next time it's opened anyway.
  async function refreshAll(onEach) {
    const state = Monetra.storage.getState();
    const apiKey = state.settings.twelveDataApiKey;
    const alphaKey = state.settings.alphaVantageApiKey;
    if (!apiKey && !alphaKey) throw new Error('Add a free Twelve Data (and optionally Alpha Vantage) API key in Settings to enable live stock prices.');
    let updated = 0;
    const failed = [];
    const serverUpdates = [];
    for (const inv of state.investments) {
      try {
        const q = await fetchQuoteSmart(inv.symbol, apiKey, alphaKey);
        const dayChangePercent = (q.percentChange !== null && q.percentChange !== undefined && !Number.isNaN(q.percentChange)) ? q.percentChange : null;
        const lastUpdated = new Date().toISOString();
        inv.currentPrice = q.price;
        if (q.currency) inv.currency = q.currency;
        if (q.exchange) inv.exchangeName = q.exchange;
        inv.dayChangePercent = dayChangePercent;
        inv.lastUpdated = lastUpdated;
        serverUpdates.push({ id: inv.id, currentPrice: q.price, currency: q.currency || null, exchangeName: q.exchange || null, dayChangePercent, lastUpdated });
        updated++;
      } catch (e) {
        failed.push(inv.symbol + ': ' + e.message);
      }
      if (onEach) onEach(inv);
      await new Promise((r) => setTimeout(r, 700)); // gentle client-side rate limiting
    }
    Monetra.storage.save();
    if (serverUpdates.length && Monetra.auth && Monetra.auth.isLoggedIn()) {
      try {
        await Monetra.auth.authFetch('/api/investments/bulk-prices', { method: 'PUT', body: JSON.stringify({ updates: serverUpdates }) });
      } catch (e) {
        console.warn('Could not save refreshed prices to the server:', e.message);
      }
    }
    return { updated, failed };
  }

  Monetra.stocks = { fetchQuote, fetchQuoteAlphaVantage, fetchQuoteSmart, refreshAll };
})();
