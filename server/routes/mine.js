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

/** Finance/job documents (quotes, POs, invoices) share the index with creative
 *  assets and the SOLR bridge has NO exclusion support (verified live: negative
 *  q terms get phrase-wrapped, fq is ignored) — so we hide them per page here.
 *  Override the pattern with env FINANCE_TITLE_PATTERN. */
const FINANCE_TITLE = new RegExp(process.env.FINANCE_TITLE_PATTERN || "^(QT_|PO_|IN_|OD_|CN_)\\d+", "i");
const FINANCE_AUTHOR = /agresso download service/i;
const isFinanceDoc = (a) => FINANCE_TITLE.test(a.title || "") || FINANCE_AUTHOR.test(a.author || "");

/** Main search. All filter params ride the querystring (whitelisted server-side). */
router.get("/search", async (req, res) => {
  const p = requireAuthish(req, res);
  if (!p) return;
  const r = await searchAssets(req.query, { auth: p.auth });
  if (!r.ok) return res.status(r.status || 502).json({ ok: false, error: r.error, authRequired: r.authRequired });
  let assets = r.assets, hiddenFinance = 0;
  if (String(req.query.hidefinance) === "1") {
    assets = r.assets.filter((a) => !isFinanceDoc(a));
    hiddenFinance = r.assets.length - assets.length;
  }
  res.json({ ok: true, count: r.count, assets, hiddenFinance, meta: r.meta, damId: DAM_ID });
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
