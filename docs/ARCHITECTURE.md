# Architecture

## Flow

```
                     ┌──────────────────────┐
  1. page loads ───► │   widget.js (browser) │
                     └──────────┬────────────┘
                                │  GET /overrides.json (public)
                                ▼
                     ┌──────────────────────┐
                     │  reference server     │
                     │  (Node/Express)       │
                     └──────────┬────────────┘
                                │  reads
                                ▼
                     ┌──────────────────────┐
                     │  overrides.json       │  ◄── flat file, git-friendly
                     └──────────────────────┘

  2. admin opens page with ?edit_token=...
     token stored in localStorage → bar renders

  3. admin edits text in place
     draft cached in localStorage only (nothing sent yet)

  4. admin clicks "Save changes"
                                │  POST /overrides
                                │  Authorization: Bearer <token>
                                ▼
                     ┌──────────────────────┐
                     │  reference server     │  verifies token,
                     │                        │  merges + writes file
                     └──────────┬────────────┘
                                ▼
                     ┌──────────────────────┐
                     │  overrides.json       │  ◄── now the source of truth
                     └──────────────────────┘

  5. any other visitor's page load fetches the updated
     overrides.json → sees the new text, no server-restart needed
```

## Components

- **`packages/core`** — framework-agnostic helpers shared by the server: reading/writing `overrides.json` (atomic write via temp file + rename) and verifying the admin token (constant-time comparison over hashed values, so a mistyped token can't be brute-forced via timing and never throws on length mismatch).
- **`packages/widget`** — the single script every host page includes. No build step, no dependencies, no framework awareness. It:
  - reads `data-edit-id` attributes already present in the page's HTML/JSX/template output — this is the only integration point, and it's just a plain HTML attribute, so it survives being rendered by any framework;
  - fetches published overrides and patches matching elements' `textContent` (never `innerHTML`, to avoid turning saved text into an XSS vector);
  - renders the floating bar in a Shadow DOM, so its styling can't leak into (or be broken by) the host page's CSS;
  - keeps unsaved edits in `localStorage` until explicitly saved or discarded.
- **`packages/server`** — a minimal reference backend. `GET /overrides.json` is public (the whole point is that visitors see the live text). `POST /overrides` requires the bearer token and is the only privileged action. Any backend that implements this same two-endpoint contract can replace it (e.g. a database-backed or multi-tenant version for a hosted product).

## Security model

- The bar's visibility in the UI is **cosmetic only** — it's gated by a token in `localStorage`, which any visitor could technically set. The actual protection is that `POST /overrides` independently verifies the token server-side; a hidden or spoofed bar can never write without the real token.
- Saved text is inserted via `textContent`, never `innerHTML` — an admin (or anyone who guessed/leaked a token) can only ever change what visitors *read*, not inject markup or scripts.
- CORS on the reference server is intentionally permissive, since the whole point is that the widget can be embedded on any origin; the bearer token (not a cookie) is what's actually gating writes, so a wildcard `Access-Control-Allow-Origin` doesn't weaken that.
- **The admin token lives in `localStorage` on your own site, with no expiry and no origin/path scoping.** This is an inherent tradeoff of the shared-secret model, not a bug: if your site has an *unrelated* XSS vulnerability of its own, that XSS can read `localStorage.getItem('editbar_token')` and gain full write access to your published text — the same way it could read any other secret you kept in `localStorage`. Editbar doesn't introduce this risk, but it doesn't shield you from it either. Keep your own site free of XSS, treat the admin link (and the "Copy admin link" feature) like a password — don't paste it into chat or a public issue — and rotate the token (Settings panel → Rotate) if you suspect it leaked.

## Token provisioning

If `EDIT_TOKEN` isn't set, the server generates a strong random token itself
on first boot (`crypto.randomBytes(24)`, base64url), persists it to
`TOKEN_FILE` with `0600` permissions, and reuses it on every restart. This
replaced an earlier design where the server either fell back to an insecure
hardcoded `dev-token` in development or refused to start at all in
production — auto-provisioning gives every install a real secret without
either failure mode.

`GET /setup` is a convenience page mirroring that same token so a first-time
admin doesn't have to read server logs. It's deliberately restricted:
- Requests from loopback (the machine running the server) can always reach
  it — there's no useful attacker model for "I already have a shell on this
  box."
- Remote requests get it once (or within 15 minutes of server start,
  whichever comes first); after that it 410s. This bounds the window in
  which an automated scanner that stumbles onto a freshly deployed,
  publicly reachable server before its owner does could otherwise capture
  the admin token over HTTP. The token remains available afterwards from
  server logs, or from the widget's Settings panel once an admin has
  activated it at least once.

`POST /token/rotate` requires the *current* valid token and returns a new
one, immediately invalidating every other copy of the admin link. It's a
no-op error (400) when `EDIT_TOKEN` was set explicitly via the environment,
since the running process can't durably change what the next restart will
read back from the environment.

## Why not patch at build/SSR time?

An earlier version of this design considered resolving overrides at render time (so text would be visible to non-JS crawlers immediately). That requires every framework to adopt a small helper function, which breaks the "paste one script tag into any site" promise this project is built around. Google's crawler does execute JavaScript, so the practical SEO impact of the current client-side-only approach is limited to non-JS scrapers and link-preview bots. A guaranteed-SEO-visible mode is a reasonable **paid/hosted** add-on for teams that need it, not a requirement for the open-source core — see the roadmap in the [README](../README.md).
