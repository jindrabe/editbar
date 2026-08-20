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
