import { Router } from "express";
import { searchAssets, facetCounts, lookup, listCollections, popularTags, resolveThumb, resolveVideo, resolveDownload, DAM_ID } from "../mine.js";

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
