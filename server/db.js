// Single shared MySQL connection pool, configured from server/.env
// (see .env.example for the fields it expects).
require('dotenv').config();
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'monetra',
  waitForConnections: true,
  connectionLimit: 10,
  // Return DATE/DATETIME columns as plain 'YYYY-MM-DD' strings instead of JS
  // Date objects — simpler to hand straight to the frontend as JSON.
  dateStrings: true,
});

module.exports = pool;
