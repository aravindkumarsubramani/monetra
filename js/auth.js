window.Monetra = window.Monetra || {};

// Shared by login.html, signup.html, and app.html. Handles the login
// token issued by the Monetra server (server/server.js) — the thing that
// lets the server tell *which* account is asking for something, so
// account-bound data (right now: the two stock-price API keys) stays
// private to the account that saved it.
//
// Everything else in Monetra (accounts, transactions, budgets, etc.)
// still lives only in this browser's local storage, completely separate
// from this — signing in does not sync or gate any of that.
(function () {
  const API_BASE_URL = 'https://monetra-rju5.onrender.com';
  const TOKEN_KEY = 'monetra_auth_token';
  const USER_KEY = 'monetra_auth_user';

  function saveSession(token, user) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  }

  function clearSession() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }

  function getToken() {
    return localStorage.getItem(TOKEN_KEY);
  }

  function getUser() {
    try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); }
    catch (e) { return null; }
  }

  function isLoggedIn() {
    return !!getToken();
  }

  // Calls the Monetra server with the logged-in account's token attached.
  // Throws a plain Error either way (network failure or a non-2xx
  // response) so callers can just try/catch and show err.message.
  async function authFetch(path, options) {
    options = options || {};
    const token = getToken();
    const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
    if (token) headers['Authorization'] = 'Bearer ' + token;

    let res;
    try {
      res = await fetch(API_BASE_URL + path, Object.assign({}, options, { headers: headers }));
    } catch (networkErr) {
      throw new Error('Can’t reach the Monetra server at ' + API_BASE_URL + '. Make sure it’s running (npm start inside the server/ folder).');
    }

    let data = {};
    try { data = await res.json(); } catch (e) { /* no JSON body */ }

    if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
    return data;
  }

  Monetra.auth = { API_BASE_URL, saveSession, clearSession, getToken, getUser, isLoggedIn, authFetch };
})();
