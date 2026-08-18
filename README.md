# Monetra — Personal Financial Tracking System

A private, local-first personal finance tracker: net worth across currencies,
bank accounts, daily transactions, a monthly planner, debts/EMIs, and stocks
& investments — in a light theme.

## Opening it

Double-click `index.html` to open the landing page, then click **Get
started** (or **Log in** / **Sign up**) to reach the app itself, `app.html`.
You can also open `app.html` directly and use the Monetra logo in the
sidebar to get back to the landing page. All of your financial data —
accounts, transactions, budgets, everything — is saved automatically to
this browser's local storage on this computer; none of it goes to a server.

**Sign up and login are backed by real accounts in MySQL** (see
`server/README.md` for setup). That's the one part of the app that needs a
server running — everything else still works by just opening the `.html`
files directly, no server required.

## What it does

- **Home page** — a landing page introducing Monetra, with Log in / Sign up
  links to real, MySQL-backed accounts (see `server/README.md`) that lead
  into the app, `app.html`.
- **Dashboard** — net worth in the currency of your choice, total assets,
  total debts, this month's income/expense, an assets-details chart, a
  debt-details chart, a 12-month income/expense/savings trend, actual vs.
  planned cash flow, and current investment performance.
- **Accounts** — add any number of bank or cash accounts, each with its own
  currency and balance. Not tied to any specific bank list.
- **Transactions** — record daily income and expenses against an account;
  the account balance updates automatically.
- **Monthly Planner** — set a budget per spending category (with a progress
  meter) and track recurring monthly payments/bills with due dates and a
  paid/overdue status.
- **Debts** — track total debt, current remaining debt, monthly EMI, EMI due
  day, and log EMI payments (which reduce the remaining balance).
- **Investments** — track Indian and international stock holdings, with
  optional live price refresh.
- **Currency conversion** — live exchange rates, and a display-currency
  picker on every page so your net worth always shows in the currency you
  choose (e.g. INR or EUR).

## Live data sources

**Exchange rates** update automatically (no setup needed) from
[frankfurter.app](https://www.frankfurter.app), a free service using ECB
reference rates. Rates refresh on load if they're more than an hour old, and
you can force a refresh anytime with "Refresh rates & prices" or from
Settings.

**Stock prices** use [Twelve Data](https://twelvedata.com/pricing), which
has a free tier. To enable live price refresh:

1. Sign up for a free API key at twelvedata.com.
2. Paste it into Settings → Live stock prices, and save.
3. Use "Refresh prices" on the Investments tab anytime to pull the latest
   quotes.

Symbol formats Twelve Data expects:
- International stocks: plain ticker, e.g. `AAPL`, `MSFT`, `TSLA`.
- Indian stocks: `SYMBOL:EXCHANGE`, e.g. `RELIANCE:NSE`, `TCS:NSE`,
  `INFY:BSE`.

Without an API key, everything still works — just update each stock's
current price manually on its edit screen whenever you like.

## Your data

Everything is stored in this browser's local storage on this Mac — nothing
is sent anywhere except the two live-data requests above (exchange rates and,
if configured, stock quotes). Because it's local to the browser:

- Use **Settings → Export data** regularly to save a JSON backup, especially
  before clearing browser history/data.
- Use **Settings → Import data** to restore from a backup or move your data
  to another browser/computer.
- Opening `app.html` in a different browser (or in private/incognito mode)
  starts with empty data, since local storage doesn't carry over.

## Notes on accuracy

- Net worth = (bank + cash + investment values) − debts, all converted to
  your chosen display currency at the latest available exchange rate.
- Exchange rates are ECB reference rates updated on banking days, not
  real-time interbank rates — accurate enough for personal tracking, but not
  for trading decisions.
- If a currency you use isn't in the exchange-rate list, conversion for that
  currency will pass the amount through unconverted until rates for it are
  available.

## Project structure

```
Monetra/
  index.html          Landing/home page (Log in, Sign up → app.html)
  app.html             Main app shell and navigation
  css/
    styles.css           App (light-theme) styling
    landing.css           Landing page styling, layered on styles.css
  js/
    palette.js          Color tokens
    storage.js           Local-storage state, defaults, categories
    currency.js           Exchange-rate fetch & conversion
    stocks.js               Live stock price fetch (Twelve Data)
    calc.js                   Net worth & summary calculations
    modal.js                    Shared add/edit modal helper
    dashboard.js                  Dashboard + charts
    accounts.js                    Bank & cash accounts
    transactions.js                 Income/expense transactions
    planner.js                       Monthly budgets & payments
    debts.js                          Debts & EMI tracking
    investments.js                     Stocks & investments
    settings.js                         Settings, export/import/reset
    app.js                                Navigation & init
    vendor/chart.umd.min.js               Chart.js (bundled, no CDN needed)
  README.md
```
