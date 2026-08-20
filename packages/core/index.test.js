import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readOverrides,
  writeOverrides,
  verifyToken,
  generateToken,
  readToken,
  writeToken,
} from "./index.js";

describe("readOverrides / writeOverrides", () => {
  let dir;
  let file;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "editbar-core-test-"));
    file = path.join(dir, "nested", "overrides.json");
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns an empty object when the file does not exist", async () => {
    expect(await readOverrides(file)).toEqual({});
  });

  it("round-trips data through write then read", async () => {
    await writeOverrides(file, { "hero.title": "Hello" });
    expect(await readOverrides(file)).toEqual({ "hero.title": "Hello" });
  });

  it("creates missing parent directories", async () => {
    await writeOverrides(file, { a: "b" });
    const stat = await fs.stat(path.dirname(file));
    expect(stat.isDirectory()).toBe(true);
  });

  it("overwrites previous contents rather than merging", async () => {
    await writeOverrides(file, { a: "1" });
    await writeOverrides(file, { b: "2" });
    expect(await readOverrides(file)).toEqual({ b: "2" });
  });

  it("propagates non-ENOENT read errors", async () => {
    // Pointing at a directory instead of a file triggers EISDIR, not ENOENT.
    await fs.mkdir(file, { recursive: true });
    await expect(readOverrides(file)).rejects.toThrow();
  });
});

describe("verifyToken", () => {
  it("accepts a matching token", () => {
    expect(verifyToken("secret", "secret")).toBe(true);
  });

  it("rejects a mismatched token", () => {
    expect(verifyToken("wrong", "secret")).toBe(false);
  });

  it("rejects tokens of different lengths without throwing", () => {
    expect(verifyToken("short", "a-much-longer-secret-token")).toBe(false);
  });

  it("rejects when either value is missing", () => {
    expect(verifyToken("", "secret")).toBe(false);
    expect(verifyToken("secret", "")).toBe(false);
    expect(verifyToken(undefined, "secret")).toBe(false);
  });
});

describe("generateToken", () => {
  it("generates a non-empty, URL-safe, sufficiently long token", () => {
    const token = generateToken();
    expect(token.length).toBeGreaterThanOrEqual(24);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("generates a different token on each call", () => {
    expect(generateToken()).not.toBe(generateToken());
  });
});

describe("readToken / writeToken", () => {
  let dir;
  let file;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "editbar-token-test-"));
    file = path.join(dir, "nested", "token.txt");
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns null when the file does not exist", async () => {
    expect(await readToken(file)).toBe(null);
  });

  it("round-trips a token through write then read", async () => {
    await writeToken(file, "abc123");
    expect(await readToken(file)).toBe("abc123");
  });

  it("trims trailing whitespace/newlines", async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "abc123\n");
    expect(await readToken(file)).toBe("abc123");
  });

  it("writes the file with restrictive permissions", async () => {
    await writeToken(file, "abc123");
    const stat = await fs.stat(file);
    expect(stat.mode & 0o777).toBe(0o600);
  });
});
