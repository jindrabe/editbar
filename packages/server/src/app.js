import express from "express";
import cors from "cors";
import { rateLimit } from "express-rate-limit";
import { readOverrides, writeOverrides, verifyToken } from "@editbar/core";

const MAX_KEYS_PER_REQUEST = 200;
const MAX_VALUE_LENGTH = 20000;

export function createApp({
  editToken,
  overridesFile,
  widgetFile,
  demoDir,
  plan = "oss",
  features = { richContent: false, approvals: false },
  rateLimitOptions,
}) {
  if (!editToken) {
    throw new Error("createApp requires a non-empty editToken");
  }
  if (!overridesFile) {
    throw new Error("createApp requires overridesFile");
  }

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
    if (!verifyToken(token, editToken)) {
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

  if (demoDir) {
    app.use("/demo", express.static(demoDir));
  }

  return app;
}
