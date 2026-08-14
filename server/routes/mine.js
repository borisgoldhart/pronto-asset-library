import { Router } from "express";
import { searchAssets, lookup, listCollections, popularTags, resolveThumb, resolveDownload, DAM_ID } from "../mine.js";

const router = Router();

function requireAuthish(req, res) {
  const p = req.pronto || { mode: "none" };
  if (p.mode === "none") {
    res.status(401).json({ ok: false, authRequired: true, error: "Not signed in" });
    return null;
  }
  return p;
}

/** Main search. All filter params ride the querystring (whitelisted server-side). */
router.get("/search", async (req, res) => {
  const p = requireAuthish(req, res);
  if (!p) return;
  const r = await searchAssets(req.query, { auth: p.auth });
  if (!r.ok) return res.status(r.status || 502).json({ ok: false, error: r.error, authRequired: r.authRequired });
  res.json({ ok: true, count: r.count, assets: r.assets, meta: r.meta, damId: DAM_ID });
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

/** Thumbnail: 302 to the presigned S3 URL when Pronto redirects, else stream. */
router.get("/thumb/:assetid", async (req, res) => {
  const p = requireAuthish(req, res);
  if (!p) return;
  const r = await resolveThumb(req.params.assetid, { auth: p.auth });
  if (!r.ok) return res.status(r.status || 404).end();
  if (r.redirect) return res.redirect(302, r.redirect);
  res.setHeader("Content-Type", r.contentType);
  res.setHeader("Cache-Control", "private, max-age=3600");
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
