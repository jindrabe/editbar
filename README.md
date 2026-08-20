# Editbar

**A floating admin bar that lets you edit any text on your website in place — no CMS migration, no code changes, works on any frontend stack.**

[![CI](https://github.com/editbar/editbar/actions/workflows/ci.yml/badge.svg)](https://github.com/editbar/editbar/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933.svg)](package.json)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

Self-hosted, open-source alternative to Weglot's in-context editor or a
Storyblok visual editor — for the much narrower job of "let someone fix text
on an existing site." Works as an **inline text editor for React, Vue,
Astro, WordPress, or plain HTML**, with no CMS migration.

Drop one `<script>` tag into any customer-facing site — a marketing page, a
client site, an internal tool — and give whoever owns the content a way to
fix a typo, update a CTA, or tweak copy themselves, without opening a pull
request or waiting on a developer.

```html
<span data-edit-id="hero.title">Welcome to Acme Studio</span>
...
<script src="https://your-editbar-server.example.com/widget.js" defer></script>
```

That's the entire integration. `data-edit-id` is a plain HTML attribute, so
it survives being rendered by React, Vue, Svelte, Astro, a static site
generator, a CMS template, or hand-written HTML — the widget doesn't care.

## How it looks

A small, unobtrusive bar sits bottom-left, visible only to signed-in admins:

```
┌─────────────────────────────────────────────┐
│ ●  Edit     Save changes     Discard     ✕   │
└─────────────────────────────────────────────┘
```

- **Edit** — click any highlighted text on the page and rewrite it in place.
- Changes are cached locally until you explicitly **Save changes** — nothing
  is public until you say so.
- **Discard** reverts to the last published version.
- Regular visitors never see the bar and never touch anything but the
  published text.

## Quick start

```bash
git clone <this repo>
cd editbar
npm install
EDIT_TOKEN=choose-a-real-secret npm run dev
```

This starts the reference server on `http://localhost:4000`, serving:

- `GET /widget.js` — the widget script
- `GET /overrides.json` — the current published text (public)
- `GET /config` — plan/feature flags the widget can branch on (`{ plan, features }`)
- `POST /overrides` — save changes (requires `Authorization: Bearer <token>`, rate-limited, capped payload size)
- `GET /demo` — a working vanilla HTML example

Outside local development, the server refuses to start unless `EDIT_TOKEN`
is set (`NODE_ENV=production node packages/server/src/index.js` without a
token exits immediately rather than falling back to an insecure default).

Open `http://localhost:4000/demo?edit_token=choose-a-real-secret` to try it
as an admin. Opening `/demo` without the token shows the page exactly as any
visitor sees it — no bar.

The same widget, dropped in unmodified, also runs in:

- `examples/react-app` — `npm run dev:react`
- `examples/vue-app` — `npm run dev:vue`
- `examples/astro-app` — `npm run dev:astro`

Each proves the same point: `data-edit-id` is a plain HTML attribute, so it
survives whatever compiles or server-renders the page.

Run `npm test` to run the unit and integration test suite (Vitest +
Supertest) covering `packages/core` and `packages/server`.

### Using it with WordPress or another CMS-rendered site

There's no plugin (yet) — paste the same two lines used everywhere else into
your theme's footer template (e.g. `footer.php`, or the theme's "custom
scripts" field if your theme/builder exposes one), and add `data-edit-id` to
whichever template tags render the text you want editable:

```html
<h1 data-edit-id="hero.title"><?php the_title(); ?></h1>
...
<script src="https://your-editbar-server.example.com/widget.js"
        data-api="https://your-editbar-server.example.com" defer></script>
```

## How it works

1. On load, the widget fetches `/overrides.json` and patches any
   `data-edit-id` element whose key has a published override.
2. If a valid admin token is found (from `?edit_token=...`, cached
   thereafter in `localStorage`), the floating bar renders.
3. Edits are cached in `localStorage` as drafts — nothing is sent to the
   server until **Save changes**.
4. Saving `POST`s the draft to `/overrides` with the bearer token; the
   server verifies it, merges the change into `overrides.json`, and from
   that point every visitor's page load reflects the new text.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full request flow
and the security model (why the bar's visibility is cosmetic, not the actual
access control).

## Configuration

The reference server (`packages/server`) reads these environment variables:

| Variable         | Default                          | Description                                   |
| ---------------- | --------------------------------- | ---------------------------------------------- |
| `PORT`            | `4000`                            | Port the server listens on                     |
| `EDIT_TOKEN`      | `dev-token` (insecure, dev only)  | Shared secret required to save changes         |
| `OVERRIDES_FILE`  | `packages/server/data/overrides.json` | Where published text is stored              |

## Self-hosting

The server is a plain Node/Express app with no external services required —
`overrides.json` is a flat file, so it's easy to back up, diff, or commit to
git alongside your site. Run it anywhere that can run Node (a small VM, a
container, a serverless function with persistent storage). Point the
widget's `data-api` attribute at wherever you deploy it:

```html
<script src="https://your-editbar-server.example.com/widget.js"
        data-api="https://your-editbar-server.example.com"
        defer></script>
```

## Why not just use \<CMS\>?

Tools like Storyblok, Builder.io, or Weglot solve a related but bigger
problem — they usually want you to build your site on top of them, or add a
per-framework SDK. Editbar is intentionally narrower: if all you need is
"let a non-technical person fix text on an existing site," it's a five-minute
integration instead of a CMS migration.

|                          | Editbar (OSS)      | Typical headless CMS |
| ------------------------ | ------------------- | --------------------- |
| Integration               | one `<script>` tag | SDK per framework      |
| Works on existing sites   | yes                 | usually requires rebuilding templates |
| Content scope             | text only (v1)      | full content modeling |
| Self-hostable for free    | yes                 | rarely                |

## FAQ

**Is this SEO-safe?** Overrides are patched in on the client after load, so
Google (which renders JavaScript) sees the edited text, but non-JS scrapers
and link-preview bots see the original. A guaranteed-SEO-visible mode
(server-render time resolution) is planned as a paid add-on for teams that
need it — see Roadmap.

**Does it work with WordPress / Webflow / Squarespace / a static site
generator?** Yes — anywhere you can add a `<script>` tag and a `data-edit-id`
attribute to your markup. See "Using it with WordPress" above; the same
pattern applies to any template language.

**Can visitors see or use the edit bar?** No — it only renders when a valid
admin token is present, and every write is independently verified
server-side regardless of what the UI shows. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full security model.

**What can't the free version do?** Rich content (images/links), multiple
admins/roles, version history, and an SEO-guaranteed render mode — all
planned as part of the hosted product, not artificially removed from the OSS
core. See Roadmap below.

## Roadmap

The open-source core stays focused on drop-in text editing, freely
self-hostable, MIT-licensed, with no artificially crippled features. A
hosted version is planned on top of the same core, in increasing tiers, for
teams that want to skip running their own backend:

- **Starter** — managed backend/storage, real per-account login instead of a
  single shared token; otherwise the same feature scope as the OSS core.
- **Pro** — draft → publish review flow with version history and rollback;
  rich content types (image swap, link editing) beyond plain text;
  SEO-guaranteed rendering (SSR/build-time resolution) as an opt-in adapter
  per framework, for teams that need overrides visible to non-JS crawlers.
- **Agency** — a multi-site dashboard for managing several client sites from
  one account, with team members and roles.
- **Enterprise** — **approval workflows** (an editor submits a batch of
  changes, an approver reviews the diff and approves or rejects it,
  mirroring a pull-request review), SSO, and audit log export.

None of this is required to use the free, self-hosted core.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

MIT — see [`LICENSE`](LICENSE).
