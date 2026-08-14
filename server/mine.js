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
  "brandcategory", "asset_purpose", "projecttypeid", "doc_type", "asset_type_id",
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
  if (!Number.isFinite(rows) || rows < 1) rows = 50;
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
    const strategies = [];
    if (auth.cookie) strategies.push({ label: "user-cookie", headers: { Cookie: auth.cookie } });
    if (auth.token) strategies.push({ label: "user-bearer", headers: { Authorization: `Bearer ${auth.token}` } });
    let result = { ok: false, status: 401, error: "Session has no usable credentials" };
    for (const s of strategies) {
      result = await attemptFetch(url, { method, authHeaders: s.headers, timeoutMs });
      result.authUsed = s.label;
      if (result.status !== 401) return result;
    }
    if (auth.token) {
      // Re-bootstrap a fresh session cookie from the (still valid?) token.
      const v = await prontoVerifyToken(auth.token);
      if (v.ok && v.cookie) {
        auth.cookie = v.cookie;
        if (typeof auth.onCookieRefresh === "function") { try { auth.onCookieRefresh(v.cookie); } catch {} }
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
        if (v2.ok && v2.cookie) {
          auth.cookie = v2.cookie;
          if (typeof auth.onCookieRefresh === "function") { try { auth.onCookieRefresh(v2.cookie); } catch {} }
        }
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

/** SAYT lookups via dam.php (get-brands / get-project-types / get-offices /
 *  get-audiences / get-asset-types). All return {menu:[{alias,id}...]} or arrays. */
const LOOKUP_ACTIONS = {
  brands: "get-brands",
  "project-types": "get-project-types",
  offices: "get-offices",
  audiences: "get-audiences",
  "asset-types": "get-asset-types",
};

export async function lookup(kind, { keyword = "", limit = 25, page = 1, auth } = {}) {
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
  // Normalise: {menu:[{alias,id}]} or plain [{id,name}]
  const d = r.data;
  let items = [];
  if (Array.isArray(d)) items = d.map((x) => ({ id: x.id, label: x.name || x.alias || String(x.id) }));
  else if (Array.isArray(d?.menu)) items = d.menu.filter((x) => x.id !== "" && x.id != null).map((x) => ({ id: x.id, label: x.alias }));
  return { ok: true, status: r.status, items };
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
  const rawList = Array.isArray(d) ? d : (d?.collections || d?.data || d?.results || []);
  const items = (Array.isArray(rawList) ? rawList : []).map((c) => ({
    id: c.id ?? c.collection_id ?? c.collectionid,
    label: c.name ?? c.title ?? c.alias ?? `Collection ${c.id}`,
    count: c.asset_count ?? c.count ?? null,
  })).filter((c) => c.id != null);
  return { ok: true, status: r.status, items, raw: items.length ? undefined : d };
}

export async function popularTags({ limit = 20, auth } = {}) {
  const url = `${config.prontoBaseUrl}/v2/ajax/get-popular-tags/dam/${DAM_ID}/limit/${Math.min(Number(limit) || 20, 50)}`;
  const r = await fetchMine(url, { auth });
  if (!r.ok) return r;
  const d = r.data;
  const list = Array.isArray(d) ? d : (d?.tags || d?.data || []);
  const items = (Array.isArray(list) ? list : []).map((t) =>
    typeof t === "string" ? { tag: t } : { tag: t.tag ?? t.name ?? t.alias ?? String(t.id), count: t.count ?? null }
  ).filter((t) => t.tag);
  return { ok: true, status: r.status, items, raw: items.length ? undefined : d };
}

/**
 * Resolve an asset's preview image. {base}/openpreview.php?format=preview&assetid=N
 * (session-cookie auth) responds either with a redirect to a public presigned S3
 * URL, or with the image bytes directly. We try to capture the redirect target so
 * the route can 302 the browser straight to S3 (no proxy bandwidth).
 */
export async function resolveThumb(assetid, { auth } = {}) {
  const url = `${config.prontoBaseUrl}/openpreview.php?format=preview&assetid=${encodeURIComponent(assetid)}`;
  const headers = {};
  if (auth?.cookie) headers.Cookie = auth.cookie;
  else if (auth?.token) headers.Authorization = `Bearer ${auth.token}`;
  else {
    const cookie = await getSessionCookie({});
    if (cookie) headers.Cookie = cookie;
  }
  try {
    const res = await fetch(url, { method: "GET", headers, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (loc) return { ok: true, redirect: loc };
    }
    if (res.ok) {
      const ct = res.headers.get("content-type") || "";
      if (ct.startsWith("image/")) {
        const buf = Buffer.from(await res.arrayBuffer());
        return { ok: true, body: buf, contentType: ct };
      }
      // HTML login page etc.
      return { ok: false, status: 401, error: "Preview not accessible (auth?)" };
    }
    return { ok: false, status: res.status, error: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, status: 0, error: String(err) };
  }
}

/** Same trick for downloads: {base}/open.php?action=download&assetid=N */
export async function resolveDownload(assetid, { auth } = {}) {
  const url = `${config.prontoBaseUrl}/open.php?action=download&assetid=${encodeURIComponent(assetid)}`;
  const headers = {};
  if (auth?.cookie) headers.Cookie = auth.cookie;
  else if (auth?.token) headers.Authorization = `Bearer ${auth.token}`;
  try {
    const res = await fetch(url, { method: "GET", headers, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (loc) return { ok: true, redirect: loc };
    }
    if (res.ok) {
      const ct = res.headers.get("content-type") || "application/octet-stream";
      if (!/text\/html/i.test(ct)) {
        const buf = Buffer.from(await res.arrayBuffer());
        const cd = res.headers.get("content-disposition");
        return { ok: true, body: buf, contentType: ct, contentDisposition: cd };
      }
      return { ok: false, status: 401, error: "Download not accessible (auth?)" };
    }
    return { ok: false, status: res.status, error: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, status: 0, error: String(err) };
  }
}
