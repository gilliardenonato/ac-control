// Spike 0: cliente LG mínimo e descartável. Nunca loga PAT/chaves.
import { randomUUID } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const API_KEY = "v6GFvkweNo7DK7yD3ylIZ9w52aKBU0eJ7wLXkSR3"; // publicado na doc oficial
export const DATA_DIR = process.env.DATA_DIR ?? "./data";
export const OUT_DIR = join(import.meta.dirname, "out");
mkdirSync(join(DATA_DIR, "lg"), { recursive: true, mode: 0o700 });
mkdirSync(OUT_DIR, { recursive: true });

const pat = process.env.LG_PAT;
const country = process.env.LG_COUNTRY ?? "BR";
export const BASE = process.env.LG_BASE ?? "https://api-aic.lgthinq.com"; // BR/AR = aic (country.py)

export function clientId(): string {
  const f = join(DATA_DIR, "lg", "client-id");
  if (existsSync(f)) return readFileSync(f, "utf8").trim();
  const id = randomUUID();
  writeFileSync(f, id, { mode: 0o600 });
  return id;
}

const messageId = () => Buffer.from(randomUUID().replace(/-/g, ""), "hex").toString("base64url").slice(0, 22);

export interface Call { status: number; ms: number; body: any; headers: Record<string, string> }

export async function call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Call> {
  if (!pat) throw new Error("LG_PAT ausente no .env");
  const t0 = Date.now();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${pat}`, "x-country": country, "x-message-id": messageId(),
      "x-client-id": clientId(), "x-api-key": API_KEY, "x-service-phase": "OP",
      "content-type": "application/json", ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let parsed: any; try { parsed = JSON.parse(text); } catch { parsed = text; }
  const h: Record<string, string> = {};
  res.headers.forEach((v, k) => { if (/^(x-|retry|ratelimit)/i.test(k)) h[k] = v; });
  return { status: res.status, ms: Date.now() - t0, body: parsed, headers: h };
}

export const route = async () => {
  // /route não usa Authorization nem client-id (doc), só x-api-key/x-country/x-service-phase
  const res = await fetch(`${BASE}/route`, { headers: { "x-country": country, "x-message-id": messageId(), "x-api-key": API_KEY, "x-service-phase": "OP" } });
  return { status: res.status, body: await res.json().catch(() => null) };
};

export function save(name: string, data: unknown) {
  writeFileSync(join(OUT_DIR, name), JSON.stringify(data, null, 2), { mode: 0o600 });
}
