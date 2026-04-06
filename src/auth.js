const bcrypt = require("bcryptjs");
const { db } = require("./db");

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

function verifyPassword(password, passwordHash) {
  return bcrypt.compareSync(password, passwordHash);
}

function attachUser(req, _res, next) {
  const id = req.session?.userId;
  if (!id) return next();
  const user = db.prepare("SELECT id, name, email, role, createdAt FROM users WHERE id = ?").get(id);
  req.user = user || null;
  next();
}

function requireAuth(req, res, next) {
  if (req.user) return next();
  // API calls should get JSON, not redirects.
  if (req.path.startsWith("/api/") || req.headers.accept?.includes("application/json")) {
    return res.status(401).json({ error: "Please sign in to continue." });
  }

  if (req.session) {
    req.session.flash = { type: "warning", message: "Please sign in to continue." };
  }
  return res.redirect("/auth");
}

module.exports = {
  normalizeEmail,
  hashPassword,
  verifyPassword,
  attachUser,
  requireAuth,
};

