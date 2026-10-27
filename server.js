// City College of Davao - Faculty Evaluation server, ONLINE version (Express + PostgreSQL).
// Environment variables:  DATABASE_URL (required), ADMIN_PASSWORD (first run only), PORT (set by the host),
//                         DATABASE_SSL=false (only for a local database without SSL)
const express = require("express"), path = require("path"), crypto = require("crypto");
const { Pool } = require("pg");
const PORT = process.env.PORT || 3000;
const N_ITEMS = 19; // number of rating statements in the questionnaire (change if you edit the questionnaire)
if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is not set. Add your PostgreSQL connection string (see HOSTING-GUIDE.md)."); process.exit(1); }
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false }, max: 5 });
pool.on("error", e => console.error("Database connection error:", e.message));
const q = (t, p) => pool.query(t, p);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS students(id TEXT PRIMARY KEY);
CREATE UNIQUE INDEX IF NOT EXISTS students_lower ON students(lower(id));
CREATE TABLE IF NOT EXISTS teachers(id SERIAL PRIMARY KEY, name TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS teachers_lower ON teachers(lower(name));
CREATE TABLE IF NOT EXISTS subjects(id SERIAL PRIMARY KEY, teacher_id INT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE, name TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS subjects_uq ON subjects(teacher_id, lower(name));
CREATE TABLE IF NOT EXISTS evaluations(id SERIAL PRIMARY KEY, student_id TEXT NOT NULL, teacher_id INT NOT NULL, subject TEXT NOT NULL, ratings JSONB NOT NULL, comment TEXT, created_at TIMESTAMPTZ DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS evaluations_uq ON evaluations(lower(student_id), teacher_id, lower(subject));
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);`;

// ---- admin password (salted scrypt hash) + signed login tokens that survive restarts ----
const hash = (p, salt = crypto.randomBytes(16).toString("hex")) => salt + ":" + crypto.scryptSync(p, salt, 32).toString("hex");
const check = (p, h) => { const a = Buffer.from(hash(p, h.split(":")[0])), b = Buffer.from(h); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const getS = async k => (await q("SELECT value FROM settings WHERE key=$1", [k])).rows[0]?.value;
const putS = (k, v) => q("INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", [k, v]);
let SECRET = "";
const sig = e => crypto.createHmac("sha256", SECRET).update(String(e)).digest("hex");
const mkToken = () => { const e = Date.now() + 8 * 3600e3; return e + "." + sig(e); };
const okToken = t => { const [e, s] = String(t).split("."); if (!e || !s || +e < Date.now()) return false; const a = Buffer.from(s), b = Buffer.from(sig(e)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
async function init() {
  await q(SCHEMA);
  await q("INSERT INTO settings(key,value) VALUES('admin',$1) ON CONFLICT(key) DO NOTHING", [hash(process.env.ADMIN_PASSWORD || "admin123")]);
  await q("INSERT INTO settings(key,value) VALUES('secret',$1) ON CONFLICT(key) DO NOTHING", [crypto.randomBytes(32).toString("hex")]);
  SECRET = await getS("secret");
}

const fails = new Map();
const blocked = (k, max) => { const f = fails.get(k); return !!f && f.t > Date.now() && f.n >= max; };
const fail = k => { const f = fails.get(k); if (f && f.t > Date.now()) f.n++; else fails.set(k, { n: 1, t: Date.now() + 600000 }); };
const auth = (req, res, next) => okToken((req.headers.authorization || "").replace("Bearer ", "")) ? next() : res.status(401).json({ error: "Please log in again." });

const app = express();
app.disable("x-powered-by"); app.set("trust proxy", 1);
app.use((req, res, next) => { res.set({ "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", "X-Frame-Options": "SAMEORIGIN" }); next(); });
app.use(express.json({ limit: "500kb" }));
app.get("/healthz", (req, res) => res.send("ok"));
app.use(express.static(path.join(__dirname, "public")));
const wrap = f => (req, res) => f(req, res).catch(e => { console.error(e); res.status(500).json({ error: "Server error" }); });
const clean = x => String(x ?? "").trim().slice(0, 300);
const catalog = async () => (await q(`SELECT t.id, t.name, COALESCE(array_agg(s.name ORDER BY s.name) FILTER (WHERE s.name IS NOT NULL), '{}') AS subjects
  FROM teachers t LEFT JOIN subjects s ON s.teacher_id = t.id GROUP BY t.id ORDER BY t.name`)).rows;

// ================= STUDENT =================
app.post("/api/student/login", wrap(async (req, res) => {
  if (blocked("s" + req.ip, 60)) return res.status(429).json({ error: "Too many attempts. Please try again later." });
  const st = (await q("SELECT id FROM students WHERE lower(id)=lower($1)", [clean(req.body.id)])).rows[0];
  if (!st) { fail("s" + req.ip); return res.status(404).json({ error: "Student ID No. not found. Please check your ID or contact the administrator." }); }
  const done = (await q("SELECT teacher_id, subject FROM evaluations WHERE lower(student_id)=lower($1)", [st.id])).rows.map(x => [x.teacher_id, x.subject]);
  res.json({ id: st.id, teachers: await catalog(), done });
}));
app.post("/api/student/evaluate", wrap(async (req, res) => {
  const { id, tid, subject, ratings, comment } = req.body || {};
  const st = (await q("SELECT id FROM students WHERE lower(id)=lower($1)", [clean(id)])).rows[0];
  if (!st) return res.status(404).json({ error: "Student ID No. not found." });
  if (!Array.isArray(ratings) || ratings.length !== N_ITEMS || !ratings.every(v => Number.isInteger(v) && v >= 1 && v <= 5))
    return res.status(400).json({ error: "Please rate all statements (1 to 5)." });
  const sb = (await q("SELECT name FROM subjects WHERE teacher_id=$1 AND lower(name)=lower($2)", [Number(tid) || 0, clean(subject)])).rows[0];
  if (!sb) return res.status(400).json({ error: "Invalid teacher or subject." });
  try {
    await q("INSERT INTO evaluations(student_id,teacher_id,subject,ratings,comment) VALUES($1,$2,$3,$4,$5)",
      [st.id, Number(tid), sb.name, JSON.stringify(ratings), String(comment || "None").slice(0, 2000)]);
  } catch (e) { if (e.code === "23505") return res.status(409).json({ error: "Already evaluated." }); throw e; }
  res.json({ ok: true });
}));

// ================= ADMIN =================
app.post("/api/admin/login", wrap(async (req, res) => {
  if (blocked("a" + req.ip, 8)) return res.status(429).json({ error: "Too many wrong attempts. Try again in 10 minutes." });
  if (!check(String(req.body.password || ""), await getS("admin"))) { fail("a" + req.ip); return res.status(401).json({ error: "Incorrect password." }); }
  res.json({ token: mkToken() });
}));
app.get("/api/admin/data", auth, wrap(async (req, res) => res.json({
  students: (await q("SELECT id FROM students ORDER BY id")).rows.map(x => x.id),
  teachers: await catalog(),
  evals: (await q("SELECT student_id, teacher_id, subject, ratings, comment, created_at FROM evaluations")).rows
    .map(e => ({ sid: e.student_id, tid: e.teacher_id, s: e.subject, r: e.ratings, c: e.comment, d: e.created_at }))
})));
app.post("/api/admin/students", auth, wrap(async (req, res) => {
  const ids = (req.body.ids || []).map(clean).filter(Boolean);
  const r = ids.length ? await q("INSERT INTO students(id) SELECT x FROM unnest($1::text[]) AS x ON CONFLICT DO NOTHING", [ids]) : { rowCount: 0 };
  res.json({ added: r.rowCount, skipped: ids.length - r.rowCount });
}));
app.delete("/api/admin/students/:id", auth, wrap(async (req, res) => { await q("DELETE FROM students WHERE id=$1", [req.params.id]); res.json({ ok: true }); }));
app.post("/api/admin/teachers", auth, wrap(async (req, res) => { const n = clean(req.body.name); if (n) await q("INSERT INTO teachers(name) VALUES($1) ON CONFLICT DO NOTHING", [n]); res.json({ ok: true }); }));
app.delete("/api/admin/teachers/:id", auth, wrap(async (req, res) => { await q("DELETE FROM teachers WHERE id=$1", [Number(req.params.id) || 0]); res.json({ ok: true }); }));
app.post("/api/admin/teachers/:id/subjects", auth, wrap(async (req, res) => {
  const n = clean(req.body.name); if (n) await q("INSERT INTO subjects(teacher_id,name) VALUES($1,$2) ON CONFLICT DO NOTHING", [Number(req.params.id) || 0, n]); res.json({ ok: true });
}));
app.post("/api/admin/teachers/:id/subjects/delete", auth, wrap(async (req, res) => {
  await q("DELETE FROM subjects WHERE teacher_id=$1 AND name=$2", [Number(req.params.id) || 0, clean(req.body.name)]); res.json({ ok: true });
}));
app.post("/api/admin/import-faculty", auth, wrap(async (req, res) => {
  let t0 = 0, s0 = 0; const c = await pool.connect();
  try {
    await c.query("BEGIN");
    for (let [name, subj] of (req.body.rows || [])) {
      name = clean(name); subj = clean(subj); if (!name) continue;
      t0 += (await c.query("INSERT INTO teachers(name) VALUES($1) ON CONFLICT DO NOTHING", [name])).rowCount;
      const id = (await c.query("SELECT id FROM teachers WHERE lower(name)=lower($1)", [name])).rows[0].id;
      if (subj) s0 += (await c.query("INSERT INTO subjects(teacher_id,name) VALUES($1,$2) ON CONFLICT DO NOTHING", [id, subj])).rowCount;
    }
    await c.query("COMMIT");
  } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
  res.json({ teachers: t0, subjects: s0 });
}));
app.post("/api/admin/password", auth, wrap(async (req, res) => {
  const p = String(req.body.password || ""); if (p.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters." });
  await putS("admin", hash(p)); res.json({ ok: true });
}));
app.delete("/api/admin/evaluations", auth, wrap(async (req, res) => { await q("DELETE FROM evaluations"); res.json({ ok: true }); }));

init().then(() => app.listen(PORT, "0.0.0.0", () => console.log(`Faculty Evaluation server running on port ${PORT}`)))
  .catch(e => { console.error("Startup failed:", e.message); process.exit(1); });
