# Contributing

Thanks for considering a contribution to Editbar.

## Local setup

```bash
npm install
npm run dev            # starts the reference server on :4000
```

Open `http://localhost:4000/setup` for your admin token and the exact link to
try the vanilla HTML demo as an admin — the server generates a fresh random
token per install (see `docs/ARCHITECTURE.md`), so there's no fixed one to
hardcode.

To run a framework example alongside it:

```bash
npm run dev:react      # Vite dev server on :5173
npm run dev:vue        # Vite dev server on :5174
npm run dev:astro      # Astro dev server on :4321
```

Run the test suite (Vitest unit tests for `packages/core`, Supertest
integration tests for `packages/server`) with:

```bash
npm test
```

## Project layout

- `packages/core` — shared storage + auth helpers used by the server.
- `packages/widget` — the widget itself (`src/widget.js`). No build step; edit
  the file directly and reload the page.
- `packages/server` — reference backend implementing the two-endpoint
  contract (`GET /overrides.json`, `POST /overrides`) described in
  [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
- `examples/*` — minimal demo pages proving the widget needs no
  framework-specific integration.

## Adding a framework example

The whole point of the widget is that it doesn't need one, but an example
proving it works well in a given framework/CMS is welcome. To add one:

1. Copy the shape of `examples/vanilla-html` or `examples/react-app`.
2. Include the widget via `<script src=".../widget.js" data-api="...">`.
3. Mark a few pieces of text with `data-edit-id="some.key"`.
4. Add a short note to the example's own README on how to run it.

## Reporting issues / proposing changes

Open a GitHub issue with a clear repro (which example, browser, and what you
expected vs. saw). For anything beyond a small fix, please open an issue to
discuss the approach before sending a large pull request.

## Code style

Plain, dependency-free JS in `packages/widget` — please keep it that way; it's
the thing every host page downloads, so new dependencies there have a real
cost. The server and core packages are regular Node/ESM and can use
dependencies where they genuinely help.
