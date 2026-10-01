import test from "node:test";
import assert from "node:assert/strict";
import { call, makeEnv, makeDb, token, meetingBody, ORIGIN, keys, setJwks, jwksCalls } from "./helpers.mjs";

const as = async (uid, extra = {}) => ({ auth: await token({ sub: uid, name: uid.toUpperCase(), ...extra }) });

async function create(env, uid = "u1", o) {
  const r = await call(env, "POST", "/api/meetings", { ...(await as(uid)), body: meetingBody(o) });
  assert.equal(r.status, 201);
  return r.body.id;
}

test("CORS preflight and origin handling", async () => {
  const env = makeEnv();
  const pre = await call(env, "OPTIONS", "/api/meetings", { auth: null, headers: { Origin: "http://localhost:8080" } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("Access-Control-Allow-Origin"), "http://localhost:8080");
  const evil = await call(env, "GET", "/api/meetings", { headers: { Origin: "https://evil.example" } });
  assert.equal(evil.headers.get("Access-Control-Allow-Origin"), ORIGIN);
});

test("unknown route is 404, trailing slash tolerated", async () => {
  const env = makeEnv();
  assert.equal((await call(env, "GET", "/nope")).status, 404);
  assert.equal((await call(env, "GET", "/api/meetings/")).status, 200);
  assert.equal((await call(env, "PATCH", "/api/meetings/abcdef")).status, 404);
});

test("create + list + get a meeting", async () => {
  const env = makeEnv();
  const id = await create(env);
  const list = await call(env, "GET", "/api/meetings");
  assert.equal(list.body.meetings.length, 1);
  assert.equal(list.body.meetings[0].responses, 0);
  const got = await call(env, "GET", `/api/meetings/${id}`);
  assert.deepEqual(got.body.meeting.dates, ["2026-10-01", "2026-10-02"]);
  assert.equal(got.body.meeting.createdByName, "U1");
  assert.deepEqual(got.body.availability, []);
  assert.equal((await call(env, "GET", "/api/meetings/missing1")).status, 404);
});

test("create validation", async () => {
  const env = makeEnv();
  const bad = async o => (await call(env, "POST", "/api/meetings", { body: meetingBody(o) })).status;
  assert.equal(await bad({ title: "  " }), 400);
  assert.equal(await bad({ title: 5 }), 400);
  assert.equal(await bad({ dates: [] }), 400);
  assert.equal(await bad({ dates: "2026-10-01" }), 400);
  assert.equal(await bad({ dates: ["garbage"] }), 400);
  assert.equal(await bad({ startMin: 600, endMin: 600 }), 400);
  assert.equal(await bad({ startMin: 615 }), 400);
  assert.equal(await bad({ startMin: -30 }), 400);
  assert.equal(await bad({ endMin: 1470 }), 400);
  assert.equal(await bad({ startMin: "540" }), 400);
});

test("too many dates is rejected", async () => {
  const env = makeEnv();
  const dates = Array.from({ length: 63 }, (_, i) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10));
  assert.equal((await call(env, "POST", "/api/meetings", { body: meetingBody({ dates }) })).status, 400);
  assert.equal((await call(env, "POST", "/api/meetings", { body: meetingBody({ dates: dates.slice(0, 62) }) })).status, 201);
});

test("create trims/truncates text and defaults tz", async () => {
  const env = makeEnv();
  const id = await create(env, "u1", { title: ` ${"x".repeat(100)} `, note: undefined, tz: undefined });
  const { meeting } = (await call(env, "GET", `/api/meetings/${id}`)).body;
  assert.equal(meeting.title.length, 80);
  assert.equal(meeting.note, "");
  assert.equal(meeting.tz, "UTC");
});

test("availability: save, replace, sanitise, 404", async () => {
  const env = makeEnv();
  const id = await create(env); // 2 dates x 2 slots = 4
  const put = (uid, slots) => as(uid).then(a => call(env, "PUT", `/api/meetings/${id}/availability`, { ...a, body: { slots } }));
  assert.deepEqual((await put("u2", [3, 1, 1, 4, -1, 1.5, "2"])).body.slots, [1, 2, 3]);
  assert.deepEqual((await put("u2", [0])).body.slots, [0]);
  assert.deepEqual((await put("u2", "nope")).body.slots, []);
  await put("u3", [1]);
  const got = await call(env, "GET", `/api/meetings/${id}`);
  assert.equal(got.body.availability.length, 2);
  const u2 = got.body.availability.find(a => a.userId === "u2");
  assert.deepEqual(u2.slots, []);
  assert.equal(u2.photo, "http://p/a.png");
  const missing = await call(env, "PUT", "/api/meetings/nomeeting/availability", { body: { slots: [] } });
  assert.equal(missing.status, 404);
});

test("list shows created and replied meetings with response counts", async () => {
  const env = makeEnv();
  const a = await create(env, "u1");
  const b = await create(env, "u2");
  await call(env, "PUT", `/api/meetings/${b}/availability`, { ...(await as("u1")), body: { slots: [0] } });
  await call(env, "PUT", `/api/meetings/${a}/availability`, { ...(await as("u3")), body: { slots: [] } });
  const l1 = (await call(env, "GET", "/api/meetings", await as("u1"))).body.meetings;
  assert.deepEqual(l1.map(m => m.id).sort(), [a, b].sort());
  assert.equal(l1.find(m => m.id === b).responses, 1);
  assert.equal(l1.find(m => m.id === a).responses, 0);
  assert.equal((await call(env, "GET", "/api/meetings", await as("u9"))).body.meetings.length, 0);
});

test("delete: creator only, cascades availability, idempotent", async () => {
  const env = makeEnv();
  const id = await create(env, "u1");
  await call(env, "PUT", `/api/meetings/${id}/availability`, { ...(await as("u2")), body: { slots: [0] } });
  assert.equal((await call(env, "DELETE", `/api/meetings/${id}`, await as("u2"))).status, 403);
  assert.equal((await call(env, "DELETE", `/api/meetings/${id}`, await as("u1"))).status, 200);
  assert.equal((await call(env, "GET", `/api/meetings/${id}`)).status, 404);
  assert.equal(env.DB.sqlite.prepare("SELECT COUNT(*) c FROM availability").get().c, 0);
  assert.equal((await call(env, "DELETE", `/api/meetings/${id}`, await as("u1"))).status, 200);
});

test("500 on unexpected database failure", async () => {
  const env = makeEnv();
  env.DB.sqlite.exec("DROP TABLE availability");
  const orig = console.error; console.error = () => {};
  try { assert.equal((await call(env, "GET", "/api/meetings")).status, 500); } finally { console.error = orig; }
});

test("auth: rejects missing, malformed and invalid tokens", async () => {
  const env = makeEnv();
  const status = async auth => (await call(env, "GET", "/api/meetings", { auth })).status;
  assert.equal(await status(null), 401);
  assert.equal(await status("abc"), 401);
  assert.equal(await status("a.b.c"), 401);
  assert.equal(await status(await token({ aud: "other" })), 401);
  assert.equal(await status(await token({ iss: "https://evil" })), 401);
  assert.equal(await status(await token({ sub: "" })), 401);
  assert.equal(await status(await token({ exp: Math.floor(Date.now() / 1000) - 3600 })), 401);
  assert.equal(await status(await token({ iat: Math.floor(Date.now() / 1000) + 3600 })), 401);
  assert.equal(await status(await token({ exp: undefined })), 401);
  assert.equal(await status(await token({ iat: undefined })), 401);
  assert.equal(await status(await token({ sub: 123 })), 401);
  assert.equal(await status(await token({}, { head: { alg: "none" } })), 401);
  assert.equal(await status(await token({}, { head: { kid: "unknown" } })), 401);
  const other = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign"]);
  assert.equal(await status(await token({}, { signWith: other.privateKey })), 401);
  assert.equal(await status(await token({}, { tamper: (h, p, s) => `${h}.${Buffer.from(JSON.stringify({ aud: "test-project", iss: "https://securetoken.google.com/test-project", sub: "admin", exp: 9e9 })).toString("base64url")}.${s}` })), 401);
  assert.equal(await status(await token()), 200);
});

test("auth: email fallback for name and JWKS caching", async () => {
  const env = makeEnv();
  const before = jwksCalls.n;
  const id = await create(env, "u5");
  await call(env, "PUT", `/api/meetings/${id}/availability`, { auth: await token({ sub: "u5", name: undefined, email: "e@x.io" }), body: { slots: [] } });
  const got = await call(env, "GET", `/api/meetings/${id}`);
  assert.equal(got.body.availability[0].name, "e@x.io");
  assert.ok(jwksCalls.n - before <= 1);
});
