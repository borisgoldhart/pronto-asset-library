# Pronto Asset Library

A fast, standalone rebuild of the Pronto Mine (DAM) asset library. Replaces the
legacy `havaspronto.com/v2/search/mine` UI with a modern SPA: faceted filters in
a left sidebar, thumbnail grid, numbered pagination — powered by the same
SOLR-backed `/v2/search/dam` endpoint.

Same architecture and auth as the **Pronto Reporting Dashboard**
(`pronto-dashboard-reports`): Node/Express backend proxy (holds credentials,
solves CORS) + static SPA, shared `pronto-base` nav package, per-user sessions
with "Sign in with HavasPronto" (PKCE broker), email+password, or a pasted API
token. Sessions persist in Redis (Upstash) on Vercel, filesystem locally.

## Run locally

```bash
npm install
cp .env.example .env    # optionally set PRONTO_EMAIL/PASSWORD for auto-login
npm start               # http://localhost:8788
```

## Deploy (Vercel)

Same as the Dashboard: import the repo, add Upstash Redis from the Marketplace
(Storage tab), set `PRONTO_BASE_URL`. Leave user credentials unset for
multi-user mode.

## API surface (backend)

| Route | Purpose |
|-------|---------|
| `GET /api/mine/search` | proxied SOLR search (whitelisted params) |
| `GET /api/mine/lookup/:kind` | SAYT lookups: brands, project-types, offices, audiences, asset-types |
| `GET /api/mine/collections` | user's collections |
| `GET /api/mine/tags/popular` | popular tags |
| `GET /api/mine/thumb/:assetid` | preview image (302 to presigned S3) |
| `GET /api/mine/download/:assetid` | download passthrough |
| `GET/POST /api/auth/*` | status, login, logout, PKCE broker (same as Dashboard) |

The confirmed legacy filter→param mapping lives in `server/mine.js` (header
comment) and in the project doc `asset-library-discovery.md`.
