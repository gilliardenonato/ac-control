import { ProviderError } from "@acc/domain";
import type { AttributePatch, Capabilities, Clock, DeviceEvent, EnergyCapabilities, EnergyPoint, EnergyQuery, NormalizedState, ProviderHealth } from "@acc/domain";
import { systemClock } from "@acc/domain";
import type { ACProvider, ProviderDevice, Unsubscribe } from "@acc/provider-api";
import { chunk, parseUsage } from "./energy.ts";
import { toProviderError } from "./errors.ts";
import { LgHttp } from "./http.ts";
import { buildCommands, checkPatch, parseProfile, parseState } from "./mapping.ts";
import type { LgProfile } from "./mapping.ts";

export interface LgOptions {
  http: LgHttp;
  clock?: Clock;
  /** Espera entre grupos de comando do mesmo setAttributes (a LG exige ~2-3 s entre comandos). */
  commandGapMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Fator para converter o valor de energia da LG em Wh. Padrão 1 (Wh); confirmar no Spike 0. */
  energyUnitFactor?: number;
  /** Fonte de eventos (MQTT). Injetada para testes. */
  events?: LgEvents;
}
export interface LgEvents {
  start(onMessage: (m: unknown) => void, onHealth: (h: ProviderHealth) => void, deviceIds: () => string[]): Promise<() => void>;
}

/** Único módulo que conhece a LG ThinQ Connect API. */
export class LgThinqProvider implements ACProvider {
  readonly id = "lg-thinq";
  private http: LgHttp;
  private clock: Clock;
  private profiles = new Map<string, LgProfile>();
  private energyProps = new Map<string, string[]>();
  private sleep: (ms: number) => Promise<void>;

  constructor(private o: LgOptions) {
    this.http = o.http; this.clock = o.clock ?? systemClock;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async run<T>(f: () => Promise<T>): Promise<T> { try { return await f(); } catch (e) { throw toProviderError(e); } }

  async getDevices(): Promise<ProviderDevice[]> {
    return this.run(async () => {
      const r: any = await this.http.call("GET", "/devices");
      const list: any[] = r?.devices ?? (Array.isArray(r) ? r : []);
      return list.filter((d) => (d.deviceInfo?.deviceType ?? d.deviceType) === "DEVICE_AIR_CONDITIONER")
        .map((d) => ({ externalId: d.deviceId as string, name: (d.deviceInfo?.alias ?? d.alias ?? "Ar-condicionado") as string, model: (d.deviceInfo?.modelName ?? d.modelName) as string | undefined }));
    });
  }

  private async profile(externalId: string): Promise<LgProfile> {
    const cached = this.profiles.get(externalId);
    if (cached) return cached;
    const raw = await this.http.call("GET", `/devices/${externalId}/profile`);
    const p = parseProfile(raw);
    this.profiles.set(externalId, p);
    return p;
  }

  async getCapabilities(externalId: string): Promise<Capabilities> {
    return this.run(async () => {
      const p = await this.profile(externalId);
      return { ...p.caps, energy: await this.energyCaps(externalId) };
    });
  }

  async getState(externalId: string): Promise<NormalizedState> {
    return this.run(async () => {
      const p = await this.profile(externalId);
      const raw = await this.http.call("GET", `/devices/${externalId}/state`);
      return { ...parseState(raw, p).state, online: true };
    });
  }

  async setAttributes(externalId: string, patch: AttributePatch): Promise<void> {
    return this.run(async () => {
      const p = await this.profile(externalId);
      const bad = checkPatch(patch, p);
      if (bad) throw new ProviderError("invalidCommand", bad, { code: "local" });
      const bodies = buildCommands(patch, p);
      if (bodies.length === 0) throw new ProviderError("invalidCommand", "nada a enviar");
      for (const [i, body] of bodies.entries()) {
        if (i > 0) await (this.o.commandGapMs === 0 ? Promise.resolve() : this.sleep(this.o.commandGapMs ?? 2000));
        await this.http.call("POST", `/devices/${externalId}/control`, body, { "x-conditional-control": "true" });
      }
    });
  }

  private async energyProperties(externalId: string): Promise<string[]> {
    const c = this.energyProps.get(externalId);
    if (c) return c;
    const r: any = await this.http.call("GET", `/devices/energy/${externalId}/profile`);
    const props: string[] = r?.result?.property ?? r?.property ?? [];
    this.energyProps.set(externalId, props);
    return props;
  }
  private async energyCaps(externalId: string): Promise<EnergyCapabilities> {
    try {
      const props = await this.energyProperties(externalId);
      return { supported: props.length > 0, granularities: props.length ? ["day", "month"] : [], unit: "Wh", properties: props };
    } catch (e) {
      const pe = toProviderError(e);
      if (pe.kind === "unsupported" || pe.kind === "scope") return { supported: false, granularities: [], unit: "Wh", properties: [] };
      throw pe;
    }
  }
  async getEnergyCapabilities(externalId: string): Promise<EnergyCapabilities> { return this.run(() => this.energyCaps(externalId)); }

  async getEnergyUsage(externalId: string, q: EnergyQuery): Promise<EnergyPoint[]> {
    return this.run(async () => {
      const props = await this.energyProperties(externalId);
      const prop = props.find((p) => p === "energyUsage") ?? props[0];
      if (!prop) throw new ProviderError("unsupported", "aparelho sem propriedade de energia", { code: "1221" });
      const out: EnergyPoint[] = [];
      for (const w of chunk(q)) {
        const r = await this.http.call("GET", `/devices/energy/${externalId}/usage?property=${encodeURIComponent(prop)}&period=${w.period}&startDate=${w.start}&endDate=${w.end}`);
        out.push(...parseUsage(r, this.o.energyUnitFactor ?? 1, this.clock.now()));
      }
      return out;
    });
  }

  async subscribeEvents(handler: (e: DeviceEvent | ProviderHealth) => void): Promise<Unsubscribe> {
    if (!this.o.events) return () => {};
    return this.o.events.start(
      (m) => { const ev = this.toEvent(m); if (ev) handler(ev); },
      handler,
      () => [...this.profiles.keys()],
    );
  }

  /** Mensagem MQTT → evento normalizado (só campos presentes). Aceita envelope `event` ou campos no topo. */
  toEvent(msg: any): DeviceEvent | null {
    const ev = msg?.event ?? msg;
    if (!ev || typeof ev.pushType !== "string" || !ev.pushType.startsWith("DEVICE_STATUS")) return null;
    const deviceId = ev.deviceId as string | undefined;
    if (!deviceId || !ev.report) return null;
    const { state, fieldsPresent } = parseState(ev.report, this.profiles.get(deviceId));
    if (fieldsPresent.length === 0) return null;
    return { type: "state", deviceId, receivedAt: this.clock.now(), source: "mqtt", fieldsPresent, normalizedState: state, providerTimestamp: typeof msg.timestamp === "number" ? msg.timestamp : undefined };
  }
}
