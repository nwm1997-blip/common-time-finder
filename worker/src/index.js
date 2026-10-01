// Common Time Finder API: Cloudflare Worker backed by D1 (SQLite).
// Every request must carry a Firebase ID token (Google sign-in) as a Bearer token.

const JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const MAX_DATES = 62;
let jwksCache = { keys: null, exp: 0 };

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const allowed = env.ALLOWED_ORIGINS.split(",").map(s => s.trim());
    const cors = {
      "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : allowed[0],
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    };
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

    try {
      const user = await verifyToken(req.headers.get("Authorization"), env.FIREBASE_PROJECT_ID);
      if (!user) return json({ error: "Sign in again to continue." }, 401);
      const path = new URL(req.url).pathname.replace(/\/+$/, "");
      let m;

      if (path === "/api/meetings" && req.method === "GET") return json(await listMeetings(env.DB, user.uid));
      if (path === "/api/meetings" && req.method === "POST") return json(await createMeeting(env.DB, user, await req.json()), 201);
      if ((m = path.match(/^\/api\/meetings\/([A-Za-z0-9_-]{6,40})$/))) {
        if (req.method === "GET") {
          const r = await getMeeting(env.DB, m[1]);
          return r ? json(r) : json({ error: "Meeting not found." }, 404);
        }
        if (req.method === "DELETE") return deleteMeeting(env.DB, m[1], user.uid, json);
      }
      if ((m = path.match(/^\/api\/meetings\/([A-Za-z0-9_-]{6,40})\/availability$/)) && req.method === "PUT")
        return saveAvailability(env.DB, m[1], user, await req.json(), json);

      return json({ error: "Not found." }, 404);
    } catch (e) {
      if (e instanceof BadRequest) return json({ error: e.message }, 400);
      console.error(e);
      return json({ error: "Something went wrong on the server." }, 500);
    }
  },
};

class BadRequest extends Error {}

// ---------- routes ----------
async function listMeetings(db, uid) {
  const { results } = await db.prepare(`
    SELECT m.*, (SELECT COUNT(*) FROM availability a WHERE a.meeting_id = m.id AND a.slots <> '[]') AS responses
    FROM meetings m
    WHERE m.created_by = ?1 OR m.id IN (SELECT meeting_id FROM availability WHERE user_id = ?1)
    ORDER BY m.created_at DESC LIMIT 200`).bind(uid).all();
  return { meetings: results.map(rowToMeeting) };
}

async function createMeeting(db, user, b) {
  const title = str(b.title, 80);
  if (!title) throw new BadRequest("Give the meeting a name.");
  const dates = Array.isArray(b.dates) ? [...new Set(b.dates)].filter(isRealDate).sort() : [];
  if (!dates.length || dates.length > MAX_DATES) throw new BadRequest(`Pick between 1 and ${MAX_DATES} dates.`);
  const start = int(b.startMin), end = int(b.endMin);
  if (start == null || end == null || start < 0 || end > 1440 || end <= start || start % 30 || end % 30)
    throw new BadRequest("Latest time must be after the earliest time.");
  const id = newId();
  await db.prepare(`INSERT INTO meetings (id, title, note, dates, start_min, end_min, tz, created_by, created_by_name, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, title, str(b.note, 500), JSON.stringify(dates), start, end, str(b.tz, 64) || "UTC", user.uid, user.name, Date.now()).run();
  return { id };
}

async function getMeeting(db, id) {
  const [mt, av] = await db.batch([
    db.prepare("SELECT * FROM meetings WHERE id = ?").bind(id),
    db.prepare("SELECT user_id, name, photo, slots, updated_at FROM availability WHERE meeting_id = ?").bind(id),
  ]);
  const row = mt.results[0];
  if (!row) return null;
  return {
    meeting: rowToMeeting(row),
    availability: av.results.map(a => ({ userId: a.user_id, name: a.name, photo: a.photo, slots: JSON.parse(a.slots), updatedAt: a.updated_at })),
  };
}

async function saveAvailability(db, id, user, b, json) {
  const row = await db.prepare("SELECT dates, start_min, end_min FROM meetings WHERE id = ?").bind(id).first();
  if (!row) return json({ error: "Meeting not found." }, 404);
  const total = JSON.parse(row.dates).length * ((row.end_min - row.start_min) / 30);
  const slots = Array.isArray(b.slots) ? [...new Set(b.slots.map(Number))].filter(n => Number.isInteger(n) && n >= 0 && n < total).sort((x, y) => x - y) : [];
  await db.prepare(`INSERT INTO availability (meeting_id, user_id, name, photo, slots, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (meeting_id, user_id) DO UPDATE SET name = excluded.name, photo = excluded.photo, slots = excluded.slots, updated_at = excluded.updated_at`)
    .bind(id, user.uid, user.name, user.picture, JSON.stringify(slots), Date.now()).run();
  return json({ ok: true, slots });
}

async function deleteMeeting(db, id, uid, json) {
  const row = await db.prepare("SELECT created_by FROM meetings WHERE id = ?").bind(id).first();
  if (!row) return json({ ok: true });
  if (row.created_by !== uid) return json({ error: "Only the person who created this meeting can delete it." }, 403);
  await db.batch([
    db.prepare("DELETE FROM availability WHERE meeting_id = ?").bind(id),
    db.prepare("DELETE FROM meetings WHERE id = ?").bind(id),
  ]);
  return json({ ok: true });
}

// ---------- helpers ----------
const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const isRealDate = d => {
  if (typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = new Date(d + "T00:00:00Z");
  return !isNaN(t) && t.toISOString().slice(0, 10) === d;
};
const int = v => (Number.isInteger(v) ? v : null);
function newId() {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function rowToMeeting(r) {
  return {
    id: r.id, title: r.title, note: r.note, dates: JSON.parse(r.dates), startMin: r.start_min, endMin: r.end_min,
    tz: r.tz, createdBy: r.created_by, createdByName: r.created_by_name, createdAt: r.created_at,
    ...(r.responses != null ? { responses: r.responses } : {}),
  };
}

// ---------- Firebase ID token verification (RS256, Google's public keys) ----------
const b64url = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));

async function getKeys() {
  if (jwksCache.keys && Date.now() < jwksCache.exp) return jwksCache.keys;
  const res = await fetch(JWKS_URL);
  const { keys } = await res.json();
  const maxAge = +((res.headers.get("Cache-Control") || "").match(/max-age=(\d+)/) || [, 3600])[1];
  jwksCache = { keys, exp: Date.now() + maxAge * 1000 };
  return keys;
}

async function verifyToken(header, projectId) {
  const token = (header || "").match(/^Bearer\s+(.+)$/)?.[1];
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let head, claims;
  try {
    head = JSON.parse(new TextDecoder().decode(b64url(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(b64url(parts[1])));
  } catch { return null; }
  if (head.alg !== "RS256" || !head.kid) return null;
  const now = Math.floor(Date.now() / 1000);
  if (claims.aud !== projectId || claims.iss !== `https://securetoken.google.com/${projectId}`) return null;
  if (!claims.sub || claims.exp < now - 30 || claims.iat > now + 300) return null;

  const jwk = (await getKeys()).find(k => k.kid === head.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
  if (!ok) return null;
  return { uid: claims.sub, name: str(claims.name || claims.email || "", 100), picture: str(claims.picture || "", 500) };
}
