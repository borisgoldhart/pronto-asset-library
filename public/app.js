/* Pronto Asset Library — SPA.
 * Talks only to this app's backend (/api/mine/*, /api/auth/*); the backend holds
 * the Pronto credentials and proxies the Mine (DAM) SOLR search. Auth contract is
 * identical to the Pronto Reporting Dashboard. */

"use strict";
const $ = (id) => document.getElementById(id);

/* ---------------- state ---------------- */
const state = {
  q: "", exact: false, status: "all", archived: false,
  brand: null,            // {id,label} -> brandcategory
  audience: "",           // id -> asset_purpose
  projecttype: null,      // {id,label} -> projecttypeid
  assettype: null,        // {id,label} -> asset_type_id
  doctype: "",            // -> doc_type
  offices: [],            // [{id,label}] -> officeid[]
  tags: [],               // [text] -> tag[]
  collection: "",         // id -> collection_search
  rating: "",             // -> rating
  dateFrom: "", dateTo: "",  // -> startDate / endDate
  author: "",
  sort: "", rows: 50, page: 1,
};
let COUNT = 0;
let FETCH_SEQ = 0;

/* ---------------- api helper ---------------- */
async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => null);
  if (r.status === 401 && j && j.authRequired) { showLogin(AUTH_INFO); throw new Error("auth"); }
  if (!r.ok || (j && j.ok === false)) throw new Error((j && j.error) || `HTTP ${r.status}`);
  return j;
}

/* ---------------- search ---------------- */
function buildQuery() {
  const p = new URLSearchParams();
  if (state.q) p.set("q", state.q);
  if (state.exact && state.q) p.set("exact_match", "1");
  p.set("status", state.status || "all");
  if (state.archived) p.set("archived", "y");
  if (state.brand) p.set("brandcategory", state.brand.id);
  if (state.audience) p.set("asset_purpose", state.audience);
  if (state.projecttype) p.set("projecttypeid", state.projecttype.id);
  if (state.assettype) p.set("asset_type_id", state.assettype.id);
  if (state.doctype) p.set("doc_type", state.doctype);
  state.offices.forEach((o) => p.append("officeid[]", o.id));
  state.tags.forEach((t) => p.append("tag[]", t));
  if (state.collection) p.set("collection_search", state.collection);
  if (state.rating) p.set("rating", state.rating);
  if (state.dateFrom) p.set("startDate", state.dateFrom);
  if (state.dateTo) p.set("endDate", state.dateTo);
  if (state.author) p.set("author", state.author);
  if (state.sort) p.set("sort", state.sort);
  p.set("rows", String(state.rows));
  p.set("pos", String((state.page - 1) * state.rows));
  return p;
}

async function runSearch() {
  const seq = ++FETCH_SEQ;
  $("loading").hidden = false;
  $("emptyState").hidden = true;
  try {
    const r = await api(`/api/mine/search?${buildQuery().toString()}`);
    if (seq !== FETCH_SEQ) return;      // superseded by a newer search
    COUNT = r.count || 0;
    renderGrid(r.assets || []);
    renderPagination();
    renderActiveChips();
    $("resultCount").textContent = COUNT ? `${COUNT.toLocaleString()} assets` : "";
    $("emptyState").hidden = COUNT > 0;
  } catch (e) {
    if (seq !== FETCH_SEQ) return;
    if (String(e.message) !== "auth") {
      $("grid").innerHTML = "";
      $("emptyState").hidden = false;
      $("emptyState").textContent = `Search failed: ${e.message}`;
    }
  } finally {
    $("loading").hidden = true;
  }
}
function newSearch() { state.page = 1; runSearch(); }

/* ---------------- rendering ---------------- */
function esc(s) { return String(s ?? "").replace(/[&<>\"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

function fmtSize(bytes) {
  const b = Number(bytes);
  if (!Number.isFinite(b) || b <= 0) return "";
  if (b > 1048576) return (b / 1048576).toFixed(1) + " MB";
  if (b > 1024) return (b / 1024).toFixed(0) + " KB";
  return b + " B";
}
function fmtDate(d) {
  if (!d) return "";
  const m = String(d).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  const t = new Date(d);
  return isNaN(t) ? "" : t.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" });
}
function extOf(title) {
  const m = /\.([a-z0-9]{2,5})$/i.exec(String(title || ""));
  return m ? m[1].toUpperCase() : "";
}

function renderGrid(assets) {
  const grid = $("grid");
  grid.innerHTML = assets.map((a) => {
    const status = String(a.status || "");
    const sClass = "s-" + status.toLowerCase().replace(/[^a-z]+/g, "-");
    const meta = [a.author, fmtSize(a.filesize), fmtDate(a.uploaddate)].filter(Boolean).join(" | ");
    const iter = a.asset_iteration ? ` <small>(V${esc(a.asset_iteration)})</small>` : "";
    return `<div class=\"card\" data-id=\"${esc(a.assetid)}\">
      <div class=\"card-thumb\">
        <div class=\"ext\">${esc(extOf(a.title))}</div>
        <img loading=\"lazy\" src=\"/api/mine/thumb/${esc(a.assetid)}\" alt=\"\"
             onerror=\"this.remove()\" />
        ${status ? `<span class=\"card-status ${sClass}\">${esc(status)}</span>` : ""}
        <div class=\"card-actions\">
          <a href=\"/api/mine/download/${esc(a.assetid)}\" title=\"Download\" download>&#8681;</a>
        </div>
      </div>
      <div class=\"card-body\">
        <div class=\"card-title\" title=\"${esc(a.title)}\">${esc(a.title)}${iter}</div>
        ${a.brandname ? `<div class=\"card-brand\">${esc(a.brandname)}</div>` : ""}
        ${meta ? `<div class=\"card-meta\">${esc(meta)}</div>` : ""}
      </div>
    </div>`;
  }).join("");
}

function renderPagination() {
  const nav = $("pagination");
  const pages = Math.max(1, Math.ceil(COUNT / state.rows));
  if (pages <= 1) { nav.innerHTML = ""; return; }
  const cur = Math.min(state.page, pages);
  const parts = [];
  const btn = (p, label, opts = {}) =>
    `<button class=\"page-btn ${opts.cur ? "cur" : ""}\" data-page=\"${p}\" ${opts.dis ? "disabled" : ""}>${label}</button>`;
  parts.push(btn(cur - 1, "‹", { dis: cur === 1 }));
  const win = [];
  const push = (p) => { if (p >= 1 && p <= pages && !win.includes(p)) win.push(p); };
  push(1); push(2);
  for (let p = cur - 2; p <= cur + 2; p++) push(p);
  push(pages - 1); push(pages);
  win.sort((a, b) => a - b);
  let last = 0;
  for (const p of win) {
    if (p - last > 1) parts.push(`<span class=\"page-gap\">…</span>`);
    parts.push(btn(p, String(p), { cur: p === cur }));
    last = p;
  }
  parts.push(btn(cur + 1, "›", { dis: cur === pages }));
  nav.innerHTML = parts.join("");
  nav.querySelectorAll("button[data-page]").forEach((b) => {
    b.addEventListener("click", () => {
      const p = parseInt(b.dataset.page, 10);
      if (!p || p === state.page || b.disabled || b.classList.contains("cur")) return;
      state.page = p;
      runSearch();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });
}

/* Active-filter chips above the grid (mirrors the legacy UI's chip bar). */
function renderActiveChips() {
  const chips = [];
  const add = (label, clear) => chips.push({ label, clear });
  if (state.q) add(`“${state.q}”`, () => { state.q = ""; $("f_q").value = ""; });
  if (state.status !== "all") add($("f_status").selectedOptions[0]?.textContent || state.status, () => { state.status = "all"; $("f_status").value = "all"; });
  if (state.archived) add("Archived", () => { state.archived = false; $("f_archived").checked = false; });
  if (state.brand) add(state.brand.label, () => setBrand(null));
  if (state.audience) add($("f_audience").selectedOptions[0]?.textContent || "Audience", () => { state.audience = ""; $("f_audience").value = ""; });
  if (state.projecttype) add(state.projecttype.label, () => setProjecttype(null));
  if (state.assettype) add(state.assettype.label, () => setAssettype(null));
  if (state.doctype) add($("f_doctype").selectedOptions[0]?.textContent || "Type", () => { state.doctype = ""; $("f_doctype").value = ""; });
  state.offices.forEach((o) => add(o.label, () => { state.offices = state.offices.filter((x) => x.id !== o.id); renderOfficeChips(); }));
  state.tags.forEach((t) => add(`#${t}`, () => { state.tags = state.tags.filter((x) => x !== t); renderTagChips(); }));
  if (state.collection) add($("f_collection").selectedOptions[0]?.textContent || "Collection", () => { state.collection = ""; $("f_collection").value = ""; });
  if (state.rating) add(`${state.rating}/5+`, () => { state.rating = ""; $("f_rating").value = ""; });
  if (state.dateFrom) add(`from ${state.dateFrom}`, () => { state.dateFrom = ""; $("f_dateFrom").value = ""; });
  if (state.dateTo) add(`to ${state.dateTo}`, () => { state.dateTo = ""; $("f_dateTo").value = ""; });
  if (state.author) add(`by ${state.author}`, () => { state.author = ""; $("f_author").value = ""; });

  const box = $("activeChips");
  box.innerHTML = chips.map((c, i) =>
    `<span class=\"chip\"><span>${esc(c.label)}</span><button data-i=\"${i}\" title=\"Remove\">×</button></span>`).join("");
  box.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => { chips[Number(b.dataset.i)].clear(); newSearch(); });
  });
}

/* ---------------- SAYT pickers ---------------- */
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

function wireSayt({ input, menu, fetcher, onPick, minChars = 0 }) {
  const inp = $(input), mn = $(menu);
  let items = [];
  const close = () => mn.classList.remove("open");
  const open = () => mn.classList.add("open");
  const render = () => {
    mn.innerHTML = items.length
      ? items.map((it, i) => `<div class=\"sayt-item\" data-i=\"${i}\">${esc(it.label)}</div>`).join("")
      : `<div class=\"sayt-empty\">No matches</div>`;
    mn.querySelectorAll(".sayt-item").forEach((el) => {
      el.addEventListener("mousedown", (e) => {       // mousedown beats input blur
        e.preventDefault();
        onPick(items[Number(el.dataset.i)]);
        inp.value = "";
        close();
      });
    });
    open();
  };
  const load = debounce(async () => {
    const kw = inp.value.trim();
    if (kw.length < minChars) { close(); return; }
    try {
      items = await fetcher(kw);
      render();
    } catch { close(); }
  }, 250);
  inp.addEventListener("input", load);
  inp.addEventListener("focus", load);
  inp.addEventListener("blur", () => setTimeout(close, 150));
}

const lookupFetcher = (kind) => async (kw) =>
  (await api(`/api/mine/lookup/${kind}?keyword=${encodeURIComponent(kw)}&limit=25`)).items;

function chipHtml(label) {
  return `<span class=\"chip\"><span>${esc(label)}</span><button title=\"Remove\">×</button></span>`;
}
function setBrand(v) {
  state.brand = v;
  $("brandChip").innerHTML = v ? chipHtml(v.label) : "";
  $("brandChip").querySelector("button")?.addEventListener("click", () => { setBrand(null); newSearch(); });
}
function setProjecttype(v) {
  state.projecttype = v;
  $("projecttypeChip").innerHTML = v ? chipHtml(v.label) : "";
  $("projecttypeChip").querySelector("button")?.addEventListener("click", () => { setProjecttype(null); newSearch(); });
}
function setAssettype(v) {
  state.assettype = v;
  $("assettypeChip").innerHTML = v ? chipHtml(v.label) : "";
  $("assettypeChip").querySelector("button")?.addEventListener("click", () => { setAssettype(null); newSearch(); });
}
function renderOfficeChips() {
  const box = $("officeChips");
  box.innerHTML = state.offices.map((o) => chipHtml(o.label)).join("");
  box.querySelectorAll("button").forEach((b, i) => {
    b.addEventListener("click", () => { state.offices.splice(i, 1); renderOfficeChips(); newSearch(); });
  });
}
function renderTagChips() {
  const box = $("tagChips");
  box.innerHTML = state.tags.map((t) => chipHtml(t)).join("");
  box.querySelectorAll("button").forEach((b, i) => {
    b.addEventListener("click", () => { state.tags.splice(i, 1); renderTagChips(); newSearch(); });
  });
}

/* ---------------- facet data loads ---------------- */
async function loadStaticFacets() {
  // Audience list
  try {
    const r = await api("/api/mine/lookup/audiences?limit=100");
    $("f_audience").innerHTML = `<option value=\"\">Any audience</option>` +
      r.items.map((i) => `<option value=\"${esc(i.id)}\">${esc(i.label)}</option>`).join("");
  } catch {}
  // Collections
  try {
    const r = await api("/api/mine/collections?limit=50");
    $("f_collection").innerHTML = `<option value=\"\">Any collection</option>` +
      r.items.map((i) => `<option value=\"${esc(i.id)}\">${esc(i.label)}</option>`).join("");
  } catch {}
  // Popular tags
  try {
    const r = await api("/api/mine/tags/popular?limit=15");
    $("popularTags").innerHTML = r.items.map((t) => `<span class=\"pop-tag\">${esc(t.tag)}</span>`).join("");
    $("popularTags").querySelectorAll(".pop-tag").forEach((el) => {
      el.addEventListener("click", () => {
        const tag = el.textContent;
        if (!state.tags.includes(tag)) { state.tags.push(tag); renderTagChips(); newSearch(); }
      });
    });
  } catch {}
}

/* ---------------- wiring ---------------- */
function wireControls() {
  $("searchBtn").addEventListener("click", () => { state.q = $("f_q").value.trim(); newSearch(); });
  $("f_q").addEventListener("keydown", (e) => { if (e.key === "Enter") { state.q = $("f_q").value.trim(); newSearch(); } });
  $("f_exact").addEventListener("change", (e) => { state.exact = e.target.checked; if (state.q) newSearch(); });
  $("f_status").addEventListener("change", (e) => { state.status = e.target.value; newSearch(); });
  $("f_archived").addEventListener("change", (e) => { state.archived = e.target.checked; newSearch(); });
  $("f_audience").addEventListener("change", (e) => { state.audience = e.target.value; newSearch(); });
  $("f_doctype").addEventListener("change", (e) => { state.doctype = e.target.value; newSearch(); });
  $("f_collection").addEventListener("change", (e) => { state.collection = e.target.value; newSearch(); });
  $("f_rating").addEventListener("change", (e) => { state.rating = e.target.value; newSearch(); });
  $("f_dateFrom").addEventListener("change", (e) => { state.dateFrom = e.target.value; newSearch(); });
  $("f_dateTo").addEventListener("change", (e) => { state.dateTo = e.target.value; newSearch(); });
  $("f_author").addEventListener("change", (e) => { state.author = e.target.value.trim(); newSearch(); });
  $("f_sort").addEventListener("change", (e) => { state.sort = e.target.value; newSearch(); });
  $("f_rows").addEventListener("change", (e) => { state.rows = parseInt(e.target.value, 10) || 50; newSearch(); });

  $("f_tag").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const tag = $("f_tag").value.trim();
      if (tag && !state.tags.includes(tag)) { state.tags.push(tag); renderTagChips(); newSearch(); }
      $("f_tag").value = "";
    }
  });

  $("clearBtn").addEventListener("click", () => {
    Object.assign(state, {
      q: "", exact: false, status: "all", archived: false, brand: null, audience: "",
      projecttype: null, assettype: null, doctype: "", offices: [], tags: [],
      collection: "", rating: "", dateFrom: "", dateTo: "", author: "", page: 1,
    });
    ["f_q", "f_author", "f_tag", "f_brand", "f_projecttype", "f_assettype", "f_office"].forEach((id) => { $(id).value = ""; });
    ["f_status"].forEach((id) => { $(id).value = "all"; });
    ["f_audience", "f_doctype", "f_collection", "f_rating"].forEach((id) => { $(id).value = ""; });
    ["f_dateFrom", "f_dateTo"].forEach((id) => { $(id).value = ""; });
    $("f_exact").checked = false; $("f_archived").checked = false;
    setBrand(null); setProjecttype(null); setAssettype(null);
    renderOfficeChips(); renderTagChips();
    runSearch();
  });

  wireSayt({
    input: "f_brand", menu: "brandMenu", minChars: 1,
    fetcher: lookupFetcher("brands"),
    onPick: (it) => { setBrand(it); newSearch(); },
  });
  wireSayt({
    input: "f_projecttype", menu: "projecttypeMenu",
    fetcher: lookupFetcher("project-types"),
    onPick: (it) => { setProjecttype(it); newSearch(); },
  });
  wireSayt({
    input: "f_assettype", menu: "assettypeMenu",
    fetcher: lookupFetcher("asset-types"),
    onPick: (it) => { setAssettype(it); newSearch(); },
  });
  wireSayt({
    input: "f_office", menu: "officeMenu", minChars: 1,
    fetcher: lookupFetcher("offices"),
    onPick: (it) => {
      if (!state.offices.some((o) => o.id === it.id)) { state.offices.push(it); renderOfficeChips(); newSearch(); }
    },
  });
}

/* ---------------- login / logout (identical contract to the Dashboard) ---------------- */
let AUTH_INFO = null;

function showLogin(info) {
  if (info) AUTH_INFO = info;
  const el = $("loginScreen");
  if (!el) return;
  const link = $("tokenGenLink");
  const url = AUTH_INFO && AUTH_INFO.tokenGeneratorUrl;
  if (link) { if (url) { link.href = url; link.hidden = false; } else { link.hidden = true; } }
  const brokerOff = AUTH_INFO && AUTH_INFO.broker === false;
  const bb = $("brokerBtn"), bd = $("brokerDivider");
  if (bb) bb.hidden = brokerOff;
  if (bd) bd.hidden = brokerOff;
  el.hidden = false;
}
function hideLogin() { const el = $("loginScreen"); if (el) el.hidden = true; }

window.prontoLogout = async () => {
  try { await fetch("/api/auth/logout", { method: "POST" }); } catch {}
  location.reload();
};

function wireLogin() {
  const err = (m) => { const e = $("loginErr"); if (e) { e.textContent = m || ""; e.hidden = !m; } };
  const submit = async (body, btn) => {
    err(""); const prev = btn.textContent; btn.disabled = true; btn.textContent = "Signing in…";
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => null);
      if (j && j.ok) { location.reload(); return; }
      err((j && j.error) || `Login failed (HTTP ${r.status})`);
    } catch (e) { err(String(e)); }
    btn.disabled = false; btn.textContent = prev;
  };
  $("loginForm")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const email = $("l_email").value.trim(), password = $("l_password").value;
    if (!email || !password) return err("Enter your email and password.");
    submit({ email, password }, e.submitter || e.target.querySelector("button"));
  });
  $("tokenForm")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const token = $("l_token").value.trim();
    if (!token) return err("Paste a token first.");
    submit({ token }, e.submitter || e.target.querySelector("button"));
  });

  const brokerBtn = $("brokerBtn");
  brokerBtn?.addEventListener("click", async () => {
    err("");
    const st = $("brokerStatus");
    const prev = brokerBtn.textContent;
    const reset = () => { brokerBtn.disabled = false; brokerBtn.textContent = prev; if (st) st.hidden = true; };
    brokerBtn.disabled = true; brokerBtn.textContent = "Opening Pronto sign-in…";
    let start;
    try {
      const r = await fetch("/api/auth/broker/start", { method: "POST" });
      start = await r.json().catch(() => null);
      if (!start || !start.ok) { err((start && start.error) || `Could not start sign-in (HTTP ${r.status})`); return reset(); }
    } catch (e) { err(String(e)); return reset(); }

    const popup = window.open(start.loginUrl, "_blank");
    if (popup) { try { popup.opener = null; } catch {} }
    if (st) {
      st.hidden = false;
      st.textContent = popup
        ? "Complete the sign-in in the Pronto tab — it closes by itself and this page finishes automatically."
        : "Popup blocked — allow popups for this site, or complete the sign-in in another tab; this page finishes automatically.";
    }
    brokerBtn.textContent = "Waiting for Pronto sign-in…";

    const startedAt = Date.now();
    const poll = async () => {
      if (Date.now() - startedAt > 5 * 60 * 1000) { err("Timed out waiting for the Pronto sign-in. Try again."); return reset(); }
      try {
        const pr = await fetch("/api/auth/broker/poll", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pid: start.pid }),
        });
        const pj = await pr.json().catch(() => null);
        if (pj && pj.ok && !pj.pending) {
          try { if (popup && !popup.closed) popup.close(); } catch {}
          try { window.focus(); } catch {}
          location.reload(); return;
        }
        if (pj && pj.ok && pj.pending) { setTimeout(poll, pj.retryAfter ? pj.retryAfter * 1000 : (start.pollMs || 3000)); return; }
        err((pj && pj.error) || "Pronto sign-in failed. Try again.");
        reset();
      } catch { setTimeout(poll, 5000); }
    };
    setTimeout(poll, start.pollMs || 3000);
  });
}

/* ---------------- init ---------------- */
function userLabel(u) { return (u && (u.name || u.email)) || "Signed in"; }

async function main() {
  wireLogin();
  wireControls();
  try {
    const r = await fetch("/api/auth/status");
    const who = await r.json().catch(() => null);
    AUTH_INFO = who;
    window.ProntoPage = window.ProntoPage || {};
    window.ProntoPage.user = who && who.identity ? { name: userLabel(who.identity), href: "#" } : {};
    document.querySelector("pronto-nav")?.refresh?.();
    if (!who || who.authRequired) { showLogin(who); return; }
  } catch { showLogin(AUTH_INFO); return; }
  hideLogin();
  loadStaticFacets();
  runSearch();
}

main();
