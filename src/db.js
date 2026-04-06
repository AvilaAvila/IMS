// src/db.js
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // required for Render PostgreSQL
});

async function query(text, params) {
  const res = await pool.query(text, params);
  return res;
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      "passwordHash" TEXT NOT NULL,
      role TEXT DEFAULT 'user',
      "createdAt" TEXT
    );
    CREATE TABLE IF NOT EXISTS ideas (
      id SERIAL PRIMARY KEY,
      "userId" INTEGER REFERENCES users(id),
      title TEXT,
      description TEXT,
      "attachmentPath" TEXT,
      "videoPath" TEXT,
      status TEXT DEFAULT 'inprogress',
      "closeJustification" TEXT,
      "createdAt" TEXT,
      "updatedAt" TEXT
    );
    CREATE TABLE IF NOT EXISTS votes (
      id SERIAL PRIMARY KEY,
      "ideaId" INTEGER REFERENCES ideas(id),
      "userId" INTEGER REFERENCES users(id),
      "createdAt" TEXT
    );
    CREATE TABLE IF NOT EXISTS comments (
      id SERIAL PRIMARY KEY,
      "ideaId" INTEGER REFERENCES ideas(id),
      "userId" INTEGER REFERENCES users(id),
      "parentCommentId" INTEGER,
      content TEXT,
      "createdAt" TEXT
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      "userId" INTEGER REFERENCES users(id),
      type TEXT,
      message TEXT,
      link TEXT,
      "isRead" INTEGER DEFAULT 0,
      "createdAt" TEXT
    );
  `);
  console.log("DB initialized");
}

module.exports = { pool, query, initDb };