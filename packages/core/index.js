import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export async function readOverrides(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
}

export async function writeOverrides(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmpPath, filePath);
}

// Hash both sides first so timingSafeEqual always compares equal-length
// buffers — avoids leaking the expected token's length via a thrown error.
export function verifyToken(provided, expected) {
  if (!provided || !expected) return false;
  const providedHash = crypto.createHash("sha256").update(provided).digest();
  const expectedHash = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(providedHash, expectedHash);
}

export function generateToken() {
  return crypto.randomBytes(24).toString("base64url");
}

export async function readToken(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw.trim() || null;
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

export async function writeToken(filePath, token) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, token, { encoding: "utf8", mode: 0o600 });
}
