import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import type { Store } from "@acc/storage";

const N = 16384;
export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  return `scrypt$${N}$${salt.toString("base64")}$${scryptSync(pw, salt, 32, { N }).toString("base64")}`;
}
export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, n, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !n || !salt || !hash) return false;
  const got = scryptSync(pw, Buffer.from(salt, "base64"), 32, { N: Number(n) });
  const want = Buffer.from(hash, "base64");
  return got.length === want.length && timingSafeEqual(got, want);
}
export const safeEqual = (a: string, b: string) => {
  const x = createHash("sha256").update(a).digest(), y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y);
};

const SESSION_MS = 7 * 24 * 3600_000;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Sessões opacas: o cookie leva um token aleatório; o banco guarda só o hash. */
export class Sessions {
  constructor(private store: Store, private now: () => number = Date.now) {}
  create(): { token: string; expiresAt: number } {
    const token = randomBytes(32).toString("base64url");
    const at = this.now();
    this.store.db.prepare("INSERT INTO auth_session VALUES (?,?,?)").run(sha(token), at, at + SESSION_MS);
    return { token, expiresAt: at + SESSION_MS };
  }
  valid(token: string | undefined): boolean {
    if (!token) return false;
    const r = this.store.db.prepare("SELECT expires_at e FROM auth_session WHERE id=?").get(sha(token)) as { e: number } | undefined;
    return !!r && r.e > this.now();
  }
  destroy(token: string | undefined) { if (token) this.store.db.prepare("DELETE FROM auth_session WHERE id=?").run(sha(token)); }
  purgeExpired() { this.store.db.prepare("DELETE FROM auth_session WHERE expires_at<?").run(this.now()); }
}
