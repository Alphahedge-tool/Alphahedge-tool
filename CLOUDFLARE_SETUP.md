# Cloudflare setup for AlphaHedge

This project is ready to be hosted on **Cloudflare Pages** as a static frontend.

## What was added in the project

- `.npmrc`
  - Enables `legacy-peer-deps=true`
  - Prevents Cloudflare `npm clean-install` from failing on outdated peer dependency ranges
- `public/_headers`
  - Long cache for hashed assets in `/assets/*`
  - Short cache for HTML so new deployments update quickly
  - Basic security headers

## What Cloudflare will improve

Cloudflare will usually improve:

- CDN delivery from edge locations
- Automatic Brotli/gzip compression
- Better static asset caching
- Faster repeat visits because JS/CSS bundles stay cached

Cloudflare will **not** automatically speed up slow API responses from your backend unless that backend is also moved behind Cloudflare and configured separately.

## SPA routing note

This project is being deployed with `wrangler deploy`, not classic Pages-only `_redirects` routing.

That means:

- keep `public/_headers`
- do **not** use `public/_redirects`
- let Wrangler handle SPA fallback with `assets.not_found_handling = "single-page-application"`

If you keep a catch-all `_redirects` rule like `/* /index.html 200`, Wrangler rejects it with an infinite loop validation error.

## Step by step in your codebase

1. Install dependencies if needed:

```bash
npm install
```

2. This repo includes `.npmrc` with `legacy-peer-deps=true`.
   Cloudflare reads that automatically during dependency install.

3. Build the app:

```bash
npm run build
```

4. Confirm the build output exists in `dist/`.

## Step by step in Cloudflare

1. Sign in to Cloudflare.
2. Open `Workers & Pages`.
3. Click `Create`.
4. Choose `Pages`.
5. Choose `Connect to Git`.
6. Select this repository.
7. In build settings, use:

```text
Framework preset: Vite
Build command: npm run build
Build output directory: dist
Root directory: /
```

8. Add environment variables only if your frontend needs public runtime values.
9. Click `Save and Deploy`.

## Recommended Cloudflare dashboard settings

After the first deploy:

1. Open your Pages project.
2. Go to `Custom domains` and attach your domain if needed.
3. Go to `Settings`.
4. Make sure production branch is the branch you actually deploy from.
5. Leave compression enabled. Cloudflare normally handles this automatically.
6. If you use a custom domain, turn on `Always Use HTTPS`.

## Important limitation for this repo

Your Vite dev config proxies `/api`, `/auth`, and `/instruments-gz` to `http://localhost:3001` in local development.

That proxy works only on your machine during `npm run dev`.

For Cloudflare production, you must do one of these:

1. Point the frontend to a real hosted backend URL.
2. Move those APIs to Cloudflare Pages Functions / Workers.
3. Keep the backend on another server and allow the frontend to call it with CORS configured.

If you deploy only the frontend to Cloudflare without a real backend, API features will fail in production.

## If you want best results

Use Cloudflare Pages for the frontend and keep these rules:

- Static frontend on Cloudflare Pages
- Backend/API on a stable public host
- Environment variables for API base URLs
- Cloudflare DNS and HTTPS enabled on the domain

## Suggested next step

If you want, the next useful change is:

- add a production API base URL config so this app works correctly after Cloudflare deployment
