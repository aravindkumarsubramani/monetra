-- Run this once in MySQL Workbench (or `mysql -u root -p < schema.sql`)
-- to create Monetra's database, a dedicated app user, and the users table.

CREATE DATABASE IF NOT EXISTS monetra
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- A dedicated user for the app, rather than having the server log in as
-- root. Change 'changeme' to your own password, and use that same
-- password in server/.env. '%' (any host) avoids a common gotcha where a
-- user created for 'localhost' only doesn't match connections coming in
-- over 127.0.0.1, which is how the Node server actually connects.
CREATE USER IF NOT EXISTS 'monetra_app'@'%' IDENTIFIED BY 'changeme';
GRANT ALL PRIVILEGES ON monetra.* TO 'monetra_app'@'%';
FLUSH PRIVILEGES;

USE monetra;

CREATE TABLE IF NOT EXISTS users (
  id                   INT AUTO_INCREMENT PRIMARY KEY,
  full_name            VARCHAR(120)  NOT NULL,
  username             VARCHAR(32)   NOT NULL,
  email                VARCHAR(190)  NOT NULL,
  mobile_country_code  VARCHAR(6)    NULL,
  mobile               VARCHAR(20)   NULL,
  password_hash        VARCHAR(100)  NOT NULL,
  created_at           TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_users_username (username),
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One row per account, holding settings that must stay private to that
-- account — right now just the two stock-price API keys. Everything else
-- in Monetra (accounts, transactions, budgets, etc.) still lives only in
-- each browser's local storage, unrelated to this table.
CREATE TABLE IF NOT EXISTS user_settings (
  user_id                INT           NOT NULL PRIMARY KEY,
  twelve_data_api_key    VARCHAR(255)  NULL,
  alpha_vantage_api_key  VARCHAR(255)  NULL,
  updated_at             TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_user_settings_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- PayLater providers (Simpl, LazyPay, Amazon Pay Later, etc.) — one row per
-- provider a logged-in account has added. Requires login: unlike the rest of
-- Monetra, this data is never stored in the browser, only here.
CREATE TABLE IF NOT EXISTS paylaters (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  user_id       INT           NOT NULL,
  provider      VARCHAR(120)  NOT NULL,
  credit_limit  DECIMAL(14,2) NOT NULL DEFAULT 0,
  outstanding   DECIMAL(14,2) NOT NULL DEFAULT 0,
  currency      VARCHAR(6)    NOT NULL DEFAULT 'INR',
  notes         VARCHAR(500)  NULL,
  created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_paylaters_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One row per "Log payment" against a PayLater provider above.
CREATE TABLE IF NOT EXISTS paylater_payments (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  paylater_id   INT           NOT NULL,
  payment_date  DATE          NOT NULL,
  amount        DECIMAL(14,2) NOT NULL,
  created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_paylater_payments_paylater FOREIGN KEY (paylater_id) REFERENCES paylaters(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Bank & cash accounts. Requires login, like PayLater. Unlike PayLater
-- though, ids are NOT auto-increment — they keep the same 'acc_xxxxx' id
-- the browser originally generated (js/storage.js's uid()), because
-- existing Transactions (which stay local-only, not moving to the
-- database) reference an account by that exact id. Preserving it is what
-- keeps old transaction history correctly linked after migrating existing
-- local accounts into the database (see server.js's POST /api/migrate).
CREATE TABLE IF NOT EXISTS accounts (
  id              VARCHAR(64)   PRIMARY KEY,
  user_id         INT           NOT NULL,
  name            VARCHAR(120)  NOT NULL,
  type            ENUM('bank','cash') NOT NULL,
  currency        VARCHAR(6)    NOT NULL,
  balance         DECIMAL(14,2) NOT NULL DEFAULT 0,
  notes           VARCHAR(500)  NULL,
  country         VARCHAR(40)   NULL,
  bank            VARCHAR(120)  NULL,
  branch          VARCHAR(120)  NULL,
  account_number  VARCHAR(64)   NULL,
  ifsc            VARCHAR(20)   NULL,
  iban            VARCHAR(40)   NULL,
  bic             VARCHAR(20)   NULL,
  customer_id     VARCHAR(64)   NULL,
  created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_accounts_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_accounts_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Cards — a reference list linked to an account, same 'card_xxxxx' id
-- preservation reasoning as accounts above. account_id is intentionally
-- NOT a foreign key: deleting an account should orphan its cards (they show
-- "no linked account") rather than being blocked or cascade-deleted — that
-- matches how this already behaved locally before the database existed.
CREATE TABLE IF NOT EXISTS cards (
  id                    VARCHAR(64)   PRIMARY KEY,
  user_id               INT           NOT NULL,
  account_id            VARCHAR(64)   NULL,
  network               VARCHAR(40)   NOT NULL,
  card_type             ENUM('debit','credit') NOT NULL,
  card_number           VARCHAR(32)   NULL,
  expiry_month          TINYINT       NULL,
  expiry_year           SMALLINT      NULL,
  credit_limit          DECIMAL(14,2) NULL,
  outstanding_balance   DECIMAL(14,2) NULL,
  notes                 VARCHAR(500)  NULL,
  created_at            TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_cards_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_cards_user (user_id),
  INDEX idx_cards_account (account_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Digital wallets (Paytm, PhonePe, Google Pay, etc.) — same id-preservation
-- reasoning as accounts, though nothing else currently references a wallet
-- id, so it's mostly for consistency.
CREATE TABLE IF NOT EXISTS wallets (
  id            VARCHAR(64)   PRIMARY KEY,
  user_id       INT           NOT NULL,
  name          VARCHAR(120)  NOT NULL,
  currency      VARCHAR(6)    NOT NULL,
  balance       DECIMAL(14,2) NOT NULL DEFAULT 0,
  notes         VARCHAR(500)  NULL,
  created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_wallets_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_wallets_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Monthly Planner: budgets, planned bills, and planned income — all scoped
-- per account per calendar month (month_key, e.g. '2026-08'). Requires
-- login, like PayLater — this data was chosen NOT to be migrated from
-- existing local browser data, so every account starts with an empty
-- planner. Auto-increment ids are fine here (unlike accounts/cards/
-- wallets) since nothing else in the app references a budget/payment/
-- income by id.
CREATE TABLE IF NOT EXISTS planner_budgets (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  user_id     INT           NOT NULL,
  month_key   VARCHAR(7)    NOT NULL,
  category    VARCHAR(60)   NOT NULL,
  planned     DECIMAL(14,2) NOT NULL DEFAULT 0,
  currency    VARCHAR(6)    NOT NULL,
  created_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_planner_budgets_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_planner_budgets_user_month (user_id, month_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Planned bills/payments (the "Monthly payments & bills" section).
CREATE TABLE IF NOT EXISTS planner_payments (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  user_id     INT           NOT NULL,
  month_key   VARCHAR(7)    NOT NULL,
  name        VARCHAR(120)  NOT NULL,
  category    VARCHAR(60)   NOT NULL,
  amount      DECIMAL(14,2) NOT NULL,
  currency    VARCHAR(6)    NOT NULL,
  due_day     TINYINT       NOT NULL,
  paid        TINYINT(1)    NOT NULL DEFAULT 0,
  created_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_planner_payments_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_planner_payments_user_month (user_id, month_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Planned/expected income entries.
CREATE TABLE IF NOT EXISTS planner_incomes (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  user_id     INT           NOT NULL,
  month_key   VARCHAR(7)    NOT NULL,
  name        VARCHAR(120)  NOT NULL,
  category    VARCHAR(60)   NOT NULL,
  amount      DECIMAL(14,2) NOT NULL,
  currency    VARCHAR(6)    NOT NULL,
  created_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_planner_incomes_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_planner_incomes_user_month (user_id, month_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Transactions: the day-to-day ledger (Pay/Receive/Transfer/Withdraw/
-- Deposit). Requires login, like Accounts. Chosen NOT to migrate existing
-- local transaction history — every account starts with an empty ledger;
-- new entries go straight to the database from here on. account_id/
-- from_account_id/to_account_id intentionally have NO foreign key (same
-- reasoning as cards.account_id above): deleting an account should orphan
-- its transactions (shown as "(deleted account)") rather than blocking the
-- deletion or cascading. Ids are client-generated ('tx_xxxxx', via
-- storage.js's uid()) and preserved as the primary key.
CREATE TABLE IF NOT EXISTS transactions (
  id               VARCHAR(64)   PRIMARY KEY,
  user_id          INT           NOT NULL,
  date             DATE          NOT NULL,
  type             ENUM('expense','income','transfer','withdraw','deposit') NOT NULL,
  account_id       VARCHAR(64)   NULL,
  category         VARCHAR(60)   NULL,
  amount           DECIMAL(14,2) NOT NULL,
  currency         VARCHAR(6)    NOT NULL,
  method           VARCHAR(20)   NULL,
  note             VARCHAR(500)  NULL,
  from_account_id  VARCHAR(64)   NULL,
  to_account_id    VARCHAR(64)   NULL,
  to_amount        DECIMAL(14,2) NULL,
  to_currency      VARCHAR(6)    NULL,
  created_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_transactions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_transactions_user_date (user_id, date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Transaction templates (saved presets, e.g. "Rent") — same shape as a
-- transaction minus date, plus a name. Same id-preservation and
-- no-foreign-key-on-account-ids reasoning as transactions above.
CREATE TABLE IF NOT EXISTS transaction_templates (
  id               VARCHAR(64)   PRIMARY KEY,
  user_id          INT           NOT NULL,
  name             VARCHAR(120)  NOT NULL,
  type             ENUM('expense','income','transfer','withdraw','deposit') NOT NULL,
  account_id       VARCHAR(64)   NULL,
  category         VARCHAR(60)   NULL,
  amount           DECIMAL(14,2) NULL,
  currency         VARCHAR(6)   NULL,
  method           VARCHAR(20)   NULL,
  note             VARCHAR(500)  NULL,
  from_account_id  VARCHAR(64)   NULL,
  to_account_id    VARCHAR(64)   NULL,
  to_amount        DECIMAL(14,2) NULL,
  to_currency      VARCHAR(6)   NULL,
  created_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_transaction_templates_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_transaction_templates_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Debts (loans, EMIs, personal debts). Requires login, like Accounts.
-- Chosen NOT to migrate existing local debt data — every account starts
-- with no debts; new ones go straight to the database from here on.
-- current_debt is stored (not derived on read) so it's cheap to query, but
-- is always recomputed server-side from the schedule's paid rows whenever
-- the debt or its schedule changes — the client never sets it directly.
-- Auto-increment ids are fine here (unlike Accounts/Cards/Wallets): nothing
-- else in the app references a debt or schedule row by id.
CREATE TABLE IF NOT EXISTS debts (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  user_id       INT           NOT NULL,
  name          VARCHAR(120)  NOT NULL,
  total_debt    DECIMAL(14,2) NOT NULL,
  current_debt  DECIMAL(14,2) NOT NULL DEFAULT 0,
  currency      VARCHAR(6)    NOT NULL,
  notes         VARCHAR(500)  NULL,
  created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_debts_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_debts_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A debt's manually-built payment schedule — one row per {date, amount}
-- entry, date is optional (some debts have no fixed due date). Editing a
-- debt fully replaces its schedule rows (delete + reinsert, see
-- server.js's PUT /api/debts/:id) to match how the Edit form rebuilds the
-- whole schedule in one submission; toggling a single row's paid state
-- (the "View details" checkbox) uses its own endpoint instead.
CREATE TABLE IF NOT EXISTS debt_schedule (
  id       INT AUTO_INCREMENT PRIMARY KEY,
  debt_id  INT           NOT NULL,
  date     DATE          NULL,
  amount   DECIMAL(14,2) NOT NULL,
  paid     TINYINT(1)    NOT NULL DEFAULT 0,
  CONSTRAINT fk_debt_schedule_debt FOREIGN KEY (debt_id) REFERENCES debts(id) ON DELETE CASCADE,
  INDEX idx_debt_schedule_debt (debt_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Investment holdings (stocks). Requires login, like Accounts. Chosen NOT
-- to migrate existing local holdings — every account starts with no
-- investments; new ones go straight to the database from here on.
-- Auto-increment ids are fine here (like Debts/Planner): nothing else in
-- the app references a holding by id. last_updated is stored as the raw
-- ISO string js/stocks.js already produces (write-only metadata, never
-- parsed/sorted by the UI) rather than a DATETIME column, so no
-- timezone/format round-trip is needed.
CREATE TABLE IF NOT EXISTS investments (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  user_id             INT            NOT NULL,
  symbol              VARCHAR(40)    NOT NULL,
  market              ENUM('IN','INTL') NOT NULL,
  name                VARCHAR(120)   NULL,
  quantity            DECIMAL(18,4)  NOT NULL,
  avg_cost            DECIMAL(14,4)  NULL,
  currency            VARCHAR(6)     NOT NULL,
  current_price       DECIMAL(14,4)  NOT NULL,
  exchange_name       VARCHAR(60)    NULL,
  day_change_percent  DECIMAL(9,4)   NULL,
  last_updated        VARCHAR(40)    NULL,
  created_at          TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_investments_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_investments_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
