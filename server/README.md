# Monetra server — MySQL-backed sign up / login

This is a small Node.js (Express) server that gives the **sign up** and
**login** pages a real backend, storing accounts in MySQL. Nothing else in
Monetra needs it — the app itself (`app.html`) still keeps all your
financial data in the browser's local storage, exactly as before. This
server only handles creating an account and checking a password.

## What you need

- **MySQL Server** running locally, with **MySQL Workbench** to run one
  setup script against it (you already have this).
- **Node.js** (version 18 or newer). Check with:
  ```
  node -v
  ```
  If that fails, install it either with [Homebrew](https://brew.sh):
  ```
  brew install node
  ```
  or by downloading the macOS installer from https://nodejs.org (choose the
  **LTS** version).

## 1. Create the database

Open **MySQL Workbench**, connect to your local MySQL instance, then open
and run `server/schema.sql` (File → Open SQL Script… → select the file →
the lightning-bolt "Execute" button, or select all and hit ⌘+Enter).

That script creates:
- a `monetra` database
- a dedicated `monetra_app` MySQL user (password `changeme` by default —
  see the note in the script if you'd rather set your own)
- a `users` table for accounts (name, username, email, mobile, and a
  bcrypt password hash — never a plain-text password)

## 2. Configure the server

In `server/`, copy the example env file:
```
cp .env.example .env
```
Open `server/.env` and check the values match what you used in step 1 —
if you left `schema.sql`'s default password as `changeme`, the `.env`
defaults already match and you don't need to change anything.

`.env` is where your MySQL password lives locally — it's already excluded
from anything you'd share or commit.

## 3. Install and run

From inside the `server/` folder:
```
npm install
npm start
```
You should see:
```
Monetra server running at http://localhost:3000
Health check: http://localhost:3000/api/health
```
Visit `http://localhost:3000/api/health` in a browser — it should say
`{"ok":true,"db":"connected"}`. If it instead reports a connection error,
double-check MySQL Server is running and that `server/.env` matches the
user/password from `schema.sql`.

## 4. Use the site

With the server running, open **`http://localhost:3000`** in your browser
(not by double-clicking the `.html` files anymore — sign up and login only
work when the page is served by this server, since that's what lets them
call the `/api/signup` and `/api/login` endpoints). Everything else —
the landing page, `app.html`, Terms, Privacy — is served from the same
place and works exactly as before.

If you open `signup.html` or `login.html` directly as a file instead, the
form will show a message explaining it can't reach the server, rather than
failing silently.

## What's actually stored

Only account basics: full name, username, email, mobile number, and a
salted **bcrypt hash** of the password (never the password itself). On a
successful sign up or login, those same details are copied into the
browser's local storage so the app's Profile tab shows your real account —
everything else (accounts, transactions, budgets, etc.) still lives only
in that browser's local storage, per Monetra's existing trial-version
design.

## Stopping the server

`Ctrl+C` in the terminal where `npm start` is running.
