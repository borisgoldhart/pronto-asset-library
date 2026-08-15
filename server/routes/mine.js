import { Router } from "express";
import { config } from "../config.js";
import { prontoVerifyToken } from "../session.js";
import { searchAssets, facetCounts, buildSearchParams, lookup, listCollections, popularTags, resolveThumb, resolveVideo, resolveDownload, DAM_ID } from "../mine.js";

const router = Router();

function requireAuthish(req, res) {
  const p = req.pronto || { mode: "none" };
  if (p.mode === "none") {
    res.status(401).json({ ok: false, authRequired: true, error: "Not signed in" });
    return null;
  }
  return p;
}

/** Main search. All filter params ride the querystring (whitelisted server-side).
 *  NOTE: finance-doc exclusion must happen SERVER-SIDE in the SOLR bridge so
 *  counts/pagination stay correct — see Pulse ticket #83376 (SOLR Squad Issues).
 *  A proxy-side page filter was tried and removed: it made pages patchy. */
router.get("/search", async (req, res) => {
  const p = requireAuthish(req, res);
  if (!p) return;
  const r = await searchAssets(req.query, { auth: p.auth });
  if (!r.ok) return res.status(r.status || 502).json({ ok: false, error: r.error, authRequired: r.authRequired });
  res.json({ ok: true, count: r.count, assets: r.assets, meta: r.meta, damId: DAM_ID });
});

/** Facet counts for the left nav — same filter params as /search. */
router.get("/facets", async (req, res) => {
  const p = requireAuthish(req, res);
  if (!p) return;
  const r = await facetCounts(req.query, { auth: p.auth, limit: req.query.limit });
  if (!r.ok) return res.status(r.status || 502).json({ ok: false, error: r.error, authRequired: r.authRequired });
  res.json({ ok: true, count: r.count, groups: r.groups });
});

/** TEMP diagnostic: which upstream auth/param strategy does search_counts accept?
 *  Remove once the winning strategy is baked into facetCounts. */
router.get("/facets-debug", async (req, res) => {
  const p = requireAuthish(req, res);
  if (!p) return;
  const auth = p.auth || {};
  const params = buildSearchParams(req.query);
  params.delete("pos"); params.delete("rows"); params.delete("sort");
  params.set("limit", "3"); params.set("order", "desc");
  const base = `${config.prontoBaseUrl}/v2/ajax/reports/search_counts?`;
  const out = [];
  const attempt = async (label, url, headers) => {
    try {
      const r = await fetch(url, { headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest", ...headers } });
      const t = await r.text();
      let j = null; try { j = JSON.parse(t); } catch {}
      out.push({ label, status: r.status, facets: !!(j && j.facets),
        n: j && j.response ? j.response.numFound : null,
        err: (j && (j.error || j.message)) || null, html: !j ? t.slice(0, 60) : null });
      return !!(j && j.facets);
    } catch (e) { out.push({ label, err: String(e) }); return false; }
  };
  const cookieH = auth.cookie ? { Cookie: auth.cookie } : null;
  const bearerH = auth.token ? { Authorization: `Bearer ${auth.token}` } : null;
  const qs = base + params.toString();
  if (cookieH) await attempt("stored-cookie", qs, cookieH);
  // Fresh cookie minted from the bearer via /v2/api/auth/me
  let freshH = null;
  if (auth.token) {
    const v = await prontoVerifyToken(auth.token);
    out.push({ label: "mint-fresh-cookie", ok: v.ok, gotCookie: !!v.cookie });
    if (v.ok && v.cookie) freshH = { Cookie: v.cookie };
  }
  if (freshH) await attempt("fresh-cookie", qs, freshH);
  // Warm the web session by loading the Mine page, then retry
  const warm = async (label, h) => {
    try {
      const w = await fetch(`${config.prontoBaseUrl}/v2/mine`, { headers: { ...h, Accept: "text/html" }, redirect: "follow" });
      const t = await w.text();
      out.push({ label, status: w.status, len: t.length, login: /data-page="login"/.test(t.slice(0, 400)) });
    } catch (e) { out.push({ label, err: String(e) }); }
  };
  if (freshH) { await warm("warm-v2mine-fresh", freshH); await attempt("fresh-cookie-after-warm", qs, freshH); }
  else if (cookieH) { await warm("warm-v2mine-stored", cookieH); await attempt("stored-cookie-after-warm", qs, cookieH); }
  if (freshH && bearerH) await attempt("fresh-cookie+bearer", qs, { ...freshH, ...bearerH });
  res.json({ ok: true, hasCookie: !!cookieH, hasToken: !!bearerH, debug: out });
});

/** SAYT lookups: /api/mine/lookup/brands?keyword=ha  (brands | project-types |
 *  offices | audiences | asset-types) */
router.get("/lookup/:kind", async (req, res) => {
  const p = requireAuthish(req, res);
  if (!p) return;
  const r = await lookup(req.params.kind, {
    keyword: req.query.keyword || "", limit: req.query.limit, page: req.query.page, auth: p.auth,
  });
  if (!r.ok) return res.status(r.status || 502).json({ ok: false, error: r.error, authRequired: r.authRequired });
  res.json({ ok: true, items: r.items });
});

router.get("/collections", async (req, res) => {
  const p = requireAuthish(req, res);
  if (!p) return;
  const r = await listCollections({ search: req.query.search || "", limit: req.query.limit, page: req.query.page, auth: p.auth });
  if (!r.ok) return res.status(r.status || 502).json({ ok: false, error: r.error, authRequired: r.authRequired });
  res.json({ ok: true, items: r.items, raw: r.raw });
});

router.get("/tags/popular", async (req, res) => {
  const p = requireAuthish(req, res);
  if (!p) return;
  const r = await popularTags({ limit: req.query.limit, auth: p.auth });
  if (!r.ok) return res.status(r.status || 502).json({ ok: false, error: r.error, authRequired: r.authRequired });
  res.json({ ok: true, items: r.items, raw: r.raw });
});

/** Thumbnail: proxied preview bytes with long-lived browser caching. Previews
 *  for a given assetid are immutable (a new version = a new assetid), so let
 *  the browser cache them for a week and never revalidate. */
router.get("/thumb/:assetid", async (req, res) => {
  const p = requireAuthish(req, res);
  if (!p) return;
  const r = await resolveThumb(req.params.assetid, { auth: p.auth });
  if (!r.ok) {
    res.setHeader("Cache-Control", "private, max-age=300");   // don't hammer missing previews
    return res.status(r.status || 404).end();
  }
  if (r.redirect) {
    // Browser fetches the bytes straight from CloudFront (parallel, no function
    // time); the cached 302 keeps repeat views instant while the presigned URL
    // is still valid.
    res.setHeader("Cache-Control", "private, max-age=900");
    return res.redirect(302, r.redirect);
  }
  res.setHeader("Content-Type", r.contentType);
  res.setHeader("Cache-Control", "private, max-age=604800, immutable");
  res.end(r.body);
});

/** Video preview: 302 to the low-res streaming webm on the public CDN. */
router.get("/video/:assetid", async (req, res) => {
  const p = requireAuthish(req, res);
  if (!p) return;
  const r = await resolveVideo(req.params.assetid, { auth: p.auth });
  if (!r.ok) return res.status(r.status || 404).end();
  if (r.redirect) {
    res.setHeader("Cache-Control", "private, max-age=3600");
    return res.redirect(302, r.redirect);
  }
  res.setHeader("Content-Type", r.contentType || "video/webm");
  res.end(r.body);
});

/** Download passthrough. */
router.get("/download/:assetid", async (req, res) => {
  const p = requireAuthish(req, res);
  if (!p) return;
  const r = await resolveDownload(req.params.assetid, { auth: p.auth });
  if (!r.ok) return res.status(r.status || 404).json({ ok: false, error: r.error });
  if (r.redirect) return res.redirect(302, r.redirect);
  res.setHeader("Content-Type", r.contentType);
  if (r.contentDisposition) res.setHeader("Content-Disposition", r.contentDisposition);
  res.end(r.body);
});

export default router;
