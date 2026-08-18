require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-to-a-long-random-string';
function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
}

// Reads the "Authorization: Bearer <token>" header, verifies it, and
// attaches the account id as req.userId — this is how the server knows
// *which* account is asking, for anything that must stay private per
// account (right now: the two stock-price API keys).
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'You need to be logged in for this.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.id;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Your session has expired — please log in again.' });
  }
}

const app = express();
// CORS lets the browser call this server from a page opened directly as a
// file (file://...) — you can keep double-clicking signup.html/login.html
// like every other Monetra page; only this server needs to be running.
app.use(cors());
app.use(express.json());

// Static files are served too, so http://localhost:PORT also works if you
// prefer it — but it's optional now, not required.
const siteRoot = path.join(__dirname, '..');
app.use(express.static(siteRoot));

const USERNAME_RE = /^[a-zA-Z0-9_.]{3,32}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Quick way to confirm the server can actually reach MySQL — visit
// http://localhost:3000/api/health after starting the server.
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: 'connected' });
  } catch (err) {
    res.status(500).json({ ok: false, db: 'not connected', error: err.message });
  }
});

app.post('/api/signup', async (req, res) => {
  try {
    const body = req.body || {};
    const fullName = String(body.fullName || '').trim();
    const username = String(body.username || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const mobileCountryCode = body.mobileCountryCode ? String(body.mobileCountryCode).trim() : null;
    const mobile = body.mobile ? String(body.mobile).trim() : null;
    const password = String(body.password || '');

    if (!fullName) return res.status(400).json({ error: 'Full name is required.' });
    if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'Username must be 3-32 characters — letters, numbers, "." or "_" only.' });
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'A valid email address is required.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

    const [existing] = await pool.query(
      'SELECT id, username, email FROM users WHERE username = ? OR email = ? LIMIT 1',
      [username, email]
    );
    if (existing.length) {
      const takenField = existing[0].username === username ? 'username' : 'email';
      return res.status(409).json({ error: `That ${takenField} is already registered.` });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const [result] = await pool.query(
      `INSERT INTO users (full_name, username, email, mobile_country_code, mobile, password_hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [fullName, username, email, mobileCountryCode, mobile, passwordHash]
    );

    const user = { id: result.insertId, fullName, username, email, mobileCountryCode, mobile };
    res.status(201).json({ ok: true, user, token: signToken(user) });
  } catch (err) {
    console.error('signup error:', err);
    // A duplicate that slipped past the check above (e.g. a race) surfaces
    // here as a MySQL "duplicate entry" error — report it as a normal
    // validation failure rather than a generic server error.
    if (err && err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'That username or email is already registered.' });
    }
    res.status(500).json({ error: 'Something went wrong creating your account. Please try again.' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const body = req.body || {};
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');

    if (!EMAIL_RE.test(email) || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const [rows] = await pool.query(
      'SELECT id, username, full_name, email, mobile_country_code, mobile, password_hash FROM users WHERE email = ? LIMIT 1',
      [email]
    );
    // Same "incorrect email or password" message whether the email doesn't
    // exist or the password is wrong — doesn't reveal which one it was.
    if (!rows.length) return res.status(401).json({ error: 'Incorrect email or password.' });

    const row = rows[0];
    const match = await bcrypt.compare(password, row.password_hash);
    if (!match) return res.status(401).json({ error: 'Incorrect email or password.' });

    const user = {
      id: row.id,
      fullName: row.full_name,
      username: row.username,
      email: row.email,
      mobileCountryCode: row.mobile_country_code,
      mobile: row.mobile
    };
    res.json({ ok: true, user, token: signToken(user) });
  } catch (err) {
    console.error('login error:', err);
    res.status(500).json({ error: 'Something went wrong logging you in. Please try again.' });
  }
});

// ---- Per-account settings: right now just the two stock-price API keys.
// Everything else in Monetra still lives only in the browser's local
// storage — this is the one thing that follows the logged-in account. ----

app.get('/api/settings', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT twelve_data_api_key, alpha_vantage_api_key FROM user_settings WHERE user_id = ? LIMIT 1',
      [req.userId]
    );
    const row = rows[0] || {};
    res.json({
      ok: true,
      settings: {
        twelveDataApiKey: row.twelve_data_api_key || '',
        alphaVantageApiKey: row.alpha_vantage_api_key || ''
      }
    });
  } catch (err) {
    console.error('get settings error:', err);
    res.status(500).json({ error: 'Could not load your saved settings.' });
  }
});

app.put('/api/settings', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const twelveDataApiKey = body.twelveDataApiKey != null ? String(body.twelveDataApiKey).trim() : null;
    const alphaVantageApiKey = body.alphaVantageApiKey != null ? String(body.alphaVantageApiKey).trim() : null;

    // Upsert: only overwrite a field if the caller actually sent it, so
    // saving one key doesn't wipe out the other.
    await pool.query(
      `INSERT INTO user_settings (user_id, twelve_data_api_key, alpha_vantage_api_key)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE
         twelve_data_api_key = COALESCE(VALUES(twelve_data_api_key), twelve_data_api_key),
         alpha_vantage_api_key = COALESCE(VALUES(alpha_vantage_api_key), alpha_vantage_api_key)`,
      [req.userId, twelveDataApiKey, alphaVantageApiKey]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('save settings error:', err);
    res.status(500).json({ error: 'Could not save your settings. Please try again.' });
  }
});

// ---- PayLater: full CRUD, all account-bound. Unlike the rest of Monetra,
// this data is never stored in the browser at all — only here, per account
// (id 3 in one account's list means nothing to another account's list). ----

const CURRENCY_RE = /^[A-Z]{3}$/;

// Loads one account's full PayLater list, each with its payment history,
// shaped to match exactly what js/paylater.js already expects locally.
async function loadPaylaters(userId) {
  const [providers] = await pool.query(
    'SELECT id, provider, credit_limit, outstanding, currency, notes FROM paylaters WHERE user_id = ? ORDER BY id',
    [userId]
  );
  if (!providers.length) return [];

  const ids = providers.map((p) => p.id);
  const [payments] = await pool.query(
    `SELECT id, paylater_id, payment_date, amount FROM paylater_payments WHERE paylater_id IN (?) ORDER BY payment_date`,
    [ids]
  );
  const paymentsByProvider = {};
  payments.forEach((pm) => {
    (paymentsByProvider[pm.paylater_id] = paymentsByProvider[pm.paylater_id] || []).push({
      id: String(pm.id),
      date: pm.payment_date,
      amount: Number(pm.amount)
    });
  });

  return providers.map((p) => ({
    id: String(p.id),
    provider: p.provider,
    creditLimit: Number(p.credit_limit),
    outstanding: Number(p.outstanding),
    currency: p.currency,
    notes: p.notes || '',
    payments: paymentsByProvider[p.id] || []
  }));
}

function validatePaylaterBody(body) {
  const provider = String(body.provider || '').trim();
  const creditLimit = Number(body.creditLimit);
  const outstanding = Number(body.outstanding);
  const currency = String(body.currency || '').trim().toUpperCase();
  const notes = body.notes != null ? String(body.notes).trim().slice(0, 500) : '';

  if (!provider) return { error: 'Provider name is required.' };
  if (!Number.isFinite(creditLimit) || creditLimit < 0) return { error: 'Credit limit must be a valid, non-negative number.' };
  if (!Number.isFinite(outstanding) || outstanding < 0) return { error: 'Outstanding amount must be a valid, non-negative number.' };
  if (!CURRENCY_RE.test(currency)) return { error: 'Currency must be a 3-letter code, e.g. INR.' };

  return { value: { provider, creditLimit, outstanding, currency, notes } };
}

app.get('/api/paylaters', requireAuth, async (req, res) => {
  try {
    res.json({ ok: true, paylaters: await loadPaylaters(req.userId) });
  } catch (err) {
    console.error('list paylaters error:', err);
    res.status(500).json({ error: 'Could not load your PayLater providers.' });
  }
});

app.post('/api/paylaters', requireAuth, async (req, res) => {
  try {
    const { error, value } = validatePaylaterBody(req.body || {});
    if (error) return res.status(400).json({ error });

    const [result] = await pool.query(
      `INSERT INTO paylaters (user_id, provider, credit_limit, outstanding, currency, notes) VALUES (?, ?, ?, ?, ?, ?)`,
      [req.userId, value.provider, value.creditLimit, value.outstanding, value.currency, value.notes]
    );

    res.status(201).json({
      ok: true,
      paylater: { id: String(result.insertId), ...value, payments: [] }
    });
  } catch (err) {
    console.error('create paylater error:', err);
    res.status(500).json({ error: 'Could not add that PayLater provider. Please try again.' });
  }
});

app.put('/api/paylaters/:id', requireAuth, async (req, res) => {
  try {
    const { error, value } = validatePaylaterBody(req.body || {});
    if (error) return res.status(400).json({ error });

    const [result] = await pool.query(
      `UPDATE paylaters SET provider = ?, credit_limit = ?, outstanding = ?, currency = ?, notes = ?
       WHERE id = ? AND user_id = ?`,
      [value.provider, value.creditLimit, value.outstanding, value.currency, value.notes, req.params.id, req.userId]
    );
    // affectedRows is 0 either if the id doesn't exist, or it belongs to a
    // different account — same 404 either way, doesn't reveal which.
    if (!result.affectedRows) return res.status(404).json({ error: 'PayLater provider not found.' });

    const [[row]] = await pool.query(
      'SELECT id, provider, credit_limit, outstanding, currency, notes FROM paylaters WHERE id = ?',
      [req.params.id]
    );
    const [payments] = await pool.query(
      'SELECT id, payment_date, amount FROM paylater_payments WHERE paylater_id = ? ORDER BY payment_date',
      [req.params.id]
    );

    res.json({
      ok: true,
      paylater: {
        id: String(row.id),
        provider: row.provider,
        creditLimit: Number(row.credit_limit),
        outstanding: Number(row.outstanding),
        currency: row.currency,
        notes: row.notes || '',
        payments: payments.map((pm) => ({ id: String(pm.id), date: pm.payment_date, amount: Number(pm.amount) }))
      }
    });
  } catch (err) {
    console.error('update paylater error:', err);
    res.status(500).json({ error: 'Could not save changes to that PayLater provider.' });
  }
});

app.delete('/api/paylaters/:id', requireAuth, async (req, res) => {
  try {
    const [result] = await pool.query(
      'DELETE FROM paylaters WHERE id = ? AND user_id = ?',
      [req.params.id, req.userId]
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'PayLater provider not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('delete paylater error:', err);
    res.status(500).json({ error: 'Could not delete that PayLater provider.' });
  }
});

app.post('/api/paylaters/:id/payments', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const date = String(body.date || '').trim();
    const amount = Number(body.amount);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'A valid payment date is required.' });
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Payment amount must be a positive number.' });

    // Ownership check + current outstanding, in one query.
    const [[row]] = await pool.query(
      'SELECT outstanding FROM paylaters WHERE id = ? AND user_id = ?',
      [req.params.id, req.userId]
    );
    if (!row) return res.status(404).json({ error: 'PayLater provider not found.' });

    const newOutstanding = Math.max(0, Number(row.outstanding) - amount);

    await pool.query('INSERT INTO paylater_payments (paylater_id, payment_date, amount) VALUES (?, ?, ?)', [req.params.id, date, amount]);
    await pool.query('UPDATE paylaters SET outstanding = ? WHERE id = ?', [newOutstanding, req.params.id]);

    const [[updatedRow]] = await pool.query(
      'SELECT id, provider, credit_limit, outstanding, currency, notes FROM paylaters WHERE id = ?',
      [req.params.id]
    );
    const [payments] = await pool.query(
      'SELECT id, payment_date, amount FROM paylater_payments WHERE paylater_id = ? ORDER BY payment_date',
      [req.params.id]
    );

    res.json({
      ok: true,
      paylater: {
        id: String(updatedRow.id),
        provider: updatedRow.provider,
        creditLimit: Number(updatedRow.credit_limit),
        outstanding: Number(updatedRow.outstanding),
        currency: updatedRow.currency,
        notes: updatedRow.notes || '',
        payments: payments.map((pm) => ({ id: String(pm.id), date: pm.payment_date, amount: Number(pm.amount) }))
      }
    });
  } catch (err) {
    console.error('log paylater payment error:', err);
    res.status(500).json({ error: 'Could not log that payment.' });
  }
});

// ---- Accounts, Cards, Wallets: all account-bound and all require login,
// same as PayLater. Unlike PayLater, ids are client-supplied (the browser's
// existing uid()-generated ids, e.g. 'acc_lz3x9k2_a1b2c3') rather than
// auto-increment — Transactions stay local-only and reference an account by
// that exact id, so preserving it is what keeps a migrated account's
// transaction history correctly linked. ----

const CLIENT_ID_RE = /^[a-zA-Z0-9_]{3,64}$/;

function mapAccountRow(row) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    currency: row.currency,
    balance: Number(row.balance),
    notes: row.notes || '',
    country: row.country || undefined,
    bank: row.bank || undefined,
    branch: row.branch || undefined,
    accountNumber: row.account_number || undefined,
    ifsc: row.ifsc || undefined,
    iban: row.iban || undefined,
    bic: row.bic || undefined,
    customerId: row.customer_id || undefined
  };
}

function validateAccountBody(body, requireId) {
  const id = String(body.id || '').trim();
  if (requireId && !CLIENT_ID_RE.test(id)) return { error: 'Invalid account id.' };
  const name = String(body.name || '').trim();
  const type = body.type === 'cash' ? 'cash' : (body.type === 'bank' ? 'bank' : null);
  const currency = String(body.currency || '').trim().toUpperCase();
  const balance = Number(body.balance);

  if (!name) return { error: 'Account name is required.' };
  if (!type) return { error: "Type must be 'bank' or 'cash'." };
  if (!CURRENCY_RE.test(currency)) return { error: 'Currency must be a 3-letter code, e.g. INR.' };
  if (!Number.isFinite(balance)) return { error: 'Balance must be a valid number.' };

  const str = (v, max) => (v != null ? String(v).trim().slice(0, max || 255) : null);
  return {
    value: {
      id: id || null,
      name, type, currency, balance,
      notes: str(body.notes, 500) || '',
      country: type === 'bank' ? str(body.country, 40) : null,
      bank: type === 'bank' ? str(body.bank, 120) : null,
      branch: type === 'bank' ? str(body.branch, 120) : null,
      accountNumber: type === 'bank' ? str(body.accountNumber, 64) : null,
      ifsc: type === 'bank' ? str(body.ifsc, 20) : null,
      iban: type === 'bank' ? str(body.iban, 40) : null,
      bic: type === 'bank' ? str(body.bic, 20) : null,
      customerId: type === 'bank' ? str(body.customerId, 64) : null
    }
  };
}

app.get('/api/accounts', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM accounts WHERE user_id = ? ORDER BY created_at', [req.userId]);
    res.json({ ok: true, accounts: rows.map(mapAccountRow) });
  } catch (err) {
    console.error('list accounts error:', err);
    res.status(500).json({ error: 'Could not load your accounts.' });
  }
});

app.post('/api/accounts', requireAuth, async (req, res) => {
  try {
    const { error, value } = validateAccountBody(req.body || {}, true);
    if (error) return res.status(400).json({ error });

    await pool.query(
      `INSERT INTO accounts (id, user_id, name, type, currency, balance, notes, country, bank, branch, account_number, ifsc, iban, bic, customer_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [value.id, req.userId, value.name, value.type, value.currency, value.balance, value.notes, value.country, value.bank, value.branch, value.accountNumber, value.ifsc, value.iban, value.bic, value.customerId]
    );

    res.status(201).json({ ok: true, account: value });
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'An account with that id already exists.' });
    console.error('create account error:', err);
    res.status(500).json({ error: 'Could not add that account. Please try again.' });
  }
});

app.put('/api/accounts/:id', requireAuth, async (req, res) => {
  try {
    const { error, value } = validateAccountBody(req.body || {}, false);
    if (error) return res.status(400).json({ error });

    const [result] = await pool.query(
      `UPDATE accounts SET name=?, type=?, currency=?, balance=?, notes=?, country=?, bank=?, branch=?, account_number=?, ifsc=?, iban=?, bic=?, customer_id=?
       WHERE id = ? AND user_id = ?`,
      [value.name, value.type, value.currency, value.balance, value.notes, value.country, value.bank, value.branch, value.accountNumber, value.ifsc, value.iban, value.bic, value.customerId, req.params.id, req.userId]
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'Account not found.' });
    res.json({ ok: true, account: Object.assign({}, value, { id: req.params.id }) });
  } catch (err) {
    console.error('update account error:', err);
    res.status(500).json({ error: 'Could not save changes to that account.' });
  }
});

app.delete('/api/accounts/:id', requireAuth, async (req, res) => {
  try {
    const [result] = await pool.query('DELETE FROM accounts WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Account not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('delete account error:', err);
    res.status(500).json({ error: 'Could not delete that account.' });
  }
});

function mapCardRow(row) {
  return {
    id: row.id,
    accountId: row.account_id || null,
    network: row.network,
    cardType: row.card_type,
    cardNumber: row.card_number || '',
    expiryMonth: row.expiry_month,
    expiryYear: row.expiry_year,
    creditLimit: row.credit_limit != null ? Number(row.credit_limit) : null,
    outstandingBalance: row.outstanding_balance != null ? Number(row.outstanding_balance) : null,
    notes: row.notes || ''
  };
}

function validateCardBody(body, requireId) {
  const id = String(body.id || '').trim();
  if (requireId && !CLIENT_ID_RE.test(id)) return { error: 'Invalid card id.' };
  const network = String(body.network || '').trim();
  const cardType = body.cardType === 'credit' ? 'credit' : (body.cardType === 'debit' ? 'debit' : null);
  if (!network) return { error: 'Card network is required.' };
  if (!cardType) return { error: "Card type must be 'debit' or 'credit'." };

  const toIntOrNull = (v) => (v === null || v === undefined || v === '') ? null : (Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    value: {
      id: id || null,
      accountId: body.accountId ? String(body.accountId).trim() : null,
      network,
      cardType,
      cardNumber: body.cardNumber ? String(body.cardNumber).replace(/\D/g, '').slice(0, 32) : '',
      expiryMonth: toIntOrNull(body.expiryMonth),
      expiryYear: toIntOrNull(body.expiryYear),
      creditLimit: toIntOrNull(body.creditLimit),
      outstandingBalance: toIntOrNull(body.outstandingBalance),
      notes: body.notes != null ? String(body.notes).trim().slice(0, 500) : ''
    }
  };
}

app.get('/api/cards', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM cards WHERE user_id = ? ORDER BY created_at', [req.userId]);
    res.json({ ok: true, cards: rows.map(mapCardRow) });
  } catch (err) {
    console.error('list cards error:', err);
    res.status(500).json({ error: 'Could not load your cards.' });
  }
});

app.post('/api/cards', requireAuth, async (req, res) => {
  try {
    const { error, value } = validateCardBody(req.body || {}, true);
    if (error) return res.status(400).json({ error });

    await pool.query(
      `INSERT INTO cards (id, user_id, account_id, network, card_type, card_number, expiry_month, expiry_year, credit_limit, outstanding_balance, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [value.id, req.userId, value.accountId, value.network, value.cardType, value.cardNumber, value.expiryMonth, value.expiryYear, value.creditLimit, value.outstandingBalance, value.notes]
    );
    res.status(201).json({ ok: true, card: value });
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A card with that id already exists.' });
    console.error('create card error:', err);
    res.status(500).json({ error: 'Could not add that card. Please try again.' });
  }
});

app.put('/api/cards/:id', requireAuth, async (req, res) => {
  try {
    const { error, value } = validateCardBody(req.body || {}, false);
    if (error) return res.status(400).json({ error });

    const [result] = await pool.query(
      `UPDATE cards SET account_id=?, network=?, card_type=?, card_number=?, expiry_month=?, expiry_year=?, credit_limit=?, outstanding_balance=?, notes=?
       WHERE id = ? AND user_id = ?`,
      [value.accountId, value.network, value.cardType, value.cardNumber, value.expiryMonth, value.expiryYear, value.creditLimit, value.outstandingBalance, value.notes, req.params.id, req.userId]
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'Card not found.' });
    res.json({ ok: true, card: Object.assign({}, value, { id: req.params.id }) });
  } catch (err) {
    console.error('update card error:', err);
    res.status(500).json({ error: 'Could not save changes to that card.' });
  }
});

app.delete('/api/cards/:id', requireAuth, async (req, res) => {
  try {
    const [result] = await pool.query('DELETE FROM cards WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Card not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('delete card error:', err);
    res.status(500).json({ error: 'Could not delete that card.' });
  }
});

function mapWalletRow(row) {
  return { id: row.id, name: row.name, currency: row.currency, balance: Number(row.balance), notes: row.notes || '' };
}

function validateWalletBody(body, requireId) {
  const id = String(body.id || '').trim();
  if (requireId && !CLIENT_ID_RE.test(id)) return { error: 'Invalid wallet id.' };
  const name = String(body.name || '').trim();
  const currency = String(body.currency || '').trim().toUpperCase();
  const balance = Number(body.balance);

  if (!name) return { error: 'Wallet name is required.' };
  if (!CURRENCY_RE.test(currency)) return { error: 'Currency must be a 3-letter code, e.g. INR.' };
  if (!Number.isFinite(balance)) return { error: 'Balance must be a valid number.' };

  return { value: { id: id || null, name, currency, balance, notes: body.notes != null ? String(body.notes).trim().slice(0, 500) : '' } };
}

app.get('/api/wallets', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM wallets WHERE user_id = ? ORDER BY created_at', [req.userId]);
    res.json({ ok: true, wallets: rows.map(mapWalletRow) });
  } catch (err) {
    console.error('list wallets error:', err);
    res.status(500).json({ error: 'Could not load your wallets.' });
  }
});

app.post('/api/wallets', requireAuth, async (req, res) => {
  try {
    const { error, value } = validateWalletBody(req.body || {}, true);
    if (error) return res.status(400).json({ error });

    await pool.query(
      'INSERT INTO wallets (id, user_id, name, currency, balance, notes) VALUES (?, ?, ?, ?, ?, ?)',
      [value.id, req.userId, value.name, value.currency, value.balance, value.notes]
    );
    res.status(201).json({ ok: true, wallet: value });
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A wallet with that id already exists.' });
    console.error('create wallet error:', err);
    res.status(500).json({ error: 'Could not add that wallet. Please try again.' });
  }
});

app.put('/api/wallets/:id', requireAuth, async (req, res) => {
  try {
    const { error, value } = validateWalletBody(req.body || {}, false);
    if (error) return res.status(400).json({ error });

    const [result] = await pool.query(
      'UPDATE wallets SET name=?, currency=?, balance=?, notes=? WHERE id = ? AND user_id = ?',
      [value.name, value.currency, value.balance, value.notes, req.params.id, req.userId]
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'Wallet not found.' });
    res.json({ ok: true, wallet: Object.assign({}, value, { id: req.params.id }) });
  } catch (err) {
    console.error('update wallet error:', err);
    res.status(500).json({ error: 'Could not save changes to that wallet.' });
  }
});

app.delete('/api/wallets/:id', requireAuth, async (req, res) => {
  try {
    const [result] = await pool.query('DELETE FROM wallets WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Wallet not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('delete wallet error:', err);
    res.status(500).json({ error: 'Could not delete that wallet.' });
  }
});

// One-time bulk import of whatever accounts/cards/wallets already existed in
// the browser's local storage before this account ever logged in — see
// js/app.js's migrateLocalDataIfNeeded(). Ids are preserved (INSERT IGNORE:
// safe to call more than once — anything already present, by id, is just
// skipped rather than erroring or duplicating).
app.post('/api/migrate', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const accounts = Array.isArray(body.accounts) ? body.accounts : [];
    const cards = Array.isArray(body.cards) ? body.cards : [];
    const wallets = Array.isArray(body.wallets) ? body.wallets : [];

    let importedAccounts = 0, importedCards = 0, importedWallets = 0;

    for (const a of accounts) {
      const { error, value } = validateAccountBody(a, true);
      if (error) continue;
      const [result] = await pool.query(
        `INSERT IGNORE INTO accounts (id, user_id, name, type, currency, balance, notes, country, bank, branch, account_number, ifsc, iban, bic, customer_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [value.id, req.userId, value.name, value.type, value.currency, value.balance, value.notes, value.country, value.bank, value.branch, value.accountNumber, value.ifsc, value.iban, value.bic, value.customerId]
      );
      if (result.affectedRows) importedAccounts++;
    }

    for (const c of cards) {
      const { error, value } = validateCardBody(c, true);
      if (error) continue;
      const [result] = await pool.query(
        `INSERT IGNORE INTO cards (id, user_id, account_id, network, card_type, card_number, expiry_month, expiry_year, credit_limit, outstanding_balance, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [value.id, req.userId, value.accountId, value.network, value.cardType, value.cardNumber, value.expiryMonth, value.expiryYear, value.creditLimit, value.outstandingBalance, value.notes]
      );
      if (result.affectedRows) importedCards++;
    }

    for (const w of wallets) {
      const { error, value } = validateWalletBody(w, true);
      if (error) continue;
      const [result] = await pool.query(
        'INSERT IGNORE INTO wallets (id, user_id, name, currency, balance, notes) VALUES (?, ?, ?, ?, ?, ?)',
        [value.id, req.userId, value.name, value.currency, value.balance, value.notes]
      );
      if (result.affectedRows) importedWallets++;
    }

    res.json({ ok: true, imported: { accounts: importedAccounts, cards: importedCards, wallets: importedWallets } });
  } catch (err) {
    console.error('migrate error:', err);
    res.status(500).json({ error: 'Could not import your existing data. Please try again.' });
  }
});

// ---- Monthly Planner: budgets, planned bills, planned income — all
// account-bound, requires login, same as PayLater. Unlike Accounts/Cards/
// Wallets, ids here are plain auto-increment (nothing else in the app
// references a budget/payment/income by id), and this data was deliberately
// NOT migrated from existing local browser data — every account starts
// with an empty planner. ----

const MONTH_KEY_RE = /^\d{4}-\d{2}$/;

function validatePlannerBudget(body) {
  const monthKey = String(body.monthKey || '').trim();
  const category = String(body.category || '').trim();
  const planned = Number(body.planned);
  const currency = String(body.currency || '').trim().toUpperCase();
  if (!MONTH_KEY_RE.test(monthKey)) return { error: 'A valid month is required.' };
  if (!category) return { error: 'Category is required.' };
  if (!Number.isFinite(planned) || planned < 0) return { error: 'Planned amount must be a valid, non-negative number.' };
  if (!CURRENCY_RE.test(currency)) return { error: 'Currency must be a 3-letter code, e.g. INR.' };
  return { value: { monthKey, category, planned, currency } };
}

function validatePlannerPayment(body) {
  const monthKey = String(body.monthKey || '').trim();
  const name = String(body.name || '').trim();
  const category = String(body.category || '').trim();
  const amount = Number(body.amount);
  const currency = String(body.currency || '').trim().toUpperCase();
  const dueDay = Number(body.dueDay);
  const paid = !!body.paid;
  if (!MONTH_KEY_RE.test(monthKey)) return { error: 'A valid month is required.' };
  if (!name) return { error: 'Payment name is required.' };
  if (!category) return { error: 'Category is required.' };
  if (!Number.isFinite(amount) || amount <= 0) return { error: 'Amount must be a valid, positive number.' };
  if (!CURRENCY_RE.test(currency)) return { error: 'Currency must be a 3-letter code, e.g. INR.' };
  if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) return { error: 'Due day must be between 1 and 31.' };
  return { value: { monthKey, name, category, amount, currency, dueDay, paid } };
}

function validatePlannerIncome(body) {
  const monthKey = String(body.monthKey || '').trim();
  const name = String(body.name || '').trim();
  const category = String(body.category || '').trim();
  const amount = Number(body.amount);
  const currency = String(body.currency || '').trim().toUpperCase();
  if (!MONTH_KEY_RE.test(monthKey)) return { error: 'A valid month is required.' };
  if (!name) return { error: 'Income source is required.' };
  if (!category) return { error: 'Category is required.' };
  if (!Number.isFinite(amount) || amount <= 0) return { error: 'Amount must be a valid, positive number.' };
  if (!CURRENCY_RE.test(currency)) return { error: 'Currency must be a 3-letter code, e.g. INR.' };
  return { value: { monthKey, name, category, amount, currency } };
}

// One call fetches everything for the Planner tab, shaped to match exactly
// what js/planner.js already keeps in state.planner.months locally.
app.get('/api/planner', requireAuth, async (req, res) => {
  try {
    const [budgets] = await pool.query('SELECT id, month_key, category, planned, currency FROM planner_budgets WHERE user_id = ?', [req.userId]);
    const [payments] = await pool.query('SELECT id, month_key, name, category, amount, currency, due_day, paid FROM planner_payments WHERE user_id = ?', [req.userId]);
    const [incomes] = await pool.query('SELECT id, month_key, name, category, amount, currency FROM planner_incomes WHERE user_id = ?', [req.userId]);

    const months = {};
    const ensure = (mk) => (months[mk] = months[mk] || { budgets: [], payments: [], incomes: [] });
    budgets.forEach((b) => ensure(b.month_key).budgets.push({ id: String(b.id), category: b.category, planned: Number(b.planned), currency: b.currency }));
    payments.forEach((p) => ensure(p.month_key).payments.push({ id: String(p.id), name: p.name, category: p.category, amount: Number(p.amount), currency: p.currency, dueDay: p.due_day, paid: !!p.paid }));
    incomes.forEach((i) => ensure(i.month_key).incomes.push({ id: String(i.id), name: i.name, category: i.category, amount: Number(i.amount), currency: i.currency }));

    res.json({ ok: true, months });
  } catch (err) {
    console.error('get planner error:', err);
    res.status(500).json({ error: 'Could not load your planner data.' });
  }
});

app.post('/api/planner/budgets', requireAuth, async (req, res) => {
  try {
    const { error, value } = validatePlannerBudget(req.body || {});
    if (error) return res.status(400).json({ error });
    const [result] = await pool.query(
      'INSERT INTO planner_budgets (user_id, month_key, category, planned, currency) VALUES (?, ?, ?, ?, ?)',
      [req.userId, value.monthKey, value.category, value.planned, value.currency]
    );
    res.status(201).json({ ok: true, budget: { id: String(result.insertId), category: value.category, planned: value.planned, currency: value.currency } });
  } catch (err) {
    console.error('create planner budget error:', err);
    res.status(500).json({ error: 'Could not add that budget. Please try again.' });
  }
});

app.put('/api/planner/budgets/:id', requireAuth, async (req, res) => {
  try {
    const { error, value } = validatePlannerBudget(req.body || {});
    if (error) return res.status(400).json({ error });
    const [result] = await pool.query(
      'UPDATE planner_budgets SET month_key=?, category=?, planned=?, currency=? WHERE id=? AND user_id=?',
      [value.monthKey, value.category, value.planned, value.currency, req.params.id, req.userId]
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'Budget not found.' });
    res.json({ ok: true, budget: { id: req.params.id, category: value.category, planned: value.planned, currency: value.currency } });
  } catch (err) {
    console.error('update planner budget error:', err);
    res.status(500).json({ error: 'Could not save changes to that budget.' });
  }
});

app.delete('/api/planner/budgets/:id', requireAuth, async (req, res) => {
  try {
    const [result] = await pool.query('DELETE FROM planner_budgets WHERE id=? AND user_id=?', [req.params.id, req.userId]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Budget not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('delete planner budget error:', err);
    res.status(500).json({ error: 'Could not delete that budget.' });
  }
});

app.post('/api/planner/payments', requireAuth, async (req, res) => {
  try {
    const { error, value } = validatePlannerPayment(req.body || {});
    if (error) return res.status(400).json({ error });
    const [result] = await pool.query(
      'INSERT INTO planner_payments (user_id, month_key, name, category, amount, currency, due_day, paid) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [req.userId, value.monthKey, value.name, value.category, value.amount, value.currency, value.dueDay, value.paid]
    );
    res.status(201).json({ ok: true, payment: Object.assign({ id: String(result.insertId) }, value) });
  } catch (err) {
    console.error('create planner payment error:', err);
    res.status(500).json({ error: 'Could not add that payment. Please try again.' });
  }
});

app.put('/api/planner/payments/:id', requireAuth, async (req, res) => {
  try {
    const { error, value } = validatePlannerPayment(req.body || {});
    if (error) return res.status(400).json({ error });
    const [result] = await pool.query(
      'UPDATE planner_payments SET month_key=?, name=?, category=?, amount=?, currency=?, due_day=?, paid=? WHERE id=? AND user_id=?',
      [value.monthKey, value.name, value.category, value.amount, value.currency, value.dueDay, value.paid, req.params.id, req.userId]
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'Payment not found.' });
    res.json({ ok: true, payment: Object.assign({}, value, { id: req.params.id }) });
  } catch (err) {
    console.error('update planner payment error:', err);
    res.status(500).json({ error: 'Could not save changes to that payment.' });
  }
});

app.delete('/api/planner/payments/:id', requireAuth, async (req, res) => {
  try {
    const [result] = await pool.query('DELETE FROM planner_payments WHERE id=? AND user_id=?', [req.params.id, req.userId]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Payment not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('delete planner payment error:', err);
    res.status(500).json({ error: 'Could not delete that payment.' });
  }
});

app.post('/api/planner/incomes', requireAuth, async (req, res) => {
  try {
    const { error, value } = validatePlannerIncome(req.body || {});
    if (error) return res.status(400).json({ error });
    const [result] = await pool.query(
      'INSERT INTO planner_incomes (user_id, month_key, name, category, amount, currency) VALUES (?, ?, ?, ?, ?, ?)',
      [req.userId, value.monthKey, value.name, value.category, value.amount, value.currency]
    );
    res.status(201).json({ ok: true, income: Object.assign({ id: String(result.insertId) }, value) });
  } catch (err) {
    console.error('create planner income error:', err);
    res.status(500).json({ error: 'Could not add that income entry. Please try again.' });
  }
});

app.put('/api/planner/incomes/:id', requireAuth, async (req, res) => {
  try {
    const { error, value } = validatePlannerIncome(req.body || {});
    if (error) return res.status(400).json({ error });
    const [result] = await pool.query(
      'UPDATE planner_incomes SET month_key=?, name=?, category=?, amount=?, currency=? WHERE id=? AND user_id=?',
      [value.monthKey, value.name, value.category, value.amount, value.currency, req.params.id, req.userId]
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'Income entry not found.' });
    res.json({ ok: true, income: Object.assign({}, value, { id: req.params.id }) });
  } catch (err) {
    console.error('update planner income error:', err);
    res.status(500).json({ error: 'Could not save changes to that income entry.' });
  }
});

app.delete('/api/planner/incomes/:id', requireAuth, async (req, res) => {
  try {
    const [result] = await pool.query('DELETE FROM planner_incomes WHERE id=? AND user_id=?', [req.params.id, req.userId]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Income entry not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('delete planner income error:', err);
    res.status(500).json({ error: 'Could not delete that income entry.' });
  }
});

// ---- Transactions: the day-to-day ledger, plus reusable Templates.
// Requires login, like Accounts. Deliberately NOT migrated from existing
// local browser data (every account starts with an empty ledger) — see
// server/schema.sql's comment on the transactions table. account_id/
// from_account_id/to_account_id are plain VARCHAR columns with no foreign
// key, same as cards.account_id: deleting an account should orphan (not
// block or cascade) any transactions that referenced it. ----

const TX_TYPES = ['expense', 'income', 'transfer', 'withdraw', 'deposit'];
const MOVE_TYPES = ['transfer', 'withdraw', 'deposit'];

function mapTransactionRow(row) {
  const base = {
    id: row.id, date: row.date, type: row.type,
    amount: row.amount != null ? Number(row.amount) : null,
    currency: row.currency,
    note: row.note || ''
  };
  if (MOVE_TYPES.includes(row.type)) {
    return Object.assign(base, {
      fromAccountId: row.from_account_id,
      toAccountId: row.to_account_id,
      toAmount: row.to_amount != null ? Number(row.to_amount) : null,
      toCurrency: row.to_currency
    });
  }
  return Object.assign(base, {
    accountId: row.account_id,
    category: row.category,
    method: row.method || ''
  });
}

// `forTemplate`: templates have no date and amounts/currency may be blank
// (a template can be saved before an amount is filled in), so those checks
// relax slightly compared to a real transaction.
function validateTransactionBody(body, forTemplate) {
  const type = TX_TYPES.includes(body.type) ? body.type : null;
  if (!type) return { error: "Type must be one of: " + TX_TYPES.join(', ') + '.' };

  let date = null;
  if (!forTemplate) {
    date = String(body.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'A valid date is required.' };
  }

  const note = body.note != null ? String(body.note).trim().slice(0, 500) : '';

  if (MOVE_TYPES.includes(type)) {
    const fromAccountId = body.fromAccountId ? String(body.fromAccountId).trim() : null;
    const toAccountId = body.toAccountId ? String(body.toAccountId).trim() : null;
    if (!forTemplate) {
      if (!fromAccountId || !toAccountId) return { error: 'Both accounts are required.' };
      if (fromAccountId === toAccountId) return { error: 'Choose two different accounts.' };
    }
    const amount = body.amount === '' || body.amount == null ? null : Number(body.amount);
    const toAmount = body.toAmount === '' || body.toAmount == null ? null : Number(body.toAmount);
    if (!forTemplate && (!Number.isFinite(amount) || amount <= 0)) return { error: 'Amount must be a valid, positive number.' };
    if (!forTemplate && (!Number.isFinite(toAmount) || toAmount <= 0)) return { error: 'Amount received must be a valid, positive number.' };
    const currency = body.currency ? String(body.currency).trim().toUpperCase() : null;
    const toCurrency = body.toCurrency ? String(body.toCurrency).trim().toUpperCase() : null;
    if (currency && !CURRENCY_RE.test(currency)) return { error: 'Currency must be a 3-letter code, e.g. INR.' };
    if (toCurrency && !CURRENCY_RE.test(toCurrency)) return { error: 'Currency must be a 3-letter code, e.g. INR.' };
    return {
      value: {
        type, date, note, fromAccountId, toAccountId,
        amount: Number.isFinite(amount) ? amount : null,
        toAmount: Number.isFinite(toAmount) ? toAmount : null,
        currency, toCurrency,
        accountId: null, category: null, method: null
      }
    };
  }

  const accountId = body.accountId ? String(body.accountId).trim() : null;
  if (!forTemplate && !accountId) return { error: 'An account is required.' };
  const category = body.category ? String(body.category).trim().slice(0, 60) : null;
  if (!forTemplate && !category) return { error: 'Category is required.' };
  const amount = body.amount === '' || body.amount == null ? null : Number(body.amount);
  if (!forTemplate && (!Number.isFinite(amount) || amount <= 0)) return { error: 'Amount must be a valid, positive number.' };
  const currency = body.currency ? String(body.currency).trim().toUpperCase() : null;
  if (currency && !CURRENCY_RE.test(currency)) return { error: 'Currency must be a 3-letter code, e.g. INR.' };
  const method = body.method != null ? String(body.method).trim().slice(0, 20) : null;

  return {
    value: {
      type, date, note, accountId, category,
      amount: Number.isFinite(amount) ? amount : null,
      currency, method,
      fromAccountId: null, toAccountId: null, toAmount: null, toCurrency: null
    }
  };
}

app.get('/api/transactions', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM transactions WHERE user_id = ? ORDER BY date DESC, created_at DESC', [req.userId]);
    res.json({ ok: true, transactions: rows.map(mapTransactionRow) });
  } catch (err) {
    console.error('list transactions error:', err);
    res.status(500).json({ error: 'Could not load your transactions.' });
  }
});

app.post('/api/transactions', requireAuth, async (req, res) => {
  try {
    const id = String((req.body || {}).id || '').trim();
    if (!CLIENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid transaction id.' });
    const { error, value } = validateTransactionBody(req.body || {}, false);
    if (error) return res.status(400).json({ error });

    await pool.query(
      `INSERT INTO transactions (id, user_id, date, type, account_id, category, amount, currency, method, note, from_account_id, to_account_id, to_amount, to_currency)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, req.userId, value.date, value.type, value.accountId, value.category, value.amount, value.currency, value.method, value.note, value.fromAccountId, value.toAccountId, value.toAmount, value.toCurrency]
    );
    res.status(201).json({ ok: true, transaction: Object.assign({ id }, value) });
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A transaction with that id already exists.' });
    console.error('create transaction error:', err);
    res.status(500).json({ error: 'Could not add that transaction. Please try again.' });
  }
});

app.put('/api/transactions/:id', requireAuth, async (req, res) => {
  try {
    const { error, value } = validateTransactionBody(req.body || {}, false);
    if (error) return res.status(400).json({ error });

    const [result] = await pool.query(
      `UPDATE transactions SET date=?, type=?, account_id=?, category=?, amount=?, currency=?, method=?, note=?, from_account_id=?, to_account_id=?, to_amount=?, to_currency=?
       WHERE id = ? AND user_id = ?`,
      [value.date, value.type, value.accountId, value.category, value.amount, value.currency, value.method, value.note, value.fromAccountId, value.toAccountId, value.toAmount, value.toCurrency, req.params.id, req.userId]
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'Transaction not found.' });
    res.json({ ok: true, transaction: Object.assign({}, value, { id: req.params.id }) });
  } catch (err) {
    console.error('update transaction error:', err);
    res.status(500).json({ error: 'Could not save changes to that transaction.' });
  }
});

app.delete('/api/transactions/:id', requireAuth, async (req, res) => {
  try {
    const [result] = await pool.query('DELETE FROM transactions WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Transaction not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('delete transaction error:', err);
    res.status(500).json({ error: 'Could not delete that transaction.' });
  }
});

function mapTemplateRow(row) {
  const base = mapTransactionRow(row);
  delete base.date;
  base.name = row.name;
  return base;
}

app.get('/api/transaction-templates', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM transaction_templates WHERE user_id = ? ORDER BY created_at', [req.userId]);
    res.json({ ok: true, templates: rows.map(mapTemplateRow) });
  } catch (err) {
    console.error('list transaction templates error:', err);
    res.status(500).json({ error: 'Could not load your templates.' });
  }
});

app.post('/api/transaction-templates', requireAuth, async (req, res) => {
  try {
    const id = String((req.body || {}).id || '').trim();
    if (!CLIENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid template id.' });
    const name = String((req.body || {}).name || '').trim().slice(0, 120);
    if (!name) return res.status(400).json({ error: 'Template name is required.' });
    const { error, value } = validateTransactionBody(req.body || {}, true);
    if (error) return res.status(400).json({ error });

    await pool.query(
      `INSERT INTO transaction_templates (id, user_id, name, type, account_id, category, amount, currency, method, note, from_account_id, to_account_id, to_amount, to_currency)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, req.userId, name, value.type, value.accountId, value.category, value.amount, value.currency, value.method, value.note, value.fromAccountId, value.toAccountId, value.toAmount, value.toCurrency]
    );
    res.status(201).json({ ok: true, template: Object.assign({ id, name }, value) });
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A template with that id already exists.' });
    console.error('create transaction template error:', err);
    res.status(500).json({ error: 'Could not save that template. Please try again.' });
  }
});

app.delete('/api/transaction-templates/:id', requireAuth, async (req, res) => {
  try {
    const [result] = await pool.query('DELETE FROM transaction_templates WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Template not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('delete transaction template error:', err);
    res.status(500).json({ error: 'Could not delete that template.' });
  }
});

// ---- Debts: loans/EMIs with a manually-built payment schedule. Requires
// login, like Accounts. Deliberately NOT migrated from existing local
// browser data — every account starts with no debts. current_debt is
// always recomputed here from the schedule's paid rows, never trusted from
// the client. ----

function recomputeCurrentDebt(totalDebt, schedule) {
  const paidSum = schedule.filter((r) => r.paid).reduce((s, r) => s + r.amount, 0);
  return Math.max(0, totalDebt - paidSum);
}

async function loadDebts(userId) {
  const [debts] = await pool.query(
    'SELECT id, name, total_debt, current_debt, currency, notes FROM debts WHERE user_id = ? ORDER BY id',
    [userId]
  );
  if (!debts.length) return [];

  const ids = debts.map((d) => d.id);
  const [rows] = await pool.query(
    'SELECT id, debt_id, date, amount, paid FROM debt_schedule WHERE debt_id IN (?) ORDER BY date IS NULL, date',
    [ids]
  );
  const scheduleByDebt = {};
  rows.forEach((r) => {
    (scheduleByDebt[r.debt_id] = scheduleByDebt[r.debt_id] || []).push({
      id: String(r.id), date: r.date || null, amount: Number(r.amount), paid: !!r.paid
    });
  });

  return debts.map((d) => ({
    id: String(d.id),
    name: d.name,
    totalDebt: Number(d.total_debt),
    currentDebt: Number(d.current_debt),
    currency: d.currency,
    notes: d.notes || '',
    schedule: scheduleByDebt[d.id] || []
  }));
}

function validateDebtBody(body) {
  const name = String(body.name || '').trim().slice(0, 120);
  const totalDebt = Number(body.totalDebt);
  const currency = String(body.currency || '').trim().toUpperCase();
  const notes = body.notes != null ? String(body.notes).trim().slice(0, 500) : '';
  const scheduleIn = Array.isArray(body.schedule) ? body.schedule : [];

  if (!name) return { error: 'Debt name is required.' };
  if (!Number.isFinite(totalDebt) || totalDebt < 0) return { error: 'Total debt must be a valid, non-negative number.' };
  if (!CURRENCY_RE.test(currency)) return { error: 'Currency must be a 3-letter code, e.g. INR.' };

  const schedule = [];
  for (const row of scheduleIn) {
    const amount = Number(row.amount);
    if (!Number.isFinite(amount)) return { error: 'Each payment needs a valid amount.' };
    const date = row.date ? String(row.date).trim() : null;
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'Payment dates must be valid dates.' };
    schedule.push({ date, amount, paid: !!row.paid });
  }

  return { value: { name, totalDebt, currency, notes, schedule } };
}

app.get('/api/debts', requireAuth, async (req, res) => {
  try {
    res.json({ ok: true, debts: await loadDebts(req.userId) });
  } catch (err) {
    console.error('list debts error:', err);
    res.status(500).json({ error: 'Could not load your debts.' });
  }
});

app.post('/api/debts', requireAuth, async (req, res) => {
  try {
    const { error, value } = validateDebtBody(req.body || {});
    if (error) return res.status(400).json({ error });

    const currentDebt = recomputeCurrentDebt(value.totalDebt, value.schedule);
    const [result] = await pool.query(
      'INSERT INTO debts (user_id, name, total_debt, current_debt, currency, notes) VALUES (?, ?, ?, ?, ?, ?)',
      [req.userId, value.name, value.totalDebt, currentDebt, value.currency, value.notes]
    );
    const debtId = result.insertId;
    for (const row of value.schedule) {
      await pool.query('INSERT INTO debt_schedule (debt_id, date, amount, paid) VALUES (?, ?, ?, ?)', [debtId, row.date, row.amount, row.paid]);
    }

    res.status(201).json({ ok: true, debt: (await loadDebts(req.userId)).find((d) => d.id === String(debtId)) });
  } catch (err) {
    console.error('create debt error:', err);
    res.status(500).json({ error: 'Could not add that debt. Please try again.' });
  }
});

app.put('/api/debts/:id', requireAuth, async (req, res) => {
  try {
    const { error, value } = validateDebtBody(req.body || {});
    if (error) return res.status(400).json({ error });

    const currentDebt = recomputeCurrentDebt(value.totalDebt, value.schedule);
    const [result] = await pool.query(
      'UPDATE debts SET name=?, total_debt=?, current_debt=?, currency=?, notes=? WHERE id=? AND user_id=?',
      [value.name, value.totalDebt, currentDebt, value.currency, value.notes, req.params.id, req.userId]
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'Debt not found.' });

    // Editing a debt rebuilds its whole schedule in one submission (the
    // Edit form lets rows be added/removed freely) — simplest to match that
    // by fully replacing the stored rows rather than diffing them.
    await pool.query('DELETE FROM debt_schedule WHERE debt_id = ?', [req.params.id]);
    for (const row of value.schedule) {
      await pool.query('INSERT INTO debt_schedule (debt_id, date, amount, paid) VALUES (?, ?, ?, ?)', [req.params.id, row.date, row.amount, row.paid]);
    }

    res.json({ ok: true, debt: (await loadDebts(req.userId)).find((d) => d.id === req.params.id) });
  } catch (err) {
    console.error('update debt error:', err);
    res.status(500).json({ error: 'Could not save changes to that debt.' });
  }
});

app.delete('/api/debts/:id', requireAuth, async (req, res) => {
  try {
    const [result] = await pool.query('DELETE FROM debts WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Debt not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('delete debt error:', err);
    res.status(500).json({ error: 'Could not delete that debt.' });
  }
});

// Toggles one schedule row's paid state (the "View details" checkbox) —
// separate from the full-schedule-replace PUT above, since this needs to
// work without opening the Edit form. Recomputes current_debt afterwards.
app.put('/api/debts/:debtId/schedule/:scheduleId', requireAuth, async (req, res) => {
  try {
    const paid = !!(req.body || {}).paid;

    const [[debt]] = await pool.query('SELECT id, total_debt FROM debts WHERE id = ? AND user_id = ?', [req.params.debtId, req.userId]);
    if (!debt) return res.status(404).json({ error: 'Debt not found.' });

    const [result] = await pool.query('UPDATE debt_schedule SET paid = ? WHERE id = ? AND debt_id = ?', [paid, req.params.scheduleId, req.params.debtId]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Payment row not found.' });

    const [rows] = await pool.query('SELECT amount, paid FROM debt_schedule WHERE debt_id = ?', [req.params.debtId]);
    const currentDebt = recomputeCurrentDebt(Number(debt.total_debt), rows.map((r) => ({ amount: Number(r.amount), paid: !!r.paid })));
    await pool.query('UPDATE debts SET current_debt = ? WHERE id = ?', [currentDebt, req.params.debtId]);

    res.json({ ok: true, debt: (await loadDebts(req.userId)).find((d) => d.id === req.params.debtId) });
  } catch (err) {
    console.error('toggle debt schedule paid error:', err);
    res.status(500).json({ error: 'Could not update that payment.' });
  }
});

// ---- Investments: stock holdings. Requires login, like Accounts.
// Deliberately NOT migrated from existing local browser data — every
// account starts with no holdings. Auto-increment ids are fine here (like
// Debts/Planner): nothing else in the app references a holding by id. ----

async function loadInvestments(userId) {
  const [rows] = await pool.query('SELECT * FROM investments WHERE user_id = ? ORDER BY id', [userId]);
  return rows.map(mapInvestmentRow);
}

function mapInvestmentRow(row) {
  return {
    id: String(row.id),
    symbol: row.symbol,
    market: row.market,
    name: row.name || '',
    quantity: Number(row.quantity),
    avgCost: row.avg_cost != null ? Number(row.avg_cost) : null,
    currency: row.currency,
    currentPrice: Number(row.current_price),
    exchangeName: row.exchange_name || null,
    dayChangePercent: row.day_change_percent != null ? Number(row.day_change_percent) : null,
    lastUpdated: row.last_updated || null
  };
}

function validateInvestmentBody(body) {
  const symbol = String(body.symbol || '').trim().toUpperCase().slice(0, 40);
  const market = body.market === 'IN' ? 'IN' : (body.market === 'INTL' ? 'INTL' : null);
  const name = body.name != null ? String(body.name).trim().slice(0, 120) : '';
  const quantity = Number(body.quantity);
  const avgCostRaw = body.avgCost;
  const avgCostGiven = avgCostRaw !== null && avgCostRaw !== undefined && avgCostRaw !== '';
  const avgCost = avgCostGiven ? Number(avgCostRaw) : null;
  const currency = String(body.currency || '').trim().toUpperCase();
  const currentPrice = Number(body.currentPrice);
  const exchangeName = body.exchangeName ? String(body.exchangeName).trim().slice(0, 60) : null;
  const dayChangePercent = (body.dayChangePercent === null || body.dayChangePercent === undefined || body.dayChangePercent === '') ? null : Number(body.dayChangePercent);
  const lastUpdated = body.lastUpdated ? String(body.lastUpdated).trim().slice(0, 40) : null;

  if (!symbol) return { error: 'Symbol is required.' };
  if (!market) return { error: "Market must be 'IN' or 'INTL'." };
  if (!Number.isFinite(quantity) || quantity <= 0) return { error: 'Quantity must be a valid, positive number.' };
  if (avgCostGiven && (!Number.isFinite(avgCost) || avgCost < 0)) return { error: 'Average buy price must be a valid, non-negative number.' };
  if (!CURRENCY_RE.test(currency)) return { error: 'Currency must be a 3-letter code, e.g. INR.' };
  if (!Number.isFinite(currentPrice) || currentPrice < 0) return { error: 'Current price must be a valid, non-negative number.' };

  return {
    value: {
      symbol, market, name, quantity, avgCost, currency, currentPrice, exchangeName,
      dayChangePercent: Number.isFinite(dayChangePercent) ? dayChangePercent : null,
      lastUpdated
    }
  };
}

app.get('/api/investments', requireAuth, async (req, res) => {
  try {
    res.json({ ok: true, investments: await loadInvestments(req.userId) });
  } catch (err) {
    console.error('list investments error:', err);
    res.status(500).json({ error: 'Could not load your investments.' });
  }
});

app.post('/api/investments', requireAuth, async (req, res) => {
  try {
    const { error, value } = validateInvestmentBody(req.body || {});
    if (error) return res.status(400).json({ error });

    const [result] = await pool.query(
      `INSERT INTO investments (user_id, symbol, market, name, quantity, avg_cost, currency, current_price, exchange_name, day_change_percent, last_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.userId, value.symbol, value.market, value.name, value.quantity, value.avgCost, value.currency, value.currentPrice, value.exchangeName, value.dayChangePercent, value.lastUpdated]
    );
    res.status(201).json({ ok: true, investment: Object.assign({ id: String(result.insertId) }, value) });
  } catch (err) {
    console.error('create investment error:', err);
    res.status(500).json({ error: 'Could not add that investment. Please try again.' });
  }
});

// Registered before PUT /api/investments/:id so 'bulk-prices' is never
// mistaken for an :id value — Express matches routes in registration order.
app.put('/api/investments/bulk-prices', requireAuth, async (req, res) => {
  try {
    const updates = Array.isArray((req.body || {}).updates) ? req.body.updates : [];
    for (const u of updates) {
      const id = String(u.id || '').trim();
      if (!/^\d+$/.test(id)) continue;
      const currentPrice = Number(u.currentPrice);
      if (!Number.isFinite(currentPrice)) continue;
      // currency/exchangeName only overwrite when the refresh actually
      // returned one (COALESCE keeps the existing value otherwise), same as
      // js/stocks.js's own "if (q.currency) inv.currency = ..." logic.
      const currency = u.currency ? String(u.currency).trim().toUpperCase() : null;
      const exchangeName = u.exchangeName ? String(u.exchangeName).trim().slice(0, 60) : null;
      const dayChangePercent = (u.dayChangePercent === null || u.dayChangePercent === undefined || u.dayChangePercent === '') ? null : Number(u.dayChangePercent);
      const lastUpdated = u.lastUpdated ? String(u.lastUpdated).trim().slice(0, 40) : null;
      await pool.query(
        `UPDATE investments
         SET current_price = ?, currency = COALESCE(?, currency), exchange_name = COALESCE(?, exchange_name), day_change_percent = ?, last_updated = ?
         WHERE id = ? AND user_id = ?`,
        [currentPrice, currency, exchangeName, Number.isFinite(dayChangePercent) ? dayChangePercent : null, lastUpdated, id, req.userId]
      );
    }
    res.json({ ok: true, investments: await loadInvestments(req.userId) });
  } catch (err) {
    console.error('bulk update investment prices error:', err);
    res.status(500).json({ error: 'Could not save refreshed prices.' });
  }
});

app.put('/api/investments/:id', requireAuth, async (req, res) => {
  try {
    const { error, value } = validateInvestmentBody(req.body || {});
    if (error) return res.status(400).json({ error });

    const [result] = await pool.query(
      `UPDATE investments SET symbol=?, market=?, name=?, quantity=?, avg_cost=?, currency=?, current_price=?, exchange_name=?, day_change_percent=?, last_updated=?
       WHERE id = ? AND user_id = ?`,
      [value.symbol, value.market, value.name, value.quantity, value.avgCost, value.currency, value.currentPrice, value.exchangeName, value.dayChangePercent, value.lastUpdated, req.params.id, req.userId]
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'Investment not found.' });
    res.json({ ok: true, investment: Object.assign({}, value, { id: req.params.id }) });
  } catch (err) {
    console.error('update investment error:', err);
    res.status(500).json({ error: 'Could not save changes to that investment.' });
  }
});

app.delete('/api/investments/:id', requireAuth, async (req, res) => {
  try {
    const [result] = await pool.query('DELETE FROM investments WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Investment not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('delete investment error:', err);
    res.status(500).json({ error: 'Could not delete that investment.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Monetra server running at http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
});
