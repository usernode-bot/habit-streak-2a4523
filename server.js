const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// The platform signs user-identity tokens with an RSA private key it never
// shares. Containers get only the PUBLIC half, so this app can verify who a
// user is but cannot mint an identity — and neither can any other app.
const JWT_PUBLIC_KEY = (process.env.USERNODE_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Tokens are minted for one app: the audience is this app's numeric id, so a
// token issued for a different app is rejected below rather than accepted as
// a valid user.
const APP_AUDIENCE = process.env.USERNODE_APP_ID
  ? 'usernode:app:' + process.env.USERNODE_APP_ID
  : null;

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health']);

app.use(express.json());

// The platform's three centrally hosted files — the bridge, the native UI
// kit and the Tailwind runtime — are reachable at these paths on this app's
// OWN origin, so index.html can load them with a RELATIVE path and never
// name the platform's hostname. A hostname baked into an app is what breaks
// every app at once when the platform's domain moves.
//
// In production and on a staging preview the platform's edge answers these
// before the request ever reaches this process (a per-app Ingress rule on
// Kubernetes, the wildcard site's matcher on the docker runtime). This
// handler is what makes the same relative paths work under a plain
// `node server.js`, where there is no edge in front of the app at all.
//
// Registered BEFORE the auth middleware because these three files are
// public: the platform serves them anonymously from any app origin, and a
// login redirect arriving where a <script> was expected is exactly the
// failure a relative path is meant to avoid.
// The platform's origin, at RUNTIME, and ONLY from the variable the platform
// injects. No hostname is written into this file: a baked-in one is what left
// the whole fleet pointing at a domain the platform had moved away from.
// Unset only outside the platform (a plain local `node server.js`) — set
// USERNODE_PLATFORM_ORIGIN there too if you want the hosted assets locally.
const PLATFORM_ORIGIN = (process.env.USERNODE_PLATFORM_ORIGIN || '')
  .replace(/\/+$/, '');

app.get(/^\/usernode-(?:bridge|native|tailwind)\//, async (req, res) => {
  try {
    if (!PLATFORM_ORIGIN) return res.sendStatus(503);
    const upstream = await fetch(PLATFORM_ORIGIN + req.path);
    if (!upstream.ok) return res.sendStatus(upstream.status);
    const type = upstream.headers.get('content-type');
    if (type) res.type(type);
    // max-age=0 with revalidation, never a long TTL: the whole point of
    // central hosting is that a platform-side fix lands on the next load.
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    return res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.warn('hosted asset fetch failed: ' + err.message);
    return res.sendStatus(502);
  }
});

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds `?token=…`
// on load; the frontend script forwards the token via `x-usernode-token`
// on subsequent fetches.
app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_PUBLIC_KEY && APP_AUDIENCE) {
    try {
      // Pin the algorithm, issuer and audience. Without `algorithms` a
      // caller could hand us an HS256 token signed with the public PEM
      // (which every app knows) and forge any user.
      const claims = jwt.verify(token, JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: 'usernode',
        audience: APP_AUDIENCE,
      });
      // `pur` names what the token is for. Only user-identity tokens
      // authenticate a person here.
      if (claims && claims.pur === 'iframe') req.user = claims;
    } catch {}
  }

  // Static assets (CSS/JS/images) are always served; the API and the HTML
  // shell are gated so direct hits to the staging/prod subdomain don't
  // leak app data to the public internet.
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// ---------------------------------------------------------------------------
// Habit Streak
// ---------------------------------------------------------------------------

// Days are UTC calendar dates ('YYYY-MM-DD'). Everyone in one small group
// shares the board, so one shared clock keeps streaks comparable.
function dayStr(d) {
  return d.toISOString().slice(0, 10);
}

// Current streak: consecutive checked days ending today — or ending
// yesterday when today isn't checked yet, so a streak never reads as broken
// before the day is over.
function currentStreak(days) {
  let cursor = new Date();
  if (!days.has(dayStr(cursor))) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  let streak = 0;
  while (days.has(dayStr(cursor))) {
    streak++;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return streak;
}

// Serialize one habit row (with its day set) into the card shape the
// frontend renders, including the last 30 days as dots.
function habitCard(id, name, username, mine, days) {
  const dots = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    dots.push(days.has(dayStr(d)));
  }
  const streak = currentStreak(days);
  return {
    id,
    name,
    username,
    mine,
    streak,
    doneToday: days.has(dayStr(new Date())),
    days: dots,
  };
}

// One request feeds the whole screen — habit cards plus the leaderboard —
// so first paint needs a single round trip.
app.get('/api/state', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT h.id, h.name, h.user_id, h.username,
             to_char(c.check_date, 'YYYY-MM-DD') AS day
      FROM habits h
      LEFT JOIN habit_checks c
        ON c.habit_id = h.id
       AND c.check_date >= CURRENT_DATE - 30
      ORDER BY h.created_at, h.id
    `);

    const byHabit = new Map();
    for (const row of rows) {
      if (!byHabit.has(row.id)) {
        byHabit.set(row.id, {
          id: row.id,
          name: row.name,
          user_id: row.user_id,
          username: row.username,
          days: new Set(),
        });
      }
      if (row.day) byHabit.get(row.id).days.add(row.day);
    }

    const habits = [];
    const board = new Map(); // username -> { username, streak, habits }
    for (const h of byHabit.values()) {
      const mine = req.user && h.user_id === req.user.id;
      if (mine) {
        habits.push(habitCard(h.id, h.name, h.username, true, h.days));
      }
      const entry = board.get(h.username) || { username: h.username, streak: 0, habits: 0 };
      entry.habits++;
      entry.streak = Math.max(entry.streak, currentStreak(h.days));
      board.set(h.username, entry);
    }

    const leaderboard = [...board.values()]
      .sort((a, b) => b.streak - a.streak || a.username.localeCompare(b.username))
      .slice(0, 50)
      .map(({ username, streak, habits: n }, i) => ({
        rank: i + 1,
        username,
        streak,
        habits: n,
        me: !!(req.user && req.user.username === username),
      }));

    res.json({ habits, leaderboard, today: dayStr(new Date()) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add a habit. Names need at least 3 characters (the same rule the
// frontend enforces — the server is the authority).
app.post('/api/habits', async (req, res) => {
  try {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (name.length < 3) {
      return res.status(400).json({ error: 'Habit name needs at least 3 characters.' });
    }
    if (name.length > 60) {
      return res.status(400).json({ error: 'Habit name can be at most 60 characters.' });
    }
    const { rows } = await pool.query(
      `INSERT INTO habits (user_id, username, name) VALUES ($1, $2, $3)
       RETURNING id, name`,
      [req.user.id, req.user.username, name]
    );
    res.json({ habit: habitCard(rows[0].id, rows[0].name, req.user.username, true, new Set()) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Check in / un-check for today. One row per habit per day (the primary
// key on habit_checks makes the insert idempotent).
app.post('/api/habits/:id/toggle', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const owned = await pool.query(
      'SELECT name FROM habits WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );
    if (!owned.rows.length) {
      return res.status(404).json({ error: 'Habit not found.' });
    }
    const removed = await pool.query(
      'DELETE FROM habit_checks WHERE habit_id = $1 AND check_date = CURRENT_DATE',
      [id]
    );
    if (removed.rowCount === 0) {
      await pool.query(
        `INSERT INTO habit_checks (habit_id, check_date)
         VALUES ($1, CURRENT_DATE) ON CONFLICT DO NOTHING`,
        [id]
      );
    }
    const { rows } = await pool.query(
      `SELECT to_char(check_date, 'YYYY-MM-DD') AS day
       FROM habit_checks WHERE habit_id = $1 AND check_date >= CURRENT_DATE - 30`,
      [id]
    );
    const days = new Set(rows.map((r) => r.day));
    res.json({ habit: habitCard(id, owned.rows[0].name, req.user.username, true, days) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove a habit and its history.
app.delete('/api/habits/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const deleted = await pool.query(
      'DELETE FROM habits WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );
    if (!deleted.rowCount) {
      return res.status(404).json({ error: 'Habit not found.' });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// HTML shell: serve the app if authenticated. Unauthenticated top-level
// visits (share links pasted into a browser — Sec-Fetch-Dest: document)
// are sent to the platform's chromeless view of this app, where the shell
// embeds it with a real token so the link just works. Every other
// tokenless case (iframe loads with an expired token, old browsers
// without Sec-Fetch-*) gets the "open in Homeroom" landing page instead
// of a redirect, so the platform shell is never loaded INSIDE its own
// app iframe and stray visits still don't reveal the app.
app.get('*', (req, res) => {
  if (!req.user) {
    // Deep-link pass-through (platform #743): carry the visited
    // path+query into the chromeless view so share links land on the
    // shared screen, not Home. The clean platform route stores `path`
    // as one encoded query value so an inner ?, &, or = survives. The
    // shell decodes and validates it as relative-only before use. The
    // character test keeps the
    // value attribute-safe for the landing anchor below — anything
    // unusual falls back to the bare link.
    const deepPath = /^\/[A-Za-z0-9\-._~!$&()*+,;=:@\/%?]*$/.test(req.originalUrl)
      ? '?path=' + encodeURIComponent(req.originalUrl) : '';
    if (PLATFORM_ORIGIN && req.get('sec-fetch-dest') === 'document') {
      return res.redirect(302, PLATFORM_ORIGIN + '/app/habit-streak-2a4523/full' + deepPath);
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Homeroom</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Homeroom</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="${PLATFORM_ORIGIN}/app/habit-streak-2a4523/full${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Homeroom</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS habits (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      name VARCHAR(120) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS habit_checks (
      habit_id INTEGER NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
      check_date DATE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (habit_id, check_date)
    )
  `);
  // The starter template's demo table; the real app replaced it.
  await pool.query('DROP TABLE IF EXISTS presses');
}

// Staging starts from an empty (or prod-copied) database, so seed a few
// obviously fake group members to make the leaderboard and streak dots
// reviewable. Fake identities only — never rows owned by whoever opens
// the preview. Re-runs on every staging boot, hence the existence check.
async function seedStaging() {
  const exists = await pool.query(
    `SELECT 1 FROM habits WHERE username = 'staging-demo-priya' LIMIT 1`
  );
  if (exists.rows.length) return;

  // username -> [{ name, checked: [day offsets before today] }]
  const demo = [
    ['staging-demo-priya', [
      ['Drink water', [0, 1, 2, 3]],
      ['Read 20 pages', [0]],
    ]],
    ['staging-demo-maya', [
      ['Morning run', [0, 1, 2]],
      ['Meditate', [0]],
    ]],
    ['staging-demo-leo', [
      ['Morning run', [0, 1]],
      ['Journal', [3]],
    ]],
  ];

  // One transaction: the existence check above stays honest even if a
  // boot dies mid-seed, so the next boot can retry cleanly.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [username, habits] of demo) {
      for (const [name, checked] of habits) {
        const { rows } = await client.query(
          `INSERT INTO habits (user_id, username, name) VALUES (0, $1, $2) RETURNING id`,
          [username, name]
        );
        for (const offset of checked) {
          await client.query(
            `INSERT INTO habit_checks (habit_id, check_date)
             VALUES ($1, CURRENT_DATE - $2::int) ON CONFLICT DO NOTHING`,
            [rows[0].id, offset]
          );
        }
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function start() {
  await migrate();
  if (IS_STAGING) {
    try {
      await seedStaging();
    } catch (err) {
      console.warn('staging seed failed: ' + err.message);
    }
  }
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;

  // The container is stopped and replaced on every deploy. Stop accepting
  // connections, let in-flight requests finish, close the pool, exit.
  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received, draining`);
    server.close(() => {});
    server.closeIdleConnections?.();
    const t = setTimeout(() => server.closeAllConnections?.(), 3000);
    t.unref?.();
    try {
      await pool.end();
    } catch (err) {
      console.error('[shutdown] pool.end failed', err.message);
    }
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch(err => { console.error(err); process.exit(1); });