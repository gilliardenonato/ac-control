import { generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import forge from "node-forge";
import mqttLib from "mqtt";
import type { ProviderHealth } from "@acc/domain";
import { LgApiError } from "./errors.ts";
import type { LgHttp } from "./http.ts";
import type { LgEvents } from "./provider.ts";

const ROOT_CA_URL = "https://www.amazontrust.com/repository/AmazonRootCA1.pem";
const CLIENT_BODY = { type: "MQTT", "service-code": "SVC202", "device-type": "607", allowExist: true };
/** A doc oficial limita expire.timer a 1–24 h (o SDK envia 4464 h; divergência) → renovamos antes de vencer. */
export const EVENT_EXPIRE = { unit: "HOUR", timer: 24 } as const;

export interface MqttClientLike {
  on(ev: string, cb: (...a: any[]) => void): unknown;
  subscribe(topic: string, opts: { qos: 0 | 1 | 2 }, cb?: (err?: Error | null) => void): unknown;
  end(force?: boolean, cb?: () => void): unknown;
}
export interface LgMqttOptions {
  http: LgHttp; clientId: string; dir: string;
  connect?: (url: string, o: Record<string, unknown>) => MqttClientLike;
  fetchRootCa?: () => Promise<string>;
  renewMs?: number; backoffBaseMs?: number; backoffMaxMs?: number;
  timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout; setInterval: typeof setInterval; clearInterval: typeof clearInterval };
  random?: () => number;
}
interface Creds { key: string; cert: string; topic: string; createdAt: number }

/** Eventos ThinQ via AWS IoT (mTLS). Credenciais em `dir` (modo 600); nada disso vai para banco, logs ou resposta da API. */
export class LgMqtt implements LgEvents {
  private t; private rand;
  constructor(private o: LgMqttOptions) {
    this.t = o.timers ?? { setTimeout, clearTimeout, setInterval, clearInterval };
    this.rand = o.random ?? Math.random;
    mkdirSync(o.dir, { recursive: true, mode: 0o700 });
  }
  private f = (n: string) => join(this.o.dir, n);

  private loadCreds(): Creds | null {
    try { if (!existsSync(this.f("mqtt.key"))) return null; return { key: readFileSync(this.f("mqtt.key"), "utf8"), cert: readFileSync(this.f("mqtt.crt"), "utf8"), topic: readFileSync(this.f("mqtt.topic"), "utf8").trim(), createdAt: Number(readFileSync(this.f("mqtt.created"), "utf8")) }; } catch { return null; }
  }
  private save(n: string, v: string) { writeFileSync(this.f(n), v, { mode: 0o600 }); chmodSync(this.f(n), 0o600); }
  private dropCreds() { for (const n of ["mqtt.key", "mqtt.crt", "mqtt.topic", "mqtt.created"]) rmSync(this.f(n), { force: true }); }

  async ensureCreds(): Promise<Creds> {
    const have = this.loadCreds(); if (have) return have;
    await this.o.http.call("POST", "/client", CLIENT_BODY);
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const keyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const csr = forge.pki.createCertificationRequest();
    csr.publicKey = forge.pki.publicKeyFromPem(publicKey.export({ type: "spki", format: "pem" }) as string);
    csr.setSubject([{ name: "commonName", value: "lg_thinq" }]);
    csr.sign(forge.pki.privateKeyFromPem(keyPem), forge.md.sha512.create());
    const csrB64 = forge.pki.certificationRequestToPem(csr).split("\n").filter((l) => l && !l.startsWith("-----")).join(""); // sem cabeçalhos PEM (como o SDK)
    const r: any = await this.o.http.call("POST", "/client/certificate", { "service-code": "SVC202", csr: csrB64 });
    const res = r?.result ?? r;
    if (!res?.certificatePem || !res?.subscriptions?.[0]) throw new LgApiError("0000", "resposta de certificado sem certificatePem/subscriptions", 200);
    this.save("mqtt.key", keyPem); this.save("mqtt.crt", res.certificatePem); this.save("mqtt.topic", res.subscriptions[0]); this.save("mqtt.created", String(Date.now()));
    return { key: keyPem, cert: res.certificatePem, topic: res.subscriptions[0], createdAt: Date.now() };
  }

  /** Assina push+event de cada aparelho. 1207 (já assinado) conta como sucesso. */
  async subscribeDevices(ids: string[], eventOnly = false) {
    for (const id of ids) {
      if (!eventOnly) { try { await this.o.http.call("POST", `/push/${id}/subscribe`); } catch (e) { if (!(e instanceof LgApiError && e.code === "1207")) throw e; } }
      await this.o.http.call("POST", `/event/${id}/subscribe`, { expire: EVENT_EXPIRE });
    }
  }

  async start(onMessage: (m: unknown) => void, onHealth: (h: ProviderHealth) => void, deviceIds: () => string[]): Promise<() => void> {
    let stopped = false, attempt = 0, failures = 0, client: MqttClientLike | undefined, retry: ReturnType<typeof setTimeout> | undefined, lastRegen = 0;
    const health = (status: ProviderHealth["status"], reason?: string) => onHealth({ type: "health", status, at: Date.now(), reason });
    const connect = this.o.connect ?? ((url, o) => mqttLib.connect(url, o as any) as unknown as MqttClientLike);

    const open = async () => {
      if (stopped) return;
      try {
        const creds = await this.ensureCreds();
        const ca = await (this.o.fetchRootCa ?? (async () => (await fetch(ROOT_CA_URL)).text()))();
        const route = await this.o.http.route();
        if (!route.mqttServer) throw new Error("rota sem mqttServer");
        const c = connect(route.mqttServer, { clientId: this.o.clientId, key: creds.key, cert: creds.cert, ca, clean: false, keepalive: 6, reconnectPeriod: 0, protocolVersion: 4 });
        client = c;
        let up = false;
        c.on("connect", () => {
          up = true; attempt = 0; failures = 0;
          c.subscribe(creds.topic, { qos: 1 }, (err) => { if (err) health("degraded", "falha ao assinar tópico"); });
          this.subscribeDevices(deviceIds()).then(() => health("connected")).catch((e) => health("degraded", `assinatura de eventos: ${(e as Error).message}`));
        });
        c.on("message", (_t: string, payload: Buffer) => { try { onMessage(JSON.parse(payload.toString())); } catch { /* mensagem inválida é ignorada */ } });
        const down = (why: string) => {
          if (stopped || client !== c) return; client = undefined;
          failures += up ? 0 : 1; up = false;
          health("disconnected", why);
          // credencial possivelmente inválida/expirada: regenera no máximo 1x por hora após falhas seguidas
          if (failures >= 5 && Date.now() - lastRegen > 3_600_000) { lastRegen = Date.now(); this.dropCreds(); }
          schedule();
        };
        c.on("error", (e: Error) => { c.end(true); down(`erro MQTT: ${e.message}`); });
        c.on("close", () => down("conexão fechada"));
        c.on("offline", () => down("offline"));
      } catch (e) { failures++; health("disconnected", `falha ao preparar MQTT: ${(e as Error).message}`); schedule(); }
    };
    const schedule = () => {
      if (stopped) return;
      const base = this.o.backoffBaseMs ?? 1000, max = this.o.backoffMaxMs ?? 300_000;
      const delay = Math.min(max, base * 2 ** attempt++) * (0.5 + this.rand() * 0.5); // backoff exponencial com jitter
      retry = this.t.setTimeout(() => void open(), delay);
    };
    void open();

    const renew = this.t.setInterval(() => { this.subscribeDevices(deviceIds(), true).catch((e) => health("degraded", `renovação de eventos: ${(e as Error).message}`)); }, this.o.renewMs ?? 12 * 3600_000);
    return () => { stopped = true; if (retry) this.t.clearTimeout(retry); this.t.clearInterval(renew); client?.end(true); };
  }
}
