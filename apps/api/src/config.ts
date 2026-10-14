import { readFileSync } from "node:fs";
import { join } from "node:path";

function secret(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const f = env[`${name}_FILE`];
  if (f) return readFileSync(f, "utf8").trim();
  return env[name]?.trim() || undefined;
}

export interface Config {
  host: string; port: number; dataDir: string; tz: string;
  provider: "fake" | "lg-thinq";
  adminPasswordHash?: string; apiToken?: string;
  lgPat?: string; lgCountry: string;
  secureCookie: boolean; webDir?: string; logLevel: string;
}

export const isLoopback = (h: string) => h === "127.0.0.1" || h === "::1" || h === "localhost";

export function loadConfig(env = process.env): Config {
  const c: Config = {
    host: env.HOST ?? "127.0.0.1",
    port: Number(env.PORT ?? 8080),
    dataDir: env.DATA_DIR ?? "./data",
    tz: env.USER_TZ ?? "America/Sao_Paulo",
    provider: (env.PROVIDER as Config["provider"]) ?? (env.LG_PAT || env.LG_PAT_FILE ? "lg-thinq" : "fake"),
    adminPasswordHash: secret(env, "ADMIN_PASSWORD_HASH"),
    apiToken: secret(env, "API_TOKEN"),
    lgPat: secret(env, "LG_PAT"),
    lgCountry: env.LG_COUNTRY ?? "BR",
    secureCookie: env.COOKIE_SECURE === "true",
    webDir: env.WEB_DIR,
    logLevel: env.LOG_LEVEL ?? "info",
  };
  // Fora de loopback a API só sobe com autenticação configurada.
  if (!isLoopback(c.host) && !c.adminPasswordHash && !c.apiToken) throw new Error("HOST não-loopback exige ADMIN_PASSWORD_HASH ou API_TOKEN");
  return c;
}
export const dbPath = (c: Config) => join(c.dataDir, "ac-control.db");
