const path = require("path");
const express = require("express");
const expressLayouts = require("express-ejs-layouts");
const helmet = require("helmet");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const multer = require("multer");
const crypto = require("crypto");
const cloudinary = require("cloudinary").v2;
const { CloudinaryStorage } = require("multer-storage-cloudinary");

const { pool, initDb } = require("./src/db");
const { requireAuth, attachUser, hashPassword, verifyPassword, normalizeEmail } = require("./src/auth");
const { ideaStatusLabel, isValidIdeaStatus } = require("./src/ideas");

const PORT = process.env.PORT || 3000;

// ── Cloudinary config ──────────────────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const cloudinaryStorage = new CloudinaryStorage({
  cloudinary,
  params: async (_req, file) => ({
    folder: "ims-uploads",
    resource_type: file.mimetype.startsWith("video") ? "video" : "image",
    public_id: `${Date.now()}-${crypto.randomBytes(6).toString("hex")}`,
  }),
});

const upload = multer({
  storage: cloudinaryStorage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = [
      "image/png", "image/jpeg", "image/webp", "image/gif",
      "video/mp4", "video/webm", "video/quicktime",
    ].includes(file.mimetype);
    cb(ok ? null : new Error("Only image/video uploads are allowed."), ok);
  },
});

// ── App setup ──────────────────────────────────────────────────────────────────
const app = express();
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "src", "views"));
app.set("layout", path.join("partials", "layout"));
app.use(expressLayouts);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());


app.set("trust proxy", 1);
app.use(
  session({
    store: new pgSession({
      pool,
      tableName: "session",
      createTableIfMissing: true,
    }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      sameSite: "lax",
      secure: true, // 🔥 important for Render (HTTPS)
    },
  })
);

// app.use(
//   session({
//     store: new pgSession({
//       pool,
//       tableName: "session",
//       createTableIfMissing: true,
//     }),
//     secret: process.env.SESSION_SECRET || "dev-secret-change-me",
//     resave: false,
//     saveUninitialized: false,
//     cookie: { sameSite: "lax" },
//   })
// );

app.use("/public", express.static(path.join(__dirname, "public")));

app.use(attachUser);

// ── Flash helpers ──────────────────────────────────────────────────────────────
function setFlash(req, type, message) {
  if (!req.session) return;
  req.session.flash = { type, message };
}

function consumeFlash(req) {
  const flash = req.session.flash;
  delete req.session.flash;
  return flash;
}

function wantsJson(req) {
  return req.path.startsWith("/api/") || req.headers.accept?.includes("application/json");
}

app.use((req, res, next) => {
  res.locals.user  = req.user || null;
  res.locals.flash = consumeFlash(req);
  res.locals.path  = req.path;
  next();
});

// ── Routes ─────────────────────────────────────────────────────────────────────

app.get("/", async (req, res, next) => {
  try {
    const { rows: ideas } = await pool.query(`
      SELECT i.*, u.name as "authorName",
        (SELECT COUNT(*) FROM votes v WHERE v."ideaId" = i.id)::int    as "voteCount",
        (SELECT COUNT(*) FROM comments c WHERE c."ideaId" = i.id)::int as "commentCount"
      FROM ideas i
      JOIN users u ON u.id = i."userId"
      ORDER BY i."createdAt" DESC
    `);
    res.render("home", { title: "Home", ideas, ideaStatusLabel });
  } catch (e) { next(e); }
});

app.get("/about", (_req, res) => res.render("about", { title: "About" }));
app.get("/help",  (_req, res) => res.render("help",  { title: "Help & FAQ" }));

app.get("/achievers", async (_req, res, next) => {
  try {
    const { rows: topIdeas } = await pool.query(`
      SELECT i.*, u.name as "authorName",
        (SELECT COUNT(*) FROM votes v WHERE v."ideaId" = i.id)::int as "voteCount"
      FROM ideas i
      JOIN users u ON u.id = i."userId"
      ORDER BY "voteCount" DESC, i."createdAt" DESC
      LIMIT 10
    `);
    const { rows: topUsers } = await pool.query(`
      SELECT u.id, u.name, u.email,
        (SELECT COUNT(*) FROM ideas i WHERE i."userId" = u.id)::int                                  as "ideaCount",
        (SELECT COUNT(*) FROM votes v JOIN ideas i ON i.id = v."ideaId" WHERE i."userId" = u.id)::int as "receivedVotes"
      FROM users u
      ORDER BY "receivedVotes" DESC, "ideaCount" DESC, u."createdAt" ASC
      LIMIT 10
    `);
    res.render("achievers", { title: "Achievers", topIdeas, topUsers, ideaStatusLabel });
  } catch (e) { next(e); }
});

// ── Auth ───────────────────────────────────────────────────────────────────────

app.get("/auth", (req, res) => {
  if (req.user) return res.redirect("/");
  res.render("auth", { title: "Sign in" });
});

app.post("/auth/signup", async (req, res, next) => {
  try {
    const name     = (req.body.name || "").trim();
    const email    = normalizeEmail(req.body.email);
    const password = req.body.password || "";

    if (!name || !email || password.length < 6) {
      setFlash(req, "danger", "Enter name, valid email, and password (min 6 chars).");
      return res.redirect("/auth");
    }

    const { rows: existing } = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
    if (existing.length) {
      setFlash(req, "danger", "That email is already registered. Please sign in.");
      return res.redirect("/auth");
    }

    const { rows: countRows } = await pool.query("SELECT COUNT(*) as c FROM users");
    const isFirstUser = parseInt(countRows[0].c) === 0;
    const role = isFirstUser ? "admin" : "user";
    const now  = new Date().toISOString();

    const { rows: inserted } = await pool.query(
      `INSERT INTO users (name, email, "passwordHash", role, "createdAt") VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [name, email, hashPassword(password), role, now]
    );

    req.session.userId = inserted[0].id;
    setFlash(req, "success", "Welcome! Your account is ready.");
    res.redirect("/");
  } catch (e) { next(e); }
});

app.post("/auth/signin", async (req, res, next) => {
  try {
    const email    = normalizeEmail(req.body.email);
    const password = req.body.password || "";

    const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    const user = rows[0];
    if (!user || !verifyPassword(password, user.passwordHash)) {
      setFlash(req, "danger", "Invalid email or password.");
      return res.redirect("/auth");
    }

    req.session.userId = user.id;
    setFlash(req, "success", `Welcome back, ${user.name}.`);
    res.redirect("/");
  } catch (e) { next(e); }
});

app.post("/auth/signout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

// ── Ideas ──────────────────────────────────────────────────────────────────────

app.get("/ideas/new", requireAuth, (_req, res) => {
  res.render("idea_new", { title: "Submit idea" });
});

app.post(
  "/ideas",
  requireAuth,
  upload.fields([{ name: "attachment", maxCount: 1 }, { name: "video", maxCount: 1 }]),
  async (req, res, next) => {
    try {
      const title       = (req.body.title || "").trim();
      const description = (req.body.description || "").trim();

      if (!title || description.length < 10) {
        setFlash(req, "danger", "Title is required and description must be at least 10 characters.");
        return res.redirect("/ideas/new");
      }

      // Cloudinary returns the hosted URL in file.path
      const attachmentPath = req.files?.attachment?.[0]?.path || null;
      const videoPath      = req.files?.video?.[0]?.path      || null;

      const now    = new Date().toISOString();
      const status = "inprogress";

      const { rows } = await pool.query(
        `INSERT INTO ideas ("userId", title, description, "attachmentPath", "videoPath", status, "createdAt", "updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [req.user.id, title, description, attachmentPath, videoPath, status, now, now]
      );

      setFlash(req, "success", "Idea submitted. You can track status in My Ideas.");
      res.redirect(`/ideas/${rows[0].id}`);
    } catch (e) { next(e); }
  }
);

// ── AI enhance ────────────────────────────────────────────────────────────────

app.post("/api/enhance-description", requireAuth, async (req, res) => {
  const input    = String(req.body?.text || "").trim();
  if (input.length < 5) return res.status(400).json({ error: "Please enter more text to enhance." });

  const provider = String(process.env.AI_PROVIDER || "").trim().toLowerCase() || "ollama";

  try {
    const prompt =
      "Improve the following idea description. Return ONLY the improved description text. " +
      "Keep it concise, clear, and structured with short paragraphs and optional bullet points.\n\n" + input;

    if (provider === "openai") {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) return res.status(501).json({ error: "OpenAI is not configured. Set OPENAI_API_KEY." });

      const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL || "gpt-4o-mini",
          temperature: 0.3,
          messages: [
            { role: "system", content: "You improve user-submitted ideas. Return ONLY the improved description." },
            { role: "user",   content: input },
          ],
        }),
      });
      if (!resp.ok) return res.status(502).json({ error: `OpenAI error: ${(await resp.text()).slice(0, 300)}` });
      const data = await resp.json();
      const text = data?.choices?.[0]?.message?.content?.trim();
      if (!text) return res.status(502).json({ error: "OpenAI returned no text." });
      return res.json({ text });
    }

    if (provider === "ollama") {
      const baseUrl = process.env.OLLAMA_URL   || "http://localhost:11434";
      const model   = process.env.OLLAMA_MODEL || "llama3.1";
      const resp = await fetch(`${baseUrl}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, prompt, stream: false, options: { temperature: 0.3 } }),
      });
      if (!resp.ok) return res.status(502).json({ error: `Ollama error: ${(await resp.text()).slice(0, 300)}` });
      const data = await resp.json();
      const text = String(data?.response || "").trim();
      if (!text) return res.status(502).json({ error: "Ollama returned no text." });
      return res.json({ text });
    }

    // Fallback — no AI configured
    const cleaned = input.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    return res.json({
      text: `Problem / Context:\n${cleaned}\n\nProposed solution:\n- \n\nExpected impact:\n- \n\nNotes:\n- `,
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Failed to enhance text." });
  }
});

// ── Duplicate check ───────────────────────────────────────────────────────────

function normalizeTitle(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}
function trigramSet(s) {
  const t = `  ${normalizeTitle(s)}  `;
  const set = new Set();
  for (let i = 0; i < t.length - 2; i++) set.add(t.slice(i, i + 3));
  return set;
}
function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const uni = a.size + b.size - inter;
  return uni ? inter / uni : 0;
}

app.get("/api/ideas/duplicate-check", requireAuth, async (req, res, next) => {
  try {
    const title = String(req.query.title || "").trim();
    if (title.length < 3) return res.json({ percent: 0, bestMatch: null });

    const { rows: titles } = await pool.query(
      `SELECT id, title FROM ideas ORDER BY "createdAt" DESC LIMIT 500`
    );
    if (!titles.length) return res.json({ percent: 0, bestMatch: null });

    const base = trigramSet(title);
    let best = { percent: 0, id: null, title: null };
    for (const row of titles) {
      const percent = Math.round(jaccard(base, trigramSet(row.title)) * 100);
      if (percent > best.percent) best = { percent, id: row.id, title: row.title };
    }
    return res.json({ percent: best.percent, bestMatch: best.id ? { id: best.id, title: best.title } : null });
  } catch (e) { next(e); }
});

// ── Idea view ─────────────────────────────────────────────────────────────────

app.get("/ideas/:id", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { rows: ideaRows } = await pool.query(`
      SELECT i.*, u.name as "authorName",
        (SELECT COUNT(*) FROM votes v WHERE v."ideaId" = i.id)::int as "voteCount"
      FROM ideas i
      JOIN users u ON u.id = i."userId"
      WHERE i.id = $1
    `, [id]);

    if (!ideaRows.length) return res.status(404).render("not_found", { title: "Not found" });
    const idea = ideaRows[0];

    const { rows: comments } = await pool.query(`
      SELECT c.*, u.name as "authorName"
      FROM comments c
      JOIN users u ON u.id = c."userId"
      WHERE c."ideaId" = $1
      ORDER BY c."createdAt" ASC
    `, [id]);

    let hasVoted = false;
    if (req.user) {
      const { rows: vr } = await pool.query(
        `SELECT 1 FROM votes WHERE "ideaId" = $1 AND "userId" = $2`, [id, req.user.id]
      );
      hasVoted = vr.length > 0;
    }

    res.render("idea_view", { title: idea.title, idea, comments, hasVoted, ideaStatusLabel });
  } catch (e) { next(e); }
});

// ── Votes (HTML form) ─────────────────────────────────────────────────────────

app.post("/ideas/:id/vote", requireAuth, async (req, res, next) => {
  try {
    const id  = Number(req.params.id);
    const now = new Date().toISOString();
    const { rows: ideaRows } = await pool.query("SELECT * FROM ideas WHERE id = $1", [id]);
    if (!ideaRows.length) return res.status(404).render("not_found", { title: "Not found" });
    const idea = ideaRows[0];

    const { rows: existing } = await pool.query(
      `SELECT 1 FROM votes WHERE "ideaId" = $1 AND "userId" = $2`, [id, req.user.id]
    );
    if (existing.length) {
      await pool.query(`DELETE FROM votes WHERE "ideaId" = $1 AND "userId" = $2`, [id, req.user.id]);
      setFlash(req, "info", "Vote removed.");
    } else {
      await pool.query(`INSERT INTO votes ("ideaId", "userId", "createdAt") VALUES ($1,$2,$3)`, [id, req.user.id, now]);
      if (idea.userId !== req.user.id) {
        await pool.query(
          `INSERT INTO notifications ("userId", type, message, link, "isRead", "createdAt") VALUES ($1,$2,$3,$4,0,$5)`,
          [idea.userId, "vote", `${req.user.name} voted for your idea: "${idea.title}"`, `/ideas/${id}`, now]
        );
      }
      setFlash(req, "success", "Thanks for voting!");
    }
    res.redirect(req.get("referer") || `/ideas/${id}`);
  } catch (e) { next(e); }
});

// ── Votes (API) ───────────────────────────────────────────────────────────────

app.post("/api/ideas/:id/vote", requireAuth, async (req, res, next) => {
  try {
    const id  = Number(req.params.id);
    const now = new Date().toISOString();
    const { rows: ideaRows } = await pool.query("SELECT * FROM ideas WHERE id = $1", [id]);
    if (!ideaRows.length) return res.status(404).json({ error: "Not found" });
    const idea = ideaRows[0];

    const { rows: existing } = await pool.query(
      `SELECT 1 FROM votes WHERE "ideaId" = $1 AND "userId" = $2`, [id, req.user.id]
    );
    let hasVoted;
    if (existing.length) {
      await pool.query(`DELETE FROM votes WHERE "ideaId" = $1 AND "userId" = $2`, [id, req.user.id]);
      hasVoted = false;
    } else {
      await pool.query(`INSERT INTO votes ("ideaId", "userId", "createdAt") VALUES ($1,$2,$3)`, [id, req.user.id, now]);
      hasVoted = true;
      if (idea.userId !== req.user.id) {
        await pool.query(
          `INSERT INTO notifications ("userId", type, message, link, "isRead", "createdAt") VALUES ($1,$2,$3,$4,0,$5)`,
          [idea.userId, "vote", `${req.user.name} voted for your idea: "${idea.title}"`, `/ideas/${id}`, now]
        );
      }
    }
    const { rows: vc } = await pool.query(`SELECT COUNT(*)::int as c FROM votes WHERE "ideaId" = $1`, [id]);
    return res.json({ ideaId: id, voteCount: vc[0].c, hasVoted });
  } catch (e) { next(e); }
});

// ── Comments (HTML form) ──────────────────────────────────────────────────────

app.post("/ideas/:id/comments", requireAuth, async (req, res, next) => {
  try {
    const id            = Number(req.params.id);
    const content       = (req.body.content || "").trim();
    const parentCommentId = req.body.parentCommentId ? Number(req.body.parentCommentId) : null;

    if (content.length < 2) {
      setFlash(req, "danger", "Comment is too short.");
      return res.redirect(`/ideas/${id}`);
    }

    const { rows: ideaRows } = await pool.query("SELECT * FROM ideas WHERE id = $1", [id]);
    if (!ideaRows.length) return res.status(404).render("not_found", { title: "Not found" });
    const idea = ideaRows[0];

    const now = new Date().toISOString();
    await pool.query(
      `INSERT INTO comments ("ideaId", "userId", "parentCommentId", content, "createdAt") VALUES ($1,$2,$3,$4,$5)`,
      [id, req.user.id, parentCommentId, content, now]
    );

    if (idea.userId !== req.user.id) {
      await pool.query(
        `INSERT INTO notifications ("userId", type, message, link, "isRead", "createdAt") VALUES ($1,$2,$3,$4,0,$5)`,
        [idea.userId, "comment", `${req.user.name} commented on your idea: "${idea.title}"`, `/ideas/${id}`, now]
      );
    }

    setFlash(req, "success", "Comment posted.");
    res.redirect(`/ideas/${id}#comments`);
  } catch (e) { next(e); }
});

// ── Comments (API GET) ────────────────────────────────────────────────────────

app.get("/api/ideas/:id/comments", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { rows: ideaRows } = await pool.query("SELECT id FROM ideas WHERE id = $1", [id]);
    if (!ideaRows.length) return res.status(404).json({ error: "Not found" });

    const { rows } = await pool.query(`
      SELECT c.*, u.name as "authorName"
      FROM comments c
      JOIN users u ON u.id = c."userId"
      WHERE c."ideaId" = $1
      ORDER BY c."createdAt" ASC
    `, [id]);
    return res.json({ ideaId: id, comments: rows });
  } catch (e) { next(e); }
});

// ── Comments (API POST) ───────────────────────────────────────────────────────

app.post("/api/ideas/:id/comments", requireAuth, async (req, res, next) => {
  try {
    const id            = Number(req.params.id);
    const content       = String(req.body?.content || "").trim();
    const parentCommentId = req.body?.parentCommentId ? Number(req.body.parentCommentId) : null;

    if (content.length < 2) return res.status(400).json({ error: "Comment is too short." });

    const { rows: ideaRows } = await pool.query("SELECT * FROM ideas WHERE id = $1", [id]);
    if (!ideaRows.length) return res.status(404).json({ error: "Not found" });
    const idea = ideaRows[0];

    if (parentCommentId) {
      const { rows: pr } = await pool.query(
        `SELECT id, "ideaId" FROM comments WHERE id = $1`, [parentCommentId]
      );
      if (!pr.length || pr[0].ideaId !== id) return res.status(400).json({ error: "Invalid parent comment." });
    }

    const now = new Date().toISOString();
    const { rows: inserted } = await pool.query(
      `INSERT INTO comments ("ideaId", "userId", "parentCommentId", content, "createdAt") VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [id, req.user.id, parentCommentId, content, now]
    );

    if (idea.userId !== req.user.id) {
      await pool.query(
        `INSERT INTO notifications ("userId", type, message, link, "isRead", "createdAt") VALUES ($1,$2,$3,$4,0,$5)`,
        [idea.userId, "comment", `${req.user.name} commented on your idea: "${idea.title}"`, `/ideas/${id}`, now]
      );
    }

    const { rows: cc } = await pool.query(`SELECT COUNT(*)::int as c FROM comments WHERE "ideaId" = $1`, [id]);
    return res.json({ ideaId: id, commentId: inserted[0].id, commentCount: cc[0].c });
  } catch (e) { next(e); }
});

// ── My Ideas ──────────────────────────────────────────────────────────────────

app.get("/my-ideas", requireAuth, async (req, res, next) => {
  try {
    const { rows: ideas } = await pool.query(`
      SELECT i.*,
        (SELECT COUNT(*) FROM votes v WHERE v."ideaId" = i.id)::int    as "voteCount",
        (SELECT COUNT(*) FROM comments c WHERE c."ideaId" = i.id)::int as "commentCount"
      FROM ideas i
      WHERE i."userId" = $1
      ORDER BY i."createdAt" DESC
    `, [req.user.id]);
    res.render("my_ideas", { title: "My Ideas", ideas, ideaStatusLabel });
  } catch (e) { next(e); }
});

// ── Profile & Inbox ───────────────────────────────────────────────────────────

app.get("/profile", requireAuth, (_req, res) => res.render("profile", { title: "Profile" }));

app.get("/inbox", requireAuth, async (req, res, next) => {
  try {
    const { rows: notifications } = await pool.query(
      `SELECT * FROM notifications WHERE "userId" = $1 ORDER BY "createdAt" DESC LIMIT 50`,
      [req.user.id]
    );
    res.render("inbox", { title: "Inbox", notifications });
  } catch (e) { next(e); }
});

app.post("/inbox/mark-read", requireAuth, async (req, res, next) => {
  try {
    await pool.query(`UPDATE notifications SET "isRead" = 1 WHERE "userId" = $1`, [req.user.id]);
    res.redirect("/inbox");
  } catch (e) { next(e); }
});

// ── Admin ─────────────────────────────────────────────────────────────────────

app.get("/admin/ideas", requireAuth, async (req, res, next) => {
  if (req.user.role !== "admin") return res.status(403).render("forbidden", { title: "Forbidden" });
  try {
    const { rows: ideas } = await pool.query(`
      SELECT i.*, u.name as "authorName"
      FROM ideas i
      JOIN users u ON u.id = i."userId"
      ORDER BY i."createdAt" DESC
    `);
    res.render("admin_ideas", { title: "Admin: Ideas", ideas, ideaStatusLabel });
  } catch (e) { next(e); }
});

app.get("/admin/dashboard", requireAuth, async (req, res, next) => {
  if (req.user.role !== "admin") return res.status(403).render("forbidden", { title: "Forbidden" });
  try {
    const count = async (where) => {
      const { rows } = await pool.query(`SELECT COUNT(*)::int as c FROM ideas${where}`);
      return rows[0].c;
    };
    const { rows: uc }  = await pool.query("SELECT COUNT(*)::int as c FROM users");
    const stats = {
      userCount:       uc[0].c,
      ideaCount:       await count(""),
      inprogressCount: await count(` WHERE status = 'inprogress'`),
      approvedCount:   await count(` WHERE status = 'approved'`),
      closedCount:     await count(` WHERE status = 'closed'`),
    };
    res.render("admin_dashboard", { title: "Admin: Dashboard", stats });
  } catch (e) { next(e); }
});

app.post("/admin/ideas/:id/status", requireAuth, async (req, res, next) => {
  if (req.user.role !== "admin") return res.status(403).render("forbidden", { title: "Forbidden" });
  try {
    const id               = Number(req.params.id);
    const status           = (req.body.status || "").trim();
    const closeJustification = String(req.body.closeJustification || "").trim();

    if (!isValidIdeaStatus(status)) {
      setFlash(req, "danger", "Invalid status.");
      return res.redirect("/admin/ideas");
    }

    const { rows: ideaRows } = await pool.query("SELECT * FROM ideas WHERE id = $1", [id]);
    if (!ideaRows.length) return res.status(404).render("not_found", { title: "Not found" });
    const idea = ideaRows[0];

    if (status === "closed" && closeJustification.length < 5) {
      setFlash(req, "danger", "Closing requires a short justification (min 5 chars).");
      return res.redirect("/admin/ideas");
    }

    const now = new Date().toISOString();
    await pool.query(
      `UPDATE ideas SET status = $1, "closeJustification" = $2, "updatedAt" = $3 WHERE id = $4`,
      [status, status === "closed" ? closeJustification : null, now, id]
    );

    if (idea.userId) {
      await pool.query(
        `INSERT INTO notifications ("userId", type, message, link, "isRead", "createdAt") VALUES ($1,$2,$3,$4,0,$5)`,
        [idea.userId, "status", `Your idea "${idea.title}" is now ${ideaStatusLabel(status)}.`, `/ideas/${id}`, now]
      );
    }

    setFlash(req, "success", "Status updated.");
    res.redirect("/admin/ideas");
  } catch (e) { next(e); }
});

// ── 404 & Error handlers ──────────────────────────────────────────────────────

app.use((_req, res) => res.status(404).render("not_found", { title: "Not found" }));

app.use((err, req, res, _next) => {
  console.error(err);
  if (wantsJson(req)) return res.status(500).json({ error: err.message || "Something went wrong." });
  setFlash(req, "danger", err.message || "Something went wrong.");
  return res.redirect(req.get("referer") || "/");
});

// ── Start ─────────────────────────────────────────────────────────────────────

initDb().then(() => {
  app.listen(PORT, () => console.log(`IMS Ideas running at http://localhost:${PORT}`));
}).catch((err) => {
  console.error("Failed to initialize DB:", err);
  process.exit(1);
});