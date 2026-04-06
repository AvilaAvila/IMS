const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const DATA_DIR = path.join(__dirname, "..", "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "app.sqlite"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      passwordHash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      createdAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ideas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      attachmentPath TEXT,
      videoPath TEXT,
      closeJustification TEXT,
      status TEXT NOT NULL DEFAULT 'inprogress',
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS votes (
      ideaId INTEGER NOT NULL,
      userId INTEGER NOT NULL,
      createdAt TEXT NOT NULL,
      PRIMARY KEY (ideaId, userId),
      FOREIGN KEY (ideaId) REFERENCES ideas(id) ON DELETE CASCADE,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ideaId INTEGER NOT NULL,
      userId INTEGER NOT NULL,
      parentCommentId INTEGER,
      content TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      FOREIGN KEY (ideaId) REFERENCES ideas(id) ON DELETE CASCADE,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      link TEXT,
      isRead INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_ideas_createdAt ON ideas(createdAt);
    CREATE INDEX IF NOT EXISTS idx_comments_ideaId ON comments(ideaId);
    CREATE INDEX IF NOT EXISTS idx_notifications_userId ON notifications(userId, isRead, createdAt);
  `);

  // Lightweight migrations for existing databases.
  const ideaColumns = db.prepare("PRAGMA table_info(ideas)").all().map((c) => c.name);
  if (!ideaColumns.includes("videoPath")) {
    db.exec("ALTER TABLE ideas ADD COLUMN videoPath TEXT");
  }
  if (!ideaColumns.includes("closeJustification")) {
    db.exec("ALTER TABLE ideas ADD COLUMN closeJustification TEXT");
  }

  const commentColumns = db.prepare("PRAGMA table_info(comments)").all().map((c) => c.name);
  if (!commentColumns.includes("parentCommentId")) {
    db.exec("ALTER TABLE comments ADD COLUMN parentCommentId INTEGER");
  }

  // Create indexes that depend on migrated columns.
  db.exec("CREATE INDEX IF NOT EXISTS idx_comments_parentId ON comments(parentCommentId)");
}

module.exports = { db, initDb };

