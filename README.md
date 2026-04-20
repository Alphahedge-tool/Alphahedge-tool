# AlphaHedge

Vite + React frontend for the AlphaHedge options dashboard.

## Local development

```bash
npm install
npm run dev
```

The app runs on `http://localhost:8888`.

## Production build

```bash
npm run build
```

Build output is written to `dist/`.

## Cloudflare Pages

This repo now includes Cloudflare Pages support:

- `public/_headers` sets cache and basic security headers.
- `public/_redirects` adds SPA fallback routing.

Step-by-step setup is in [CLOUDFLARE_SETUP.md](/abs/path/c:/Users/optio/Alpahedgesoftware/CLOUDFLARE_SETUP.md).
