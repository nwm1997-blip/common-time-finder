// Test harness: runs the Worker against an in-memory SQLite (node:sqlite) shim of D1,
// with Firebase ID tokens signed by a throwaway RSA key and the JWKS fetch stubbed.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";

export const PROJECT = "test-project";
export const ORIGIN = "https://nwm1997-blip.github.io";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

export function makeDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec(schema);
  const stmt = (sql, params = []) => ({
    sql,
    params,
    bind: (...p) => stmt(sql, p),
    async all() { return { results: sqlite.prepare(sql).all(...params) }; },
    async first() { return sqlite.prepare(sql).get(...params) ?? null; },
    async run() { sqlite.prepare(sql).run(...params); return { success: true }; },
  });
  return {
    sqlite,
    prepare: sql => stmt(sql),
    async batch(stmts) {
      sqlite.exec("BEGIN");
      try {
        const out = [];
        for (const s of stmts) out.push(await s.all());
        sqlite.exec("COMMIT");
        return out;
      } catch (e) { sqlite.exec("ROLLBACK"); throw e; }
    },
  };
}

const enc = o => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");

export const keys = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid: "k1", alg: "RS256", use: "sig" };

export const jwksCalls = { n: 0 };
let jwksKeys = [jwk];
let jwksHeaders = { "Cache-Control": "public, max-age=3600" };
export function setJwks(k, headers) { jwksKeys = k; if (headers) jwksHeaders = headers; }
globalThis.fetch = async () => { jwksCalls.n++; return new Response(JSON.stringify({ keys: jwksKeys }), { headers: jwksHeaders }); };

export async function token(claims = {}, { head = {}, signWith = keys.privateKey, tamper } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const body = { aud: PROJECT, iss: `https://securetoken.google.com/${PROJECT}`, sub: "u1", name: "Ann", picture: "http://p/a.png", iat: now - 5, exp: now + 3600, ...claims };
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
  const h = enc({ alg: "RS256", kid: "k1", typ: "JWT", ...head });
  const p = enc(body);
  const sig = Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signWith, new TextEncoder().encode(`${h}.${p}`))).toString("base64url");
  return tamper ? tamper(h, p, sig) : `${h}.${p}.${sig}`;
}

export function makeEnv(db = makeDb()) {
  return { DB: db, FIREBASE_PROJECT_ID: PROJECT, ALLOWED_ORIGINS: `${ORIGIN}, http://localhost:8080` };
}

export async function call(env, method, path, { body, auth, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (auth !== null) h.Authorization = `Bearer ${auth ?? (await token())}`;
  const res = await worker.fetch(new Request(`https://api.test${path}`, {
    method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  }), env);
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

export const meetingBody = (o = {}) => ({ title: "Sync", note: "n", dates: ["2026-10-02", "2026-10-01"], startMin: 540, endMin: 600, tz: "Europe/Paris", ...o });
