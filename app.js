import { firebaseConfig, apiBase } from "./firebase-config.js";

const FB = "https://www.gstatic.com/firebasejs/10.14.1/";
const SLOT = 30;
const $ = id => document.getElementById(id);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : String(k));
  return el;
};
const pad = n => String(n).padStart(2, "0");
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const fmtDate = s => parseYmd(s).toLocaleDateString("en-SG", { weekday: "short", day: "numeric", month: "short" });
const fmtTime = m => { const hh = Math.floor(m / 60) % 24, mm = m % 60, ap = hh < 12 ? "am" : "pm", h12 = hh % 12 || 12; return `${h12}${mm ? ":" + pad(mm) : ""} ${ap}`; };
const fmtDur = m => m < 60 ? `${m} min` : `${m / 60} hr${m > 60 ? "s" : ""}`.replace(".5 hrs", "½ hrs");
const initials = n => (n || "?").split(/\s+/).map(w => w[0]).slice(0, 2).join("").toUpperCase();
const avatar = (url, name) => url
  ? h("img", { class: "av", src: url, alt: "", referrerpolicy: "no-referrer" })
  : h("span", { class: "av", style: "display:inline-grid;place-items:center;background:var(--accent-soft);font-size:11px;font-weight:700" }, initials(name));

const S = {
  fb: null, user: null, authReady: false,
  meetings: [], meetingsReady: false,
  cur: null, curReady: false, avail: {},
  view: "list", current: null, sel: null, cursor: { mine: 0, group: 0 }, minLen: 60, saveState: "", painting: false,
};
let pollTimer = null;
const POLL_MS = 12000;

// ---------- routing ----------
function routeFromHash() {
  const mid = (location.hash.match(/^#m-([A-Za-z0-9_-]+)$/) || [])[1];
  const view = mid ? "meeting" : location.hash === "#new" ? "new" : "list";
  if (view === S.view && mid === (S.current || undefined) && S.loadedFor === S.user?.uid) return;
  S.view = view; S.current = mid || null; S.sel = null; S.cursor = { mine: 0, group: 0 }; S.saveState = "";
  load();
  render(true); window.scrollTo(0, 0);
}
function go(view, mid) { location.hash = mid ? "m-" + mid : view === "new" ? "new" : ""; }
window.addEventListener("hashchange", routeFromHash);
$("home").addEventListener("click", () => go("list"));

// ---------- auth (Firebase) + data (Cloudflare D1 API) ----------
async function boot() {
  try { const v = +localStorage.getItem("ctf-len"); if ([30, 60, 90, 120, 180].includes(v)) S.minLen = v; } catch (e) {}
  if (!firebaseConfig || !apiBase) { renderSetup(); return; }
  const [app, auth] = await Promise.all([import(FB + "firebase-app.js"), import(FB + "firebase-auth.js")]);
  const fapp = app.initializeApp(firebaseConfig);
  S.fb = { auth: auth.getAuth(fapp), A: auth };
  auth.getRedirectResult(S.fb.auth).catch(() => {});
  auth.onAuthStateChanged(S.fb.auth, u => {
    S.user = u; S.authReady = true; S.loadedFor = null;
    renderWho();
    routeFromHash(); render(true);
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && S.view === "meeting") refreshMeeting(); });
}

async function api(method, path, body) {
  const token = await S.user.getIdToken();
  const res = await fetch(apiBase + path, {
    method,
    headers: { Authorization: "Bearer " + token, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || "Request failed"); e.status = res.status; throw e; }
  return data;
}

function load() {
  clearInterval(pollTimer); pollTimer = null;
  S.listError = false; S.loadError = false;
  if (!S.user) return;
  S.loadedFor = S.user.uid;
  if (S.view === "list") {
    S.meetingsReady = false;
    api("GET", "/api/meetings").then(r => { S.meetings = r.meetings; }).catch(() => { S.listError = true; })
      .finally(() => { S.meetingsReady = true; render(); });
  } else if (S.view === "meeting") {
    S.cur = null; S.curReady = false; S.avail = {};
    refreshMeeting();
    pollTimer = setInterval(() => { if (!document.hidden) refreshMeeting(); }, POLL_MS);
  }
}

async function refreshMeeting() {
  const mid = S.current;
  if (!mid || !S.user || S.painting || S.saving) return;
  try {
    const r = await api("GET", "/api/meetings/" + mid);
    if (mid !== S.current || S.painting || S.saving) return;
    const a = {}; r.availability.forEach(x => { a[x.userId] = x; });
    const changed = JSON.stringify([r.meeting, a]) !== JSON.stringify([S.cur, S.avail]);
    S.cur = r.meeting; S.avail = a; S.curReady = true; S.loadError = false;
    if (changed) render();
  } catch (e) {
    if (mid !== S.current) return;
    if (e.status === 404) { S.cur = null; S.curReady = true; clearInterval(pollTimer); render(); }
    else if (!S.curReady) { S.curReady = true; S.loadError = true; render(); }
  }
}

async function signIn() {
  const { A, auth } = S.fb;
  const provider = new A.GoogleAuthProvider();
  try { await A.signInWithPopup(auth, provider); }
  catch (e) {
    if (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment") await A.signInWithRedirect(auth, provider);
    else if (e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request") {
      const err = $("signin-err");
      if (err) err.textContent = e.code === "auth/unauthorized-domain"
        ? `This site isn't on the Firebase authorised domains list yet. Add ${location.hostname} in Firebase → Authentication → Settings.`
        : e.code === "auth/configuration-not-found" || e.code === "auth/operation-not-allowed"
        ? "Google sign-in isn't switched on yet. Enable it in Firebase → Authentication → Sign-in method."
        : "Sign-in didn't work. Try again.";
    }
  }
}

// ---------- data ----------
const uid = () => S.user?.uid;
const mySlots = () => new Set(S.avail[uid()]?.slots || []);
const participants = () => Object.entries(S.avail).filter(([, v]) => v.slots?.length).map(([id]) => id);
const nameOf = id => id === uid() ? "You" : (S.avail[id]?.name || "Someone");

function setMine(set) {
  const slots = [...set].sort((a, b) => a - b);
  S.avail = { ...S.avail, [uid()]: { userId: uid(), name: S.user.displayName || "", photo: S.user.photoURL || "", slots } };
  return slots;
}
async function saveMine(set, m = S.cur) {
  clearTimeout(saveTimer); saveTimer = null;
  // A queued save can fire after the user has opened another meeting; don't touch that meeting's state.
  const slots = m === S.cur ? setMine(set) : [...set].sort((a, b) => a - b);
  S.saving = true; S.saveState = "Saving…"; paintSaved();
  try {
    await api("PUT", `/api/meetings/${m.id}/availability`, { slots });
    S.saveState = "Saved";
  } catch (e) {
    S.saveState = e.status === 401 ? "Sign in again to save your times." : "Couldn't save. Check your connection and try again.";
  }
  S.saving = false;
  paintSaved();
}
// Keyboard toggles update the screen at once and save after a short pause, so a run of key presses is one request.
let saveTimer = null;
function queueSave(set) {
  const m = S.cur;
  setMine(set);
  clearTimeout(saveTimer);
  S.saving = true; S.saveState = "Saving…"; paintSaved();
  saveTimer = setTimeout(() => saveMine(set, m), 600);
}
function paintSaved() { const el = $("saved"); if (el) el.textContent = S.saveState; }

// ---------- render ----------
function renderWho() {
  const who = $("who");
  if (!S.user) { who.replaceChildren(); return; }
  who.replaceChildren(avatar(S.user.photoURL, S.user.displayName),
    h("span", {}, S.user.displayName || S.user.email),
    h("button", { class: "btn link", type: "button", onclick: () => S.fb.A.signOut(S.fb.auth) }, "Sign out"));
}

function render(force) {
  if (S.painting) return;
  const main = $("main");
  if (!force && S.view === "new" && main.querySelector("form")) return;
  // Re-rendering replaces the grids, so put keyboard focus back on the same cell.
  const f = document.activeElement?.closest?.(".grid .c");
  const keep = f && main.contains(f) ? `.grid.${f.closest(".grid").dataset.kind} .c[data-i="${f.dataset.i}"]` : null;
  main.replaceChildren(
    !S.authReady ? h("div", { class: "panel" }, h("p", { class: "muted" }, "Loading…"))
    : !S.user ? viewSignIn()
    : S.view === "new" ? viewNew()
    : S.view === "meeting" ? viewMeeting()
    : viewList());
  if (keep) main.querySelector(keep)?.focus();
}

function renderSetup() {
  $("main").replaceChildren(h("div", { class: "panel" },
    h("h2", {}, "Almost ready"),
    h("p", {}, "This app needs a Firebase project for sign-in and saving times. The site owner adds it once:"),
    h("ol", { class: "steps" },
      h("li", {}, "Create a free project at ", h("a", { href: "https://console.firebase.google.com/", target: "_blank", rel: "noopener" }, "console.firebase.google.com"), "."),
      h("li", {}, "Build → Authentication → Get started → enable ", h("b", {}, "Google"), ". Under Settings → Authorised domains, add ", h("code", {}, location.hostname || "your-site.github.io"), "."),
      h("li", {}, "Deploy the API in ", h("code", {}, "worker/"), " to Cloudflare (see README) and put its URL in ", h("code", {}, "apiBase"), " in firebase-config.js."),
      h("li", {}, "Project settings → Your apps → add a Web app, and copy its config into ", h("code", {}, "firebase-config.js"), "."))));
}

function viewSignIn() {
  const invited = S.view === "meeting";
  return h("div", { class: "panel signin" },
    h("h2", {}, invited ? "You've been asked for your free times" : "Find a time that works for everyone"),
    h("p", { class: "muted" }, invited
      ? "Sign in so your times are saved under your name. Only you can change them."
      : "Create a meeting, share the link, and everyone marks when they're free. The best common slots appear automatically."),
    h("button", { class: "btn primary gbtn", type: "button", onclick: signIn }, "Sign in with Google"),
    h("p", { class: "err", id: "signin-err", role: "alert" }));
}

function viewList() {
  const list = [...S.meetings].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const head = h("div", { class: "mhead" },
    h("div", {}, h("h2", {}, "Your meetings"), h("p", { class: "muted small" }, "Meetings you created or added times to. Open one to update your times or see the results.")),
    h("button", { class: "btn primary", type: "button", onclick: () => go("new") }, "New meeting"));
  if (!S.meetingsReady) return h("div", { class: "panel" }, head, h("p", { class: "muted" }, "Loading meetings…"));
  if (S.listError) return h("div", { class: "panel" }, head, h("p", { class: "err" }, "Couldn't load your meetings. Check your connection and reload the page."));
  if (!list.length) return h("div", { class: "panel" }, head,
    h("div", { class: "empty" },
      h("h3", {}, "No meetings yet"),
      h("p", { class: "muted" }, "Create a meeting, choose the dates and hours, then send the link. Everyone signs in, marks when they're free, and the best common times appear automatically."),
      h("button", { class: "btn primary", type: "button", onclick: () => go("new") }, "Create the first meeting")));
  return h("div", { class: "panel" }, head,
    h("div", { class: "mlist" }, list.map(m => {
      const first = m.dates[0], last = m.dates[m.dates.length - 1], n = m.responses || 0;
      return h("button", { class: "mrow", type: "button", onclick: () => go("meeting", m.id) },
        h("span", { class: "t" }, m.title),
        h("span", { class: "small", style: "color:var(--accent);font-weight:700" }, m.createdBy === uid() ? "Yours" : ""),
        h("span", { class: "muted small" },
          `${first === last ? fmtDate(first) : fmtDate(first) + " – " + fmtDate(last)} · ${fmtTime(m.startMin)}–${fmtTime(m.endMin)} · ${n} responded`),
        h("span"));
    })));
}

function viewNew() {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const start = new Date(today); start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const picked = new Set();
  for (let d = new Date(today), n = 0; n < 5; d.setDate(d.getDate() + 1)) { const w = d.getDay(); if (w && w < 6) { picked.add(ymd(d)); n++; } }

  const count = h("span", { class: "muted small" }, `${picked.size} dates selected`);
  const cal = h("div", { class: "cal", role: "group", "aria-label": "Dates" },
    ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(d => h("span", { class: "dow" }, d)));
  for (let i = 0; i < 42; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const key = ymd(d);
    const b = h("button", { type: "button", "aria-pressed": String(picked.has(key)), disabled: d < today, "aria-label": fmtDate(key) },
      d.getDate(), (d.getDate() === 1 || i === 0) ? h("small", {}, d.toLocaleDateString("en-SG", { month: "short" })) : null);
    b.addEventListener("click", () => {
      picked.has(key) ? picked.delete(key) : picked.add(key);
      b.setAttribute("aria-pressed", String(picked.has(key)));
      count.textContent = `${picked.size} date${picked.size === 1 ? "" : "s"} selected`;
    });
    cal.append(b);
  }
  const hours = []; for (let m = 0; m <= 1440; m += 60) hours.push(m);
  const sel = (id, val, opts) => { const s = h("select", { id }, opts.map(m => h("option", { value: m }, m === 1440 ? "12 am (midnight)" : fmtTime(m)))); s.value = val; return s; };
  const from = sel("nm-from", 540, hours.slice(0, 24)), to = sel("nm-to", 1080, hours.slice(1));
  const title = h("input", { type: "text", id: "nm-title", placeholder: "e.g. Project kickoff", maxlength: "80", autocomplete: "off" });
  const note = h("textarea", { id: "nm-note", placeholder: "Optional: agenda, location or video link", maxlength: "500" });
  const err = h("p", { class: "err", role: "alert" });
  const submit = h("button", { class: "btn primary", type: "submit" }, "Create meeting");
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "local time";

  const form = h("form", { class: "form" },
    h("div", { class: "field" }, h("label", { class: "label", for: "nm-title" }, "Meeting name"), title),
    h("div", { class: "field" }, h("span", { class: "label" }, "Dates people can choose from"), cal, count),
    h("div", { class: "row" },
      h("div", { class: "field" }, h("label", { class: "label", for: "nm-from" }, "Earliest"), from),
      h("div", { class: "field" }, h("label", { class: "label", for: "nm-to" }, "Latest"), to)),
    h("p", { class: "muted small" }, `Times are in ${tz}. Everyone sees the same clock times.`),
    h("div", { class: "field" }, h("label", { class: "label", for: "nm-note" }, "Details"), note),
    err,
    h("div", { class: "row" }, submit, h("button", { class: "btn", type: "button", onclick: () => go("list") }, "Cancel")));
  form.addEventListener("submit", async e => {
    e.preventDefault();
    const s = +from.value, en = +to.value;
    if (!title.value.trim()) { err.textContent = "Give the meeting a name."; title.focus(); return; }
    if (!picked.size) { err.textContent = "Pick at least one date."; return; }
    if (en <= s) { err.textContent = "Latest time must be after the earliest time."; return; }
    submit.disabled = true; submit.textContent = "Creating…";
    try {
      const ref = await api("POST", "/api/meetings", {
        title: title.value.trim(), note: note.value.trim(), dates: [...picked].sort(), startMin: s, endMin: en, tz,
      });
      go("meeting", ref.id);
    } catch (e2) {
      submit.disabled = false; submit.textContent = "Create meeting";
      err.textContent = e2.status === 400 ? e2.message : "Couldn't create the meeting. Check your connection and try again.";
    }
  });
  return h("div", { class: "panel" }, h("h2", {}, "New meeting"), form);
}

function computeBest(m, spd, people) {
  const total = m.dates.length * spd;
  const who = Array.from({ length: total }, () => []);
  for (const id of people) for (const i of (S.avail[id].slots || [])) if (i < total) who[i].push(id);
  const runs = [];
  m.dates.forEach((d, di) => {
    let s = 0;
    while (s < spd) {
      const k = who[di * spd + s].join(",");
      let e = s + 1;
      while (e < spd && who[di * spd + e].join(",") === k) e++;
      if (k) runs.push({ di, s, e, ids: who[di * spd + s] });
      s = e;
    }
  });
  return { who, runs };
}

function viewMeeting() {
  const m = S.cur;
  if (!m) return h("div", { class: "panel" },
    h("h3", {}, S.curReady ? (S.loadError ? "Couldn't load this meeting" : "This meeting isn't available") : "Loading meeting…"),
    S.curReady ? h("p", { class: "muted" }, S.loadError ? "Check your connection and reload the page." : "The link may be wrong, or the person who created it deleted it.") : null,
    h("button", { class: "btn", type: "button", onclick: () => go("list") }, "Back to your meetings"));

  const spd = (m.endMin - m.startMin) / SLOT;
  const people = participants();
  const n = people.length;
  const { who, runs } = computeBest(m, spd, people);
  const best = runs.filter(r => r.e - r.s >= S.minLen / SLOT)
    .sort((a, b) => b.ids.length - a.ids.length || (b.e - b.s) - (a.e - a.s) || a.di - b.di || a.s - b.s).slice(0, 5);

  const lenSel = h("select", { id: "minlen", "aria-label": "Meeting length" }, [30, 60, 90, 120, 180].map(v => h("option", { value: v }, fmtDur(v))));
  lenSel.value = S.minLen;
  lenSel.addEventListener("change", () => { S.minLen = +lenSel.value; try { localStorage.setItem("ctf-len", S.minLen); } catch (e) {} render(); });

  const bestBox = h("div", { class: "best" });
  if (!n) bestBox.append(h("p", { class: "muted" }, "No one has added times yet. Mark yours below, then send the link to the others."));
  else if (!best.length) bestBox.append(h("p", { class: "muted" }, `No ${fmtDur(S.minLen)} window works for anyone yet. Try a shorter length.`));
  else best.forEach(r => {
    const missing = people.filter(id => !r.ids.includes(id));
    bestBox.append(h("div", { class: "slot" },
      h("span", { class: "n" + (r.ids.length < n ? " partial" : "") }, `${r.ids.length}/${n}`),
      h("span", { class: "when" }, `${fmtDate(m.dates[r.di])}, ${fmtTime(m.startMin + r.s * SLOT)} – ${fmtTime(m.startMin + r.e * SLOT)}`),
      h("span", { class: "muted small" }, missing.length ? "Can't make it: " + missing.map(nameOf).join(", ") : "Everyone is free")));
  });

  const link = location.origin + location.pathname + "#m-" + m.id;
  const linkInput = h("input", { id: "share-link", type: "text", readonly: true, value: link, "aria-label": "Meeting link" });
  const copyBtn = h("button", { class: "btn", type: "button" }, "Copy link");
  copyBtn.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(link); copyBtn.textContent = "Copied"; }
    catch (e) { linkInput.select(); copyBtn.textContent = "Press Ctrl+C"; }
    setTimeout(() => { copyBtn.textContent = "Copy link"; }, 2000);
  });

  const del = h("div", { class: "row" });
  if (m.createdBy === uid()) {
    const ask = h("button", { class: "btn danger", type: "button" }, "Delete meeting");
    ask.addEventListener("click", () => {
      del.replaceChildren(h("span", { class: "small" }, "Delete for everyone?"),
        h("button", { class: "btn danger", type: "button", onclick: async () => {
          try { await api("DELETE", "/api/meetings/" + m.id); go("list"); }
          catch (e) { del.replaceChildren(h("span", { class: "err" }, "Couldn't delete. Try again.")); }
        } }, "Yes, delete"),
        h("button", { class: "btn", type: "button", onclick: () => render() }, "Keep it"));
    });
    del.append(ask);
  }

  const detail = h("div", { class: "detail", id: "detail", "aria-live": "polite" }, h("span", { class: "muted" }, "Select a time in the group grid to see who's free then."));
  const mine = buildGrid(m, spd, "mine", who, n, detail);
  const group = buildGrid(m, spd, "group", who, n, detail);
  if (S.sel != null) showDetail(m, spd, who, people, detail);

  const heatLegend = h("div", { class: "legend" }, "0",
    h("span", { class: "sw" }, [0, .25, .5, .75, 1].map(a => h("span", { style: a ? `background:rgba(var(--heat-rgb),${a})` : "background:var(--heat-0)" }))),
    `${n || 1} ${n === 1 ? "person" : "people"}`);

  return h("div", { class: "panel" },
    h("div", { class: "mhead" },
      h("div", {}, h("p", { class: "label" }, `${m.dates.length} date${m.dates.length > 1 ? "s" : ""} · ${fmtTime(m.startMin)}–${fmtTime(m.endMin)} · ${m.tz}`),
        h("h2", {}, m.title),
        m.note ? h("p", { class: "muted", style: "white-space:pre-wrap;max-width:65ch" }, m.note) : null,
        h("p", { class: "muted small" }, `Created by ${m.createdBy === uid() ? "you" : (m.createdByName || "someone")}`)),
      del),
    h("div", { class: "field" }, h("span", { class: "label" }, "Send this link to everyone"), h("div", { class: "sharebox" }, linkInput, copyBtn)),
    h("section", { class: "best", "aria-label": "Best times" },
      h("div", { class: "row", style: "justify-content:space-between;align-items:center" },
        h("h3", {}, "Best times"),
        h("label", { class: "small muted", style: "display:flex;gap:8px;align-items:center" }, "At least", lenSel)),
      bestBox),
    n ? h("div", { class: "people" }, people.map(id => h("span", { class: "person" }, avatar(S.avail[id]?.photo, S.avail[id]?.name), nameOf(id)))) : null,
    h("div", { class: "grids" },
      h("section", { class: "panel", style: "border-color:var(--mine)" },
        h("div", { class: "row", style: "justify-content:space-between;align-items:center" },
          h("h3", {}, "Your availability"), h("span", { class: "saved", id: "saved", "aria-live": "polite" }, S.saveState)),
        h("p", { class: "muted small", id: "mine-hint" }, "Click or drag across the times you're free. Drag again to clear. With a keyboard, use the arrow keys to move, Space to mark or clear a time, and Shift + arrow to fill as you go."),
        h("div", { class: "gridwrap" }, mine)),
      h("section", { class: "panel" },
        h("h3", {}, "Everyone"), heatLegend,
        h("div", { class: "gridwrap" }, group), detail)));
}

function buildGrid(m, spd, kind, who, n, detail) {
  const cols = m.dates.length;
  const g = h("div", { class: "grid " + kind, "data-kind": kind, role: "group",
    "aria-label": kind === "mine" ? "Your availability" : "Everyone's availability",
    "aria-describedby": kind === "mine" ? "mine-hint" : null,
    style: `grid-template-columns: auto repeat(${cols}, minmax(46px, 1fr))` });
  g.append(h("span"));
  m.dates.forEach(d => { const dt = parseYmd(d); g.append(h("span", { class: "hd" }, dt.toLocaleDateString("en-SG", { weekday: "short" }), h("b", {}, dt.getDate() + " " + dt.toLocaleDateString("en-SG", { month: "short" })))); });
  const mineSet = mySlots();
  const cursor = Math.min(S.cursor[kind], cols * spd - 1);
  for (let s = 0; s < spd; s++) {
    const t = m.startMin + s * SLOT;
    g.append(h("span", { class: "tm" }, t % 60 === 0 ? fmtTime(t) : ""));
    for (let di = 0; di < cols; di++) {
      const i = di * spd + s;
      const cls = ["c", (t + SLOT) % 60 === 0 ? "hr" : "", di === 0 ? "first" : "", s === 0 ? "top" : ""];
      const when = `${fmtDate(m.dates[di])}, ${fmtTime(t)} – ${fmtTime(t + SLOT)}`;
      let style = null, label = when, pressed = null;
      if (kind === "mine") { pressed = String(mineSet.has(i)); if (mineSet.has(i)) cls.push("on"); }
      else {
        const c = who[i].length;
        if (c) style = `background:rgba(var(--heat-rgb),${(0.18 + 0.82 * c / Math.max(n, 1)).toFixed(2)})`;
        if (S.sel === i) cls.push("sel");
        label = `${when}: ${c} of ${n} free`;
      }
      g.append(h("button", { type: "button", class: cls.join(" "), "data-i": i, style, tabindex: i === cursor ? "0" : "-1",
        "aria-label": label, "aria-pressed": pressed, title: `${fmtDate(m.dates[di])} ${fmtTime(t)}${kind === "group" ? ` · ${who[i].length} free` : ""}` }));
    }
  }
  wireKeys(g, kind, spd, cols * spd);
  if (kind === "mine") wirePaint(g);
  else g.addEventListener("click", e => {
    const c = e.target.closest(".c"); if (!c) return;
    g.querySelector(".sel")?.classList.remove("sel");
    S.sel = +c.dataset.i; c.classList.add("sel");
    showDetail(m, spd, who, participants(), detail);
  });
  return g;
}

function showDetail(m, spd, who, people, el) {
  const i = S.sel, di = Math.floor(i / spd), t = m.startMin + (i % spd) * SLOT;
  const yes = who[i] || [], no = people.filter(id => !yes.includes(id));
  el.replaceChildren(
    h("p", { style: "margin:0 0 4px;font-weight:700" }, `${fmtDate(m.dates[di])}, ${fmtTime(t)} – ${fmtTime(t + SLOT)}`),
    h("p", { style: "margin:0" }, h("span", { style: "color:var(--accent);font-weight:700" }, `Free (${yes.length}): `), yes.map(nameOf).join(", ") || "No one"),
    no.length ? h("p", { style: "margin:0" }, h("span", { class: "muted", style: "font-weight:700" }, `Busy (${no.length}): `), no.map(nameOf).join(", ")) : null);
}

// Roving tabindex: each grid is one Tab stop and the arrow keys move between cells.
// Up/Down step through a day's times, Left/Right move between days, Home/End jump to a day's first/last time.
function wireKeys(g, kind, spd, total) {
  g.addEventListener("focusin", e => {
    const c = e.target.closest(".c"); if (!c) return;
    const prev = g.querySelector('.c[tabindex="0"]');
    if (prev && prev !== c) prev.tabIndex = -1;
    c.tabIndex = 0; S.cursor[kind] = +c.dataset.i;
  });
  g.addEventListener("keydown", e => {
    const c = e.target.closest(".c"); if (!c || e.altKey || e.ctrlKey || e.metaKey) return;
    const i = +c.dataset.i, s = i % spd;
    const to = { ArrowUp: s > 0 ? i - 1 : i, ArrowDown: s < spd - 1 ? i + 1 : i,
      ArrowLeft: i >= spd ? i - spd : i, ArrowRight: i + spd < total ? i + spd : i,
      Home: i - s, End: i - s + spd - 1 }[e.key];
    if (to != null) {
      e.preventDefault();
      if (to === i) return;
      const next = g.querySelector(`.c[data-i="${to}"]`);
      next.focus();
      // Shift + arrow carries the current cell's state onto the next one, like dragging.
      if (kind === "mine" && e.shiftKey && e.key.startsWith("Arrow")) {
        const set = mySlots();
        if (set.has(i) !== set.has(to)) toggleMine(to, set);
      }
    } else if (kind === "mine" && (e.key === " " || e.key === "Enter")) {
      e.preventDefault();
      toggleMine(i, mySlots());
    }
  });
}

function toggleMine(i, set) {
  set.has(i) ? set.delete(i) : set.add(i);
  queueSave(set);
  render();
}

function wirePaint(g) {
  let mode = null, set = null;
  const apply = c => {
    if (!c?.dataset.i) return;
    const i = +c.dataset.i;
    if (mode) { set.add(i); c.classList.add("on"); } else { set.delete(i); c.classList.remove("on"); }
  };
  g.addEventListener("pointerdown", e => {
    const c = e.target.closest(".c"); if (!c) return;
    e.preventDefault();
    set = mySlots(); mode = !set.has(+c.dataset.i); S.painting = true;
    try { g.setPointerCapture(e.pointerId); } catch (err) {}
    apply(c);
  });
  g.addEventListener("pointermove", e => {
    if (!S.painting || !set) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (el && g.contains(el) && el.classList.contains("c")) apply(el);
  });
  const end = () => {
    if (!S.painting || !set) return;
    S.painting = false;
    const finished = set; set = null;
    saveMine(finished);
    render();
  };
  g.addEventListener("pointerup", end);
  g.addEventListener("pointercancel", end);
  g.addEventListener("lostpointercapture", end);
}

boot().catch(() => {
  $("main").replaceChildren(h("div", { class: "panel" }, h("h3", {}, "Couldn't start the app"), h("p", { class: "muted" }, "Check your internet connection and reload the page.")));
});
