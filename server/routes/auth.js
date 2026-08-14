import { Router } from "express";
import { config } from "../config.js";
import { authMode } from "../session.js";
import { loginUser, getSession, destroySession, sidCookie, envBypassCookie, brokerStart, brokerPoll } from "../users.js";
import { searchAssets } from "../mine.js";

const router = Router();

/** Who am I / how is auth set up (see the Reporting Dashboard for the contract). */
router.get("/status", (req, res) => {
  const p = req.pronto || { mode: "none", identity: null, key: "anon" };
  res.json({
    baseUrl: config.prontoBaseUrl,
    mode: p.mode,
    envMode: authMode(),
    authRequired: p.mode === "none",
    identity: p.identity,
    userKey: p.key,
    tokenGeneratorUrl: config.tokenGeneratorUrl || null,
    broker: !config.brokerDisabled,
  });
});

/** PKCE broker: start a "Sign in with HavasPronto" attempt. */
router.post("/broker/start", async (req, res) => {
  if (config.brokerDisabled) return res.status(404).json({ ok: false, error: "Broker sign-in is disabled" });
  const returnUrl = `${req.protocol}://${req.get("host")}/auth/callback`;
  const r = await brokerStart(returnUrl);
  if (!r.ok) return res.status(r.status || 502).json({ ok: false, error: r.error });
  res.json({ ok: true, pid: r.pid, loginUrl: r.loginUrl, pollMs: 3000 });
});

/** Poll the broker attempt until the user finishes logging in on the site. */
router.post("/broker/poll", async (req, res) => {
  const r = await brokerPoll((req.body || {}).pid);
  if (r.ok && r.pending) return res.json({ ok: true, pending: true, retryAfter: r.retryAfter });
  if (r.ok && r.sid) {
    res.setHeader("Set-Cookie", [sidCookie(r.sid), envBypassCookie(false)]);
    return res.json({ ok: true, identity: r.identity });
  }
  res.status(r.status || 400).json({ ok: false, error: r.error });
});

/** Per-user login: { email, password } OR { token }. */
router.post("/login", async (req, res) => {
  const { token, email, password } = req.body || {};
  const r = await loginUser({ token, email, password });
  if (!r.ok) return res.status(r.status || 401).json({ ok: false, error: r.error });
  res.setHeader("Set-Cookie", [sidCookie(r.sid), envBypassCookie(false)]);
  res.json({ ok: true, identity: r.identity });
});

router.post("/logout", async (req, res) => {
  const s = await getSession(req);
  if (s) await destroySession(s.sid);
  res.setHeader("Set-Cookie", [sidCookie("", { destroy: true }), envBypassCookie(true)]);
  res.json({ ok: true });
});

/** Live check: one tiny Mine search proves the credentials work end-to-end. */
router.get("/verify", async (req, res) => {
  const p = req.pronto || { mode: "none" };
  if (p.mode === "none") {
    return res.status(401).json({ ok: false, authRequired: true, error: "Not signed in" });
  }
  const t0 = Date.now();
  const r = await searchAssets({ rows: 1, pos: 0, status: "all" }, { auth: p.auth });
  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  if (!r.ok) {
    return res.status(r.status || 502).json({ ok: false, mode: p.mode, user: p.identity, seconds, error: r.error, authRequired: r.authRequired });
  }
  res.json({ ok: true, mode: p.mode, user: p.identity, authUsed: r.authUsed, seconds, totalAssets: r.count });
});

export default router;
