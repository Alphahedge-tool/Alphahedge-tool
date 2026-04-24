# Cloudflare Pages Setup

This repo is now prepared for a frontend deployment on Cloudflare Pages.

What was added:
- `wrangler.toml` so Cloudflare knows the build output is `dist`
- Pages Functions proxies for `/api/*`, `/auth/*`, and `/instruments-gz`
- `.dev.vars.example` to show the required Cloudflare env var
- backend support for `APP_ORIGIN` so Google OAuth redirects can go back to your deployed frontend

## What you need to do in Cloudflare

1. Log in to Cloudflare.
2. Open `Workers & Pages`.
3. Click `Create` -> `Pages` -> `Connect to Git`.
4. Select this GitHub repo.
5. Use these build settings:
   - Framework preset: `Vite`
   - Build command: `npm run build`
   - Build output directory: `dist`
6. In `Environment variables`, add:
   - `BACKEND_ORIGIN`
   - Value example: `https://api.yourdomain.com`
7. Deploy the project.

## What you need on the backend

Your Fastify backend must stay running somewhere public over HTTPS.

Set this backend env var:
- `APP_ORIGIN=https://your-pages-domain.pages.dev`

If you use a custom frontend domain later, update it to:
- `APP_ORIGIN=https://yourdomain.com`

For Google OAuth, also set:
- `GOOGLE_REDIRECT_URI=https://your-pages-domain.pages.dev/auth/google/callback`

If you use a custom domain:
- `GOOGLE_REDIRECT_URI=https://yourdomain.com/auth/google/callback`

Also update the same redirect URI in your Google OAuth app settings.

## What this setup does

- The frontend is served from Cloudflare Pages.
- Requests to `/api/*`, `/auth/*`, and `/instruments-gz` are forwarded by Cloudflare Pages Functions to your backend origin.
- Your existing frontend fetch calls can stay mostly unchanged.

## Important note

This does **not** move your Fastify backend into Cloudflare.
It only puts the frontend on Cloudflare and proxies backend requests through Pages.

## Good first deployment flow

1. Deploy backend on a VPS / Render / Railway / your server with HTTPS
2. Confirm backend works directly
3. Deploy frontend on Cloudflare Pages
4. Set `BACKEND_ORIGIN` in Cloudflare
5. Set `APP_ORIGIN` and `GOOGLE_REDIRECT_URI` on the backend
6. Test login, instruments, option chain, and payoff calls
