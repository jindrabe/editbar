import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { createApp } from "./app.js";

const TOKEN = "test-secret";

describe("editbar server", () => {
  let dir;
  let overridesFile;
  let app;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "editbar-server-test-"));
    overridesFile = path.join(dir, "overrides.json");
    app = createApp({
      editToken: TOKEN,
      overridesFile,
      rateLimitOptions: { windowMs: 60_000, limit: 1000 },
    });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("GET /overrides.json returns an empty object before any save", async () => {
    const res = await request(app).get("/overrides.json");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });

  it("GET /config reports the plan and feature flags", async () => {
    const res = await request(app).get("/config");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      plan: "oss",
      features: { richContent: false, approvals: false },
    });
  });

  it("rejects POST /overrides without a token", async () => {
    const res = await request(app)
      .post("/overrides")
      .send({ changes: { "hero.title": "hi" } });
    expect(res.status).toBe(401);
  });

  it("rejects POST /overrides with the wrong token", async () => {
    const res = await request(app)
      .post("/overrides")
      .set("Authorization", "Bearer nope")
      .send({ changes: { "hero.title": "hi" } });
    expect(res.status).toBe(401);
  });

  it("saves changes with a valid token and they show up in GET /overrides.json", async () => {
    const save = await request(app)
      .post("/overrides")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ changes: { "hero.title": "Hello world" } });
    expect(save.status).toBe(200);
    expect(save.body).toEqual({ "hero.title": "Hello world" });

    const read = await request(app).get("/overrides.json");
    expect(read.body).toEqual({ "hero.title": "Hello world" });
  });

  it("merges successive saves instead of overwriting other keys", async () => {
    await request(app)
      .post("/overrides")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ changes: { a: "1" } });
    const res = await request(app)
      .post("/overrides")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ changes: { b: "2" } });
    expect(res.body).toEqual({ a: "1", b: "2" });
  });

  it("rejects a malformed body", async () => {
    const res = await request(app)
      .post("/overrides")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ changes: "not-an-object" });
    expect(res.status).toBe(400);
  });

  it("rejects an empty changes object", async () => {
    const res = await request(app)
      .post("/overrides")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ changes: {} });
    expect(res.status).toBe(400);
  });

  it("rejects non-string values", async () => {
    const res = await request(app)
      .post("/overrides")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ changes: { "hero.title": 123 } });
    expect(res.status).toBe(400);
  });

  it("rejects a value exceeding the max length", async () => {
    const res = await request(app)
      .post("/overrides")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ changes: { "hero.title": "x".repeat(20001) } });
    expect(res.status).toBe(400);
  });

  it("rejects reserved key names that could be confused with prototype internals", async () => {
    // Sent as a raw JSON string rather than a JS object literal: a literal
    // `{ __proto__: "x" }` in source sets the object's prototype instead of
    // creating an own property, which would hide the exact bug this guards
    // against — JSON.parse (what the server actually does to req.body) does
    // create a real, iterable own property named "__proto__".
    const res = await request(app)
      .post("/overrides")
      .set("Authorization", `Bearer ${TOKEN}`)
      .set("Content-Type", "application/json")
      .send('{"changes":{"__proto__":"x","hero.title":"ok"}}');
    expect(res.status).toBe(400);
  });

  it("sets basic hardening headers on every response", async () => {
    const res = await request(app).get("/overrides.json");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["x-frame-options"]).toBe("DENY");
  });

  it("rejects too many keys in one request", async () => {
    const changes = {};
    for (let i = 0; i < 201; i++) changes[`key.${i}`] = "v";
    const res = await request(app)
      .post("/overrides")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ changes });
    expect(res.status).toBe(400);
  });

  it("rate-limits excessive save requests", async () => {
    const limitedApp = createApp({
      editToken: TOKEN,
      overridesFile,
      rateLimitOptions: { windowMs: 60_000, limit: 2 },
    });
    const attempt = () =>
      request(limitedApp)
        .post("/overrides")
        .set("Authorization", `Bearer ${TOKEN}`)
        .send({ changes: { a: "1" } });

    expect((await attempt()).status).toBe(200);
    expect((await attempt()).status).toBe(200);
    expect((await attempt()).status).toBe(429);
  });
});

describe("token provisioning", () => {
  let dir;
  let overridesFile;
  let tokenFile;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "editbar-provision-test-"));
    overridesFile = path.join(dir, "overrides.json");
    tokenFile = path.join(dir, "token.txt");
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("GET /setup 404s when the token is fixed via EDIT_TOKEN (no tokenFile)", async () => {
    const app = createApp({ editToken: TOKEN, overridesFile });
    const res = await request(app).get("/setup");
    expect(res.status).toBe(404);
  });

  it("GET /setup keeps working for loopback requests even after being viewed", async () => {
    const app = createApp({
      editToken: TOKEN,
      overridesFile,
      tokenFile,
      isLoopback: () => true,
    });
    expect((await request(app).get("/setup")).status).toBe(200);
    const second = await request(app).get("/setup");
    expect(second.status).toBe(200);
    expect(second.text).toContain(TOKEN);
  });

  it("GET /setup is one-time for non-loopback requests", async () => {
    const app = createApp({
      editToken: TOKEN,
      overridesFile,
      tokenFile,
      isLoopback: () => false,
    });
    const first = await request(app).get("/setup");
    expect(first.status).toBe(200);
    expect(first.text).toContain(TOKEN);

    const second = await request(app).get("/setup");
    expect(second.status).toBe(410);
  });

  it("GET /setup expires for non-loopback requests after the TTL", async () => {
    const app = createApp({
      editToken: TOKEN,
      overridesFile,
      tokenFile,
      isLoopback: () => false,
      serverStartedAt: Date.now() - 60 * 60 * 1000, // 1 hour ago
    });
    const res = await request(app).get("/setup");
    expect(res.status).toBe(410);
  });

  it("GET /setup stays one-time for non-loopback requests across a server restart", async () => {
    const first = createApp({
      editToken: TOKEN,
      overridesFile,
      tokenFile,
      isLoopback: () => false,
    });
    const res1 = await request(first).get("/setup");
    expect(res1.status).toBe(200);

    // A fresh createApp() call with a fresh in-memory setupRevealed would
    // reopen the window — this simulates a process restart (crash, deploy)
    // sharing the same tokenFile on disk.
    const second = createApp({
      editToken: TOKEN,
      overridesFile,
      tokenFile,
      isLoopback: () => false,
    });
    const res2 = await request(second).get("/setup");
    expect(res2.status).toBe(410);
  });

  it("default isLoopback trusts X-Forwarded-For only when trustProxy is configured", async () => {
    const app = createApp({
      editToken: TOKEN,
      overridesFile,
      tokenFile,
      trustProxy: true,
    });
    // Real client IP forwarded by a trusted proxy hop — must NOT be treated
    // as loopback just because the proxy's own socket connection is local.
    const res = await request(app)
      .get("/setup")
      .set("X-Forwarded-For", "203.0.113.5");
    expect(res.status).toBe(200); // first-ever call, still within TTL
    const second = await request(app)
      .get("/setup")
      .set("X-Forwarded-For", "203.0.113.5");
    expect(second.status).toBe(410); // one-time reveal for this non-loopback caller
  });

  it("POST /token/rotate requires a valid token", async () => {
    const app = createApp({ editToken: TOKEN, overridesFile, tokenFile });
    const res = await request(app).post("/token/rotate");
    expect(res.status).toBe(401);
  });

  it("POST /token/rotate rejects when the token is fixed via EDIT_TOKEN", async () => {
    const app = createApp({ editToken: TOKEN, overridesFile });
    const res = await request(app)
      .post("/token/rotate")
      .set("Authorization", `Bearer ${TOKEN}`);
    expect(res.status).toBe(400);
  });

  it("POST /token/rotate issues a new token, persists it, and invalidates the old one", async () => {
    const app = createApp({ editToken: TOKEN, overridesFile, tokenFile });

    const rotate = await request(app)
      .post("/token/rotate")
      .set("Authorization", `Bearer ${TOKEN}`);
    expect(rotate.status).toBe(200);
    const newToken = rotate.body.token;
    expect(newToken).toBeTruthy();
    expect(newToken).not.toBe(TOKEN);

    const withOldToken = await request(app)
      .post("/overrides")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ changes: { a: "1" } });
    expect(withOldToken.status).toBe(401);

    const withNewToken = await request(app)
      .post("/overrides")
      .set("Authorization", `Bearer ${newToken}`)
      .send({ changes: { a: "1" } });
    expect(withNewToken.status).toBe(200);

    const persisted = await fs.readFile(tokenFile, "utf8");
    expect(persisted.trim()).toBe(newToken);
  });
});
