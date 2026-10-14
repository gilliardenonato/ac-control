import { ProviderError } from "@acc/domain";
import type { ProviderErrorKind } from "@acc/domain";

export class LgApiError extends Error {
  constructor(public code: string, message: string, public httpStatus: number) { super(`LG ${code}: ${message}`); }
}

/** Códigos documentados no SDK oficial (ThinQAPIErrorCodes) + 1314, visto em issues e ausente do enum. */
const KIND: Record<string, ProviderErrorKind> = {
  "1222": "offline", "1223": "offline", "2205": "notSupportedInState",
  "1306": "rateLimited", "1314": "rateLimited",
  "1103": "auth", "1218": "auth", "1302": "auth", "1301": "auth", "1307": "auth",
  "1309": "scope", "1305": "scope", "1308": "scope",
  "1219": "unsupported", "1220": "unsupported", "1221": "unsupported", "2101": "unsupported", "2201": "unsupported", "2202": "unsupported", "2203": "unsupported",
  "2207": "invalidCommand", "1101": "invalidCommand", "1102": "invalidCommand",
  "2301": "notSupportedInState", "2302": "notSupportedInState", "2303": "notSupportedInState", "2304": "notSupportedInState", "2305": "notSupportedInMode",
  "2000": "transient", "2208": "transient", "2209": "transient", "2210": "transient", "2212": "transient", "2213": "transient", "2214": "transient",
};

export function toProviderError(e: unknown): ProviderError {
  if (e instanceof ProviderError) return e;
  if (e instanceof LgApiError) {
    const kind = KIND[e.code] ?? (e.httpStatus >= 500 ? "transient" : "fatal");
    return new ProviderError(kind, e.message, { code: e.code, retryAfterMs: kind === "rateLimited" ? 60_000 : undefined });
  }
  const name = (e as { name?: string })?.name;
  if (name === "AbortError" || name === "TimeoutError" || e instanceof TypeError) return new ProviderError("transient", `rede: ${String((e as Error).message)}`);
  return new ProviderError("fatal", String((e as Error)?.message ?? e));
}
