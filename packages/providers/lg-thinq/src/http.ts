import { randomUUID } from "node:crypto";
import { LgApiError } from "./errors.ts";

/** Valor fixo e público (publicado na documentação oficial da LG). Não é segredo do usuário. */
export const API_KEY = "v6GFvkweNo7DK7yD3ylIZ9w52aKBU0eJ7wLXkSR3";

/** Países por região conforme `country.py` do SDK oficial. Só Américas listado; outros: informe `baseUrl`. */
const AIC = new Set(["BR", "AR", "BO", "CL", "CO", "EC", "MX", "PE", "PY", "UY", "VE", "US", "CA", "CR", "DO", "GT", "HN", "NI", "PA", "SV", "JM", "TT", "PR", "CU", "HT"]);
export const baseUrlFor = (country: string) => {
  if (AIC.has(country)) return "https://api-aic.lgthinq.com";
  throw new Error(`país ${country} não mapeado: defina LG_BASE_URL (kic/eic/aic)`);
};

export interface HttpOptions { pat: string; country: string; clientId: string; baseUrl?: string; timeoutMs?: number; fetch?: typeof fetch }

const messageId = () => Buffer.from(randomUUID().replace(/-/g, ""), "hex").toString("base64url").slice(0, 22);

export class LgHttp {
  readonly baseUrl: string;
  private f: typeof fetch;
  constructor(private o: HttpOptions) { this.baseUrl = o.baseUrl ?? baseUrlFor(o.country); this.f = o.fetch ?? fetch; }

  /** Retorna `response` do envelope LG. Lança LgApiError com código LG. O PAT nunca aparece em mensagens. */
  async call<T = any>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown, extra: Record<string, string> = {}): Promise<T> {
    const res = await this.f(`${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.o.pat}`, "x-country": this.o.country, "x-message-id": messageId(), "x-client-id": this.o.clientId, "x-api-key": API_KEY, "x-service-phase": "OP", "content-type": "application/json", ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.o.timeoutMs ?? 15_000),
    });
    const text = await res.text();
    let j: any; try { j = JSON.parse(text); } catch { j = undefined; }
    if (!res.ok) {
      const err = j?.error ?? {};
      throw new LgApiError(String(err.code ?? "0000"), String(err.message ?? `HTTP ${res.status}`), res.status);
    }
    return (j?.response ?? j ?? {}) as T;
  }

  /** /route não usa Authorization nem client-id. */
  async route(): Promise<{ apiServer?: string; mqttServer?: string; webSocketServer?: string }> {
    const res = await this.f(`${this.baseUrl}/route`, { headers: { "x-country": this.o.country, "x-message-id": messageId(), "x-api-key": API_KEY, "x-service-phase": "OP" }, signal: AbortSignal.timeout(this.o.timeoutMs ?? 15_000) });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new LgApiError(String(j?.error?.code ?? "0000"), String(j?.error?.message ?? `HTTP ${res.status}`), res.status);
    return j?.response ?? j;
  }
}
