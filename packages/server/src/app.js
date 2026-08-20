import express from "express";
import cors from "cors";
import { rateLimit } from "express-rate-limit";
import {
  readOverrides,
  writeOverrides,
  verifyToken,
  generateToken,
  writeToken,
} from "@editbar/core";

const MAX_KEYS_PER_REQUEST = 200;
const MAX_VALUE_LENGTH = 20000;
const SETUP_TTL_MS = 15 * 60 * 1000;

function defaultIsLoopback(req) {
  const addr = req.socket && req.socket.remoteAddress;
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function renderSetupPage(token, origin) {
  const embed = `<script src="${origin}/widget.js" data-api="${origin}" defer></script>`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Editbar setup</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif;
         max-width: 560px; margin: 10vh auto; padding: 0 24px; line-height: 1.5; color: #1c1c1e; }
  code, .box { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .box { display: block; background: rgba(0,0,0,0.05); border-radius: 10px; padding: 14px 16px;
         font-size: 14px; word-break: break-all; margin: 8px 0 20px; }
  button { appearance: none; border: none; background: #0a84ff; color: #fff; font: inherit;
           font-weight: 600; padding: 8px 16px; border-radius: 10px; cursor: pointer; }
  .warn { color: #ff9f0a; font-size: 14px; }
</style></head>
<body>
  <h1>Editbar setup</h1>
  <p>Your admin token (also printed in the server's console output):</p>
  <code class="box" id="token">${token}</code>
  <button onclick="navigator.clipboard.writeText(document.getElementById('token').textContent)">Copy token</button>
  <p>Embed snippet for any page you want editable:</p>
  <code class="box">${embed.replace(/</g, "&lt;")}</code>
  <p>Then open that page once with <code>?edit_token=${token}</code> appended to
  the URL — the admin bar remembers it after that.</p>
  <p class="warn">This page won't be shown again to remote visitors after you
  leave (or after 15 minutes). The token stays available afterwards from the
  Settings panel in the bar once you've activated it, or in this server's
  console output.</p>
</body></html>`;
}

export function createApp({
  editToken,
  overridesFile,
  widgetFile,
  demoDir,
  plan = "oss",
  features = { richContent: false, approvals: false },
  rateLimitOptions,
  tokenFile = null,
  serverStartedAt = Date.now(),
  isLoopback = defaultIsLoopback,
}) {
  if (!editToken) {
    throw new Error("createApp requires a non-empty editToken");
  }
  if (!overridesFile) {
    throw new Error("createApp requires overridesFile");
  }

  let currentToken = editToken;
  let setupRevealed = false;

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "100kb" }));

  const saveLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    ...rateLimitOptions,
  });

  if (widgetFile) {
    app.get("/widget.js", (req, res) => {
      res.type("application/javascript");
      res.sendFile(widgetFile);
    });
  }

  app.get("/config", (req, res) => {
    res.json({ plan, features });
  });

  app.get("/overrides.json", async (req, res) => {
    const data = await readOverrides(overridesFile);
    res.json(data);
  });

  app.post("/overrides", saveLimiter, async (req, res) => {
    const auth = req.get("authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!verifyToken(token, currentToken)) {
      return res.status(401).json({ error: "invalid or missing token" });
    }
    const changes = req.body && req.body.changes;
    if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
      return res.status(400).json({ error: "expected { changes: object }" });
    }
    const keys = Object.keys(changes);
    if (keys.length === 0) {
      return res.status(400).json({ error: "changes must not be empty" });
    }
    if (keys.length > MAX_KEYS_PER_REQUEST) {
      return res.status(400).json({
        error: `too many keys in one request (max ${MAX_KEYS_PER_REQUEST})`,
      });
    }
    for (const key of keys) {
      const value = changes[key];
      if (typeof value !== "string") {
        return res.status(400).json({ error: `value for "${key}" must be a string` });
      }
      if (value.length > MAX_VALUE_LENGTH) {
        return res.status(400).json({
          error: `value for "${key}" exceeds max length of ${MAX_VALUE_LENGTH}`,
        });
      }
    }
    const current = await readOverrides(overridesFile);
    const next = { ...current, ...changes };
    await writeOverrides(overridesFile, next);
    res.json(next);
  });

  app.get("/setup", (req, res) => {
    if (!tokenFile) {
      return res
        .status(404)
        .type("text/plain")
        .send(
          "Token is configured via the EDIT_TOKEN environment variable — there's nothing to provision here."
        );
    }
    const loopback = isLoopback(req);
    const withinTtl = Date.now() - serverStartedAt < SETUP_TTL_MS;
    if (!loopback && (setupRevealed || !withinTtl)) {
      return res
        .status(410)
        .type("text/plain")
        .send(
          "Setup already completed or expired. Check the server's console output for the admin token, or use the Settings panel in the bar once you're signed in."
        );
    }
    if (!loopback) setupRevealed = true;
    const origin = `${req.protocol}://${req.get("host")}`;
    res.type("text/html").send(renderSetupPage(currentToken, origin));
  });

  app.post("/token/rotate", saveLimiter, async (req, res) => {
    const auth = req.get("authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!verifyToken(token, currentToken)) {
      return res.status(401).json({ error: "invalid or missing token" });
    }
    if (!tokenFile) {
      return res.status(400).json({
        error:
          "token is fixed via the EDIT_TOKEN environment variable — change it there and restart instead",
      });
    }
    const next = generateToken();
    currentToken = next;
    await writeToken(tokenFile, next);
    res.json({ token: next });
  });

  if (demoDir) {
    app.use("/demo", express.static(demoDir));
  }

  return app;
}
