// Sanitiza payloads LG antes de virarem fixtures versionadas.
const SENSITIVE_KEYS = /^(serviceId|userList|email|userNo|userId|certificatePem|privateKey|csr|ssid|serial|macAddress|ipAddress)$/i;

export function sanitize<T>(data: T, knownIds: string[] = []): T {
  const idMap = new Map(knownIds.map((id, i) => [id, `DEVICE_${i + 1}`]));
  const walk = (v: any): any => {
    if (typeof v === "string") {
      let s = v;
      for (const [id, alias] of idMap) s = s.split(id).join(alias);
      return s.replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "<PEM>")
              .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer <REDACTED>")
              .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<UUID>");
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const o: any = {};
      for (const [k, val] of Object.entries(v)) {
        if (SENSITIVE_KEYS.test(k)) { o[k] = "<REDACTED>"; continue; }
        if (k === "alias" || k === "deviceAlias" || k === "name") { o[k] = "AC"; continue; }
        o[k] = walk(val);
      }
      return o;
    }
    return v;
  };
  return walk(data);
}
