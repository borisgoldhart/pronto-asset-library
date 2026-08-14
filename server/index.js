import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { authMode } from "./session.js";
import { attachUser } from "./users.js";
import authRoutes from "./routes/auth.js";
import mineRoutes from "./routes/mine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "..", "public");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.use("/api", attachUser);           // per-user session -> req.pronto
app.use("/api/auth", authRoutes);
app.use("/api/mine", mineRoutes);

app.get("/api/health", (_req, res) => res.json({ ok: true, authMode: authMode() }));

// Return page for the broker sign-in popup (see the Reporting Dashboard).
app.get("/auth/callback", (_req, res) => {
  res.type("html").send(`<!doctype html><meta charset="utf-8"><title>Signed in</title>
<body style="font:15px/1.5 Lato,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:96vh;color:#18181a">
<div style="text-align:center"><h2 style="margin:0 0 6px">Signed in ✓</h2>
<p style="color:#666">You can close this tab and return to the Asset Library.</p></div>
<script>setTimeout(function(){ window.close(); }, 800);</script></body>`);
});

// Shared "pronto-base" package (nav + page template) at /base.
const siblingBase = path.resolve(__dirname, "..", "..", "pronto-base");
const vendoredBase = path.resolve(__dirname, "..", "pronto-base");
const baseDir = fs.existsSync(vendoredBase) ? vendoredBase : siblingBase;
app.use("/base", express.static(baseDir, {
  etag: true,
  setHeaders: (res) => res.setHeader("Cache-Control", "no-cache"),
}));

app.use(express.static(publicDir, {
  etag: true,
  setHeaders: (res) => res.setHeader("Cache-Control", "no-cache"),
}));

export default app;

if (!process.env.VERCEL) {
  app.listen(config.port, () => {
    console.log(`\n  Pronto Asset Library server`);
    console.log(`  ---------------------------------------`);
    console.log(`  Local:      http://localhost:${config.port}`);
    console.log(`  API base:   ${config.prontoBaseUrl}`);
    console.log(`  Auth mode:  ${authMode()}${authMode() === "none" ? "  (multi-user login mode)" : ""}\n`);
  });
}
