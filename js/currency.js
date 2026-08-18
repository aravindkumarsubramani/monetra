window.Monetra = window.Monetra || {};

/* Live exchange rates via frankfurter.app (free, no API key, CORS-enabled,
   ECB reference rates), with a fallback to open.er-api.com if that request
   fails (blocked network, ad-blocker, offline, etc.). On top of whichever
   automatic rates were fetched, a currency can also get a manual override
   rate from Settings — this always wins, so conversion keeps working even
   if neither live source is reachable. */
(function () {
  const FRANKFURTER_SYMBOLS = ['AUD', 'BGN', 'BRL', 'CAD', 'CHF', 'CNY', 'CZK', 'DKK', 'GBP', 'HKD', 'HUF', 'IDR', 'ILS', 'INR', 'ISK', 'JPY', 'KRW', 'MXN', 'MYR', 'NOK', 'NZD', 'PHP', 'PLN', 'RON', 'SEK', 'SGD', 'THB', 'TRY', 'USD', 'ZAR'];

  async function fetchFromFrankfurter() {
    const symbols = FRANKFURTER_SYMBOLS.join(',');
    const res = await fetch(`https://api.frankfurter.app/latest?from=EUR&to=${symbols}`);
    if (!res.ok) throw new Error('frankfurter.app request failed: ' + res.status);
    const data = await res.json();
    if (!data || !data.rates) throw new Error('frankfurter.app returned no rates');
    return Object.assign({ EUR: 1 }, data.rates);
  }

  async function fetchFromOpenErApi() {
    const res = await fetch('https://open.er-api.com/v6/latest/EUR');
    if (!res.ok) throw new Error('open.er-api.com request failed: ' + res.status);
    const data = await res.json();
    if (data.result !== 'success' || !data.rates) throw new Error('open.er-api.com returned no rates');
    return Object.assign({ EUR: 1 }, data.rates);
  }

  async function fetchRates() {
    const state = Monetra.storage.getState();
    let rates, source, lastError;
    try {
      rates = await fetchFromFrankfurter();
      source = 'frankfurter.app';
    } catch (e1) {
      lastError = e1;
      try {
        rates = await fetchFromOpenErApi();
        source = 'open.er-api.com (fallback)';
      } catch (e2) {
        throw new Error('Both rate sources failed — frankfurter.app: ' + e1.message + '; open.er-api.com: ' + e2.message);
      }
    }
    state.exchangeRates = Object.assign({}, state.exchangeRates, { base: 'EUR', rates, updated: new Date().toISOString(), source });
    Monetra.storage.save();
    return state.exchangeRates;
  }

  // Manual overrides (units of `code` per 1 EUR) always take precedence
  // over whatever was last fetched automatically.
  function combinedRates() {
    const state = Monetra.storage.getState();
    const base = (state.exchangeRates && state.exchangeRates.rates) || { EUR: 1 };
    const overrides = (state.exchangeRates && state.exchangeRates.manualOverrides) || {};
    return Object.assign({}, base, overrides);
  }

  function setManualRate(code, unitsPerEUR) {
    const state = Monetra.storage.getState();
    if (!state.exchangeRates.manualOverrides) state.exchangeRates.manualOverrides = {};
    state.exchangeRates.manualOverrides[code] = Number(unitsPerEUR);
    Monetra.storage.save();
  }

  function removeManualRate(code) {
    const state = Monetra.storage.getState();
    if (state.exchangeRates.manualOverrides) delete state.exchangeRates.manualOverrides[code];
    Monetra.storage.save();
  }

  function convert(amount, from, to) {
    const amt = Number(amount) || 0;
    if (from === to) return amt;
    const rates = combinedRates();
    const rFrom = rates[from], rTo = rates[to];
    if (!rFrom || !rTo) return amt; // no known rate for this pair — amount passes through unconverted
    const inEUR = amt / rFrom;
    return inEUR * rTo;
  }

  function canConvert(from, to) {
    if (from === to) return true;
    const rates = combinedRates();
    return !!(rates[from] && rates[to]);
  }

  function hasRate(code) {
    return !!combinedRates()[code];
  }

  Monetra.currency = { FRANKFURTER_SYMBOLS, fetchRates, convert, canConvert, hasRate, combinedRates, setManualRate, removeManualRate };
})();
