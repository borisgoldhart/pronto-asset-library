import { config } from "./config.js";
import { authMode, getSessionCookie, getToken, invalidate, prontoVerifyToken, prontoRefreshToken } from "./session.js";

/**
 * Pronto Mine (DAM) API client.
 *
 * Search endpoint (confirmed live 14 Aug 2026 against havaspronto.com):
 *   POST {base}/v2/search/dam?<params>       (POST with QUERYSTRING params, no body)
 * Returns { assets: [...], success, key, count, meta:{ main_query, start, rows, sort... } }.
 *
 * AUTH: the endpoint is SESSION-COOKIE based — without a valid session cookie it
 * returns the login page (HTML). Same strategy as the Reporting Dashboard's
 * reporting endpoint: cookie first (fast path), bearer fallback, then re-bootstrap
 * a cookie from the token via /v2/api/auth/me and retry.
 *
 * The legacy UI also chains a rotating `key` param (each response returns the key
 * for the next request), but with a valid session cookie the endpoint accepts
 * requests without it (verified live) — so we deliberately don't track it.
 *
 * CONFIRMED filter params (discovered by driving the legacy UI and probing live):
 *   q, exact_match=1, pos, rows, status (all|pending approval|Approved For Release|
 *     approved|Final|partial approval), sort ("asset_title asc" etc.)
 *   brandcategory=<brandcat_id>            Brand (typeahead: dam.php get-brands)
 *   asset_purpose=<id>                     Audience (ids from dam.php get-audiences)
 *   projecttypeid=<id>                     Project Type (dam.php get-project-types)
 *   doc_type=<1..5>                        1 Photo 2 Video 3 Spreadsheet 4 Presentation 5 Document
 *   asset_type_id=<id>                     Asset Type (dam.php get-asset-types)
 *   job_strategic_imperative_id[]=<id>     Strategic Imperative
 *   rating=<0..5>                          "N/5 or greater"
 *   officeid[]=<id>                        Office (dam.php get-offices)
 *   countryiso[]=<ISO2>                    Country
 *   tag[]=<text>                           Tags
 *   collection_search=<collection id>      Collection
 *   author=<text>                          Uploaded By (name match)
 *   archived=y                             Include/only archived
 *   startDate / endDate                    Uploaded date range (YYYY-MM-DD)
 *   approved_for_release_date_before      "Date Approved Released From" (legacy naming quirk)
 *   lenddatefrom / lenddateto              License End Date range
 */

const SEARCH_PATH = "/v2/search/dam";
const DAM_PHP = "/dam.php";
export const DAM_ID = Number(process.env.MINE_DAM_ID || 3);

/** Whitelist of client-suppliable search params. Arrays allowed where noted. */
const SCALAR_PARAMS = new Set([
  "q", "exact_match", "pos", "rows", "status", "sort",
  "brandcategory", "brand_id", "asset_purpose", "projecttypeid", "doc_type", "asset_type_id",
  "rating", "collection_search", "author", "archived",
  "startDate", "endDate",
  "approved_for_release_date_before", "approved_for_release_date_after",
  "lenddatefrom", "lenddateto",
]);
const ARRAY_PARAMS = new Set([
  "officeid", "countryiso", "tag", "job_strategic_imperative_id",
]);

const MAX_ROWS = 100;

/** Build the search querystring from an untrusted client query object. */
export function buildSearchParams(query = {}) {
  const params = new URLSearchParams();
  params.set("damId", String(DAM_ID));

  let rows = parseInt(query.rows, 10);
  if (!Number.isFinite(rows) || rows < 1) rows = 30;
  params.set("rows", String(Math.min(rows, MAX_ROWS)));

  let pos = parseInt(query.pos, 10);
  if (!Number.isFinite(pos) || pos < 0) pos = 0;
  params.set("pos", String(pos));

  params.set("status", typeof query.status === "string" && query.status ? query.status : "all");

  for (const [k, v] of Object.entries(query)) {
    const key = k.replace(/\[\]$/, "");
    if (["rows", "pos", "status", "damId"].includes(key)) continue;
    if (SCALAR_PARAMS.has(key) && !Array.isArray(v)) {
      if (v !== undefined && v !== null && String(v) !== "") params.set(key, String(v));
    } else if (ARRAY_PARAMS.has(key)) {
      const vals = Array.isArray(v) ? v : [v];
      for (const one of vals) {
        if (one !== undefined && one !== null && String(one) !== "") {
          params.append(`${key}[]`, String(one));
        }
      }
    }
  }
  return params;
}

/* ---------------- HTTP with the Dashboard's auth strategy ---------------- */

function looksLikeLoginPage(text) {
  return /Login to proceed|Select your login method|<!doctype html/i.test(text.slice(0, 400));
}

async function attemptFetch(url, { method = "GET", authHeaders = {}, timeoutMs = 45000, redirect = "follow" } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest", ...authHeaders },
      signal: ctrl.signal,
      redirect,
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* HTML => not signed in (or non-JSON endpoint) */ }
    if (data === null) {
      // The Mine endpoints return the login PAGE (HTTP 200 HTML) when the session
      // is invalid — normalise that to a 401 so the auth fallback chain runs.
      if (looksLikeLoginPage(text)) return { ok: false, status: 401, url, error: "Session rejected (login page returned)" };
      return { ok: false, status: res.status, url, error: `Non-JSON response (len ${text.length})` };
    }
    if (!res.ok) {
      return { ok: false, status: res.status, url, error: data?.message || data?.error || `HTTP ${res.status}`, data };
    }
    return { ok: true, status: res.status, url, data };
  } catch (err) {
    return { ok: false, status: 0, url, error: err.name === "AbortError" ? `Timeout after ${timeoutMs}ms` : String(err) };
  } finally {
    clearTimeout(t);
  }
}

/** Persist a freshly minted session cookie onto the auth object AND await the
 *  session-store write — on serverless a fire-and-forget write is lost when the
 *  lambda freezes, which would keep every request on the slow bearer path. */
async function saveCookie(auth, cookie) {
  auth.cookie = cookie;
  try { await Promise.resolve(auth.onCookieRefresh?.(cookie)); } catch {}
}

/**
 * Fetch a Mine API URL with per-user session auth (multi-user mode) or the
 * .env credential fallback. Cookie first (fast), bearer fallback, cookie
 * re-bootstrap via /me, then token refresh — mirrors the Dashboard's fetchReport.
 */
export async function fetchMine(url, { method = "GET", timeoutMs = 45000, auth = null } = {}) {
  if (!auth && authMode() === "none") {
    return { ok: false, status: 401, authRequired: true, error: "Not signed in. Log in with your HavasPronto account." };
  }

  if (auth) {
    // HEDGED AUTH: the /me-minted cookie is not always honoured by /v2/search/dam,
    // and the bearer path is slow (server-side token->session exchange). Racing
    // both in parallel costs one duplicate request but always yields the fastest
    // accepted path — cookie speed when it works, bearer speed when it doesn't.
    if (auth.cookie && auth.token) {
      const tag = (p, label) => p.then((r) => { r.authUsed = label; return r; });
      const both = [
        tag(attemptFetch(url, { method, authHeaders: { Cookie: auth.cookie }, timeoutMs }), "user-cookie"),
        tag(attemptFetch(url, { method, authHeaders: { Authorization: `Bearer ${auth.token}` }, timeoutMs }), "user-bearer"),
      ];
      const winner = await new Promise((resolve) => {
        let settled = 0;
        const results = [];
        both.forEach((p, i) => p.then((r) => {
          results[i] = r;
          if (r.ok) return resolve(r);                    // first accepted answer wins
          if (++settled === both.length) resolve(results[0].status !== 401 ? results[0] : results[1]);
        }));
      });
      if (winner.status !== 401) return winner;
      // both 401 -> fall through to the re-bootstrap chain below
    }
    const strategies = [];
    if (auth.cookie) strategies.push({ label: "user-cookie", headers: { Cookie: auth.cookie } });
    if (auth.token) strategies.push({ label: "user-bearer", headers: { Authorization: `Bearer ${auth.token}` } });
    if (auth.cookie && auth.token) strategies.length = 0;   // already raced above
    let result = { ok: false, status: 401, error: "Session has no usable credentials" };
    for (const s of strategies) {
      result = await attemptFetch(url, { method, authHeaders: s.headers, timeoutMs });
      result.authUsed = s.label;
      if (result.status !== 401) {
        // Bearer rescued a stale/absent cookie: mint a fresh session cookie NOW so
        // the binary endpoints (thumbs/downloads) and the next search get the fast
        // cookie path. Persisted via onCookieRefresh (Redis) for later invocations.
        if (result.ok && s.label === "user-bearer" && auth.token) {
          const v = await prontoVerifyToken(auth.token);
          if (v.ok && v.cookie) await saveCookie(auth, v.cookie);
        }
        return result;
      }
    }
    if (auth.token) {
      // Re-bootstrap a fresh session cookie from the (still valid?) token.
      const v = await prontoVerifyToken(auth.token);
      if (v.ok && v.cookie) {
        await saveCookie(auth, v.cookie);
        result = await attemptFetch(url, { method, authHeaders: { Cookie: v.cookie }, timeoutMs });
        result.authUsed = "user-cookie";
        if (result.status !== 401) return result;
      }
      // Refresh grant, then retry once more.
      const rf = await prontoRefreshToken(auth.token);
      if (rf.ok && rf.token) {
        auth.token = rf.token;
        if (rf.cookie) auth.cookie = rf.cookie;
        if (typeof auth.onTokenRefresh === "function") { try { auth.onTokenRefresh(rf.token, rf.cookie || null); } catch {} }
        const v2 = await prontoVerifyToken(rf.token);
        if (v2.ok && v2.cookie) await saveCookie(auth, v2.cookie);
        if (auth.cookie) {
          result = await attemptFetch(url, { method, authHeaders: { Cookie: auth.cookie }, timeoutMs });
          result.authUsed = "user-cookie-refreshed";
          if (result.status !== 401) return result;
        }
      }
    }
    result.authRequired = true;
    return result;
  }

  // .env credential mode
  const strategies = async (forceRefresh) => {
    if (authMode() === "cookie") return [{ label: "cookie", headers: { Cookie: config.cookie } }];
    const out = [];
    const cookie = await getSessionCookie({ forceRefresh });
    if (cookie) out.push({ label: "cookie", headers: { Cookie: cookie } });
    const token = await getToken({ forceRefresh });
    if (token) out.push({ label: "bearer", headers: { Authorization: `Bearer ${token}` } });
    return out;
  };
  let result;
  for (const s of await strategies(false)) {
    result = await attemptFetch(url, { method, authHeaders: s.headers, timeoutMs });
    result.authUsed = s.label;
    if (result.status !== 401) return result;
  }
  if (authMode() === "login") {
    invalidate();
    for (const s of await strategies(true)) {
      result = await attemptFetch(url, { method, authHeaders: s.headers, timeoutMs });
      result.authUsed = s.label;
      if (result.status !== 401) return result;
    }
  }
  return result;
}

/* ---------------- high-level operations ---------------- */

export async function searchAssets(query, { auth } = {}) {
  const params = buildSearchParams(query);
  const url = `${config.prontoBaseUrl}${SEARCH_PATH}?${params.toString()}`;
  const r = await fetchMine(url, { method: "POST", timeoutMs: 60000, auth });
  if (!r.ok) return r;
  const d = r.data || {};
  return {
    ok: true,
    status: r.status,
    authUsed: r.authUsed,
    count: d.count ?? 0,
    assets: Array.isArray(d.assets) ? d.assets : [],
    meta: { start: d.meta?.start, rows: d.meta?.rows, sort: d.meta?.sort, order: d.meta?.order },
  };
}

/** The Audience filter (-> asset_purpose param) is dam-level config rendered
 *  server-side by the legacy page; dam.php get-audiences returns a DIFFERENT
 *  taxonomy. These id/label pairs were captured from the live Mine UI. */
const AUDIENCES = [
  [25, "Consumer"], [32, "Crisis Management"], [35, "Digital"],
  [6, "Do not use without permission"], [30, "Event"], [31, "Internal"],
  [29, "Media"], [34, "Offline"], [2, "Online"], [9, "Other"], [4, "Outdoor"],
  [26, "Owned Asset"], [23, "Patient"], [21, "Pitch"], [1, "Print"],
  [28, "Professional"], [24, "Professional Med Ed"], [27, "Professional Unbranded"],
  [33, "Public Relations"], [5, "Region specific, contact uploader for use"],
  [22, "Strategy"], [3, "TV"],
].map(([id, label]) => ({ id, label }));

/** SAYT lookups via dam.php (get-brands / get-project-types / get-offices /
 *  get-asset-types). Response shapes vary by action — normalise generically. */
const LOOKUP_ACTIONS = {
  brands: "get-brands",
  "project-types": "get-project-types",
  offices: "get-offices",
  "asset-types": "get-asset-types",
};

function labelOf(x) {
  return x.alias ?? x.name ?? x.text ?? x.title ?? x.label ?? null;
}
/** Find the first array of {id,label-ish} objects anywhere in the response. */
function extractItems(d) {
  const tryArr = (arr) => arr
    .filter((x) => x && typeof x === "object" && x.id !== "" && x.id != null && labelOf(x) != null)
    .map((x) => ({ id: x.id, label: String(labelOf(x)) }));
  if (Array.isArray(d)) return tryArr(d);
  if (d && typeof d === "object") {
    for (const v of Object.values(d)) {
      if (Array.isArray(v)) { const items = tryArr(v); if (items.length) return items; }
    }
    // object-of-objects keyed "0","1",... (e.g. get-collections)
    const vals = Object.values(d).filter((v) => v && typeof v === "object");
    if (vals.length) { const items = tryArr(vals); if (items.length) return items; }
  }
  return [];
}

export async function lookup(kind, { keyword = "", limit = 25, page = 1, auth } = {}) {
  if (kind === "audiences") {
    const kw = String(keyword || "").toLowerCase();
    return { ok: true, status: 200, items: AUDIENCES.filter((a) => !kw || a.label.toLowerCase().includes(kw)) };
  }
  const action = LOOKUP_ACTIONS[kind];
  if (!action) return { ok: false, status: 400, error: `Unknown lookup: ${kind}` };
  const params = new URLSearchParams({
    action, dam_id: String(DAM_ID), sayt: "true",
    limit: String(Math.min(Number(limit) || 25, 100)), paginate: "y", page: String(Number(page) || 1),
  });
  if (keyword) params.set("keyword", String(keyword));
  const url = `${config.prontoBaseUrl}${DAM_PHP}?${params.toString()}`;
  const r = await fetchMine(url, { auth });
  if (!r.ok) return r;
  return { ok: true, status: r.status, items: extractItems(r.data) };
}

export async function listCollections({ search = "", limit = 20, page = 0, auth } = {}) {
  const params = new URLSearchParams({
    action: "get-collections", format: "json", dam_id: String(DAM_ID),
    limit: String(Math.min(Number(limit) || 20, 100)), page: String(Number(page) || 0),
    search: String(search || ""), "my-collection": "all", mine: "1",
  });
  const url = `${config.prontoBaseUrl}${DAM_PHP}?${params.toString()}`;
  const r = await fetchMine(url, { auth });
  if (!r.ok) return r;
  const d = r.data;
  let rawList = Array.isArray(d) ? d : (d?.collections || d?.data || d?.results || null);
  // get-collections returns an object keyed "0","1",... — not an array
  if (!rawList && d && typeof d === "object") rawList = Object.values(d).filter((v) => v && typeof v === "object");
  const items = (Array.isArray(rawList) ? rawList : []).map((c) => ({
    id: c.id ?? c.collection_id ?? c.collectionid,
    label: c.name ?? c.title ?? c.alias ?? `Collection ${c.id}`,
    count: c.asset_count ?? c.count ?? null,
  })).filter((c) => c.id != null && c.label != null);
  return { ok: true, status: r.status, items };
}

export async function popularTags({ limit = 20, auth } = {}) {
  const url = `${config.prontoBaseUrl}/v2/ajax/get-popular-tags/dam/${DAM_ID}/limit/${Math.min(Number(limit) || 20, 50)}`;
  const r = await fetchMine(url, { auth });
  if (!r.ok) return r;
  const d = r.data;
  const list = Array.isArray(d) ? d : (d?.items || d?.tags || d?.data || []);
  const items = (Array.isArray(list) ? list : []).map((t) =>
    typeof t === "string" ? { tag: t } : { tag: t.title ?? t.tag ?? t.name ?? t.alias ?? String(t.id), count: t.count ?? null }
  ).filter((t) => t.tag);
  return { ok: true, status: r.status, items };
}

/* ---------------- binary endpoints (previews + downloads) ----------------
 * Both are legacy session-cookie PHP routes. Auth chain per request:
 * stored cookie → bearer → fresh cookie minted via /v2/api/auth/me (persisted
 * back to the session), so a stale login cookie self-heals. */

async function fetchBinary(url, headers, { follow = false } = {}) {
  try {
    const res = await fetch(url, { method: "GET", headers, redirect: follow ? "follow" : "manual" });
    if (!follow && res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (loc) return { ok: true, redirect: loc };
    }
    if (res.ok) {
      const ct = res.headers.get("content-type") || "";
      if (ct && !/text\/html/i.test(ct)) {
        const buf = Buffer.from(await res.arrayBuffer());
        return {
          ok: true, body: buf,
          contentType: ct || "application/octet-stream",
          contentDisposition: res.headers.get("content-disposition"),
        };
      }
      return { ok: false, status: 401, error: "HTML returned (not signed in for this endpoint)" };
    }
    return { ok: false, status: res.status, error: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, status: 0, error: String(err) };
  }
}

async function resolveBinary(url, { auth, follow = false } = {}) {
  const tries = [];
  if (auth?.cookie) tries.push({ Cookie: auth.cookie });
  if (auth?.token) tries.push({ Authorization: `Bearer ${auth.token}` });
  if (!auth) {
    const cookie = await getSessionCookie({});
    if (cookie) tries.push({ Cookie: cookie });
  }
  let last = { ok: false, status: 401, error: "No usable credentials" };
  for (const h of tries) {
    last = await fetchBinary(url, h, { follow });
    if (last.ok) return last;
  }
  // Stale cookie + bearer both refused: mint a fresh session cookie and retry once.
  if (auth?.token) {
    const v = await prontoVerifyToken(auth.token);
    if (v.ok && v.cookie) {
      await saveCookie(auth, v.cookie);
      return fetchBinary(url, { Cookie: v.cookie }, { follow });
    }
  }
  return last;
}

/**
 * Preview image for an asset. Resolves Pronto's redirect and 302s the BROWSER
 * to the presigned CloudFront/S3 URL — the bytes never pass through the
 * function, images download in parallel from the CDN, and the redirect response
 * itself carries Cache-Control so the stable /api/mine/thumb/<id> URL is cached
 * browser-side for repeat views. Falls back to proxying bytes when Pronto
 * serves the image directly.
 */
export function resolveThumb(assetid, { auth } = {}) {
  const url = `${config.prontoBaseUrl}/openpreview.php?format=preview&assetid=${encodeURIComponent(assetid)}`;
  return resolveBinary(url, { auth, follow: false });
}

/** Download: keep the redirect (files can be huge — don't proxy the bytes). */
export function resolveDownload(assetid, { auth } = {}) {
  const url = `${config.prontoBaseUrl}/open.php?action=download&assetid=${encodeURIComponent(assetid)}`;
  return resolveBinary(url, { auth, follow: false });
}
