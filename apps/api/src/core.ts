import { createHash } from "node:crypto";
import { StateStore, systemClock } from "@acc/domain";
import type { Capabilities, Clock, DeviceEvent, NormalizedState, ProviderHealth, StateField } from "@acc/domain";
import type { ACProvider } from "@acc/provider-api";
import { CommandGateway } from "@acc/automation";
import type { DeviceRow, Store } from "@acc/storage";
import { Bus } from "./bus.ts";

const CONTROLLED: StateField[] = ["power", "mode", "targetTemp", "fan"];
const OWN_ECHO_WINDOW_MS = 15_000;
const HEARTBEAT_MS = 60 * 60_000;
/** Temperatura ambiente oscila muito quando o app da LG está aberto; no histórico gravamos no máximo 1 ponto por minuto. */
const TEMP_MIN_INTERVAL_MS = 60_000;

export interface StateChange { device: DeviceRow; prev: NormalizedState; changed: StateField[]; source: string; at: number; external: boolean }
export type StateListener = (c: StateChange) => void | Promise<void>;

/** Núcleo da aplicação: liga provider, estado, persistência, gateway e barramento. */
export class Core {
  readonly states = new StateStore();
  readonly bus: Bus;
  readonly gateway: CommandGateway;
  private caps = new Map<string, Capabilities>();
  private byExternal = new Map<string, DeviceRow>();
  private lastOwnCommand = new Map<string, number>();
  private lastReading = new Map<string, number>();
  private listeners: StateListener[] = [];
  private unsub?: () => void;
  private started = false;
  health: ProviderHealth = { type: "health", status: "disconnected", at: 0 };

  constructor(readonly store: Store, readonly provider: ACProvider, readonly clock: Clock = systemClock, opts: { sleep?: (ms: number) => Promise<void>; gateway?: object } = {}) {
    this.bus = new Bus(500, () => clock.now());
    this.gateway = new CommandGateway({
      store, provider, clock, sleep: opts.sleep, config: opts.gateway as any,
      externalId: (id) => this.deviceOrThrow(id).externalId,
      capabilities: (id) => this.capabilities(id),
      state: (id) => this.states.get(id),
      powerSince: (id) => this.states.powerSince(id),
      refreshState: (id) => this.refreshState(id, "poll"),
      emit: (e) => {
        if (e.type === "command.status") {
          if (e.command.status === "sent") this.lastOwnCommand.set(e.command.deviceId, clock.now());
          this.bus.publish(e);
        } else this.bus.publish(e);
      },
    });
  }

  onState(l: StateListener) { this.listeners.push(l); }
  deviceOrThrow(id: string): DeviceRow { const d = this.store.device(id); if (!d) throw new Error(`device ${id} não existe`); return d; }

  async capabilities(deviceId: string): Promise<Capabilities> {
    const c = this.caps.get(deviceId);
    if (c) return c;
    const d = this.deviceOrThrow(deviceId);
    const fresh = await this.provider.getCapabilities(d.externalId);
    this.caps.set(deviceId, fresh);
    this.store.saveCapabilities(deviceId, createHash("sha256").update(JSON.stringify(fresh)).digest("hex").slice(0, 16), fresh, this.clock.now());
    return fresh;
  }
  cachedCapabilities(deviceId: string) { return this.caps.get(deviceId); }

  /** Descobre aparelhos, carrega capabilities e estado inicial e assina eventos. */
  async start() {
    for (const pd of await this.provider.getDevices()) {
      const d = this.store.upsertDevice(this.provider.id, pd.externalId, pd.name, pd.model, this.clock.now());
      this.byExternal.set(pd.externalId, d);
      await this.capabilities(d.id);
    }
    this.unsub = await this.provider.subscribeEvents((e) => this.handle(e));
    await this.refreshAll("poll");
    this.started = true;
  }
  async refreshAll(source: "poll" | "mqtt") {
    for (const d of this.store.devices()) {
      try { await this.refreshState(d.id, source); } catch { this.markOffline(d); }
    }
  }
  async stop() { this.unsub?.(); await this.gateway.idle(); }

  markOffline(d: DeviceRow) {
    this.handle({ type: "state", deviceId: d.externalId, receivedAt: this.clock.now(), source: "poll", fieldsPresent: ["online"], normalizedState: { online: false } });
  }

  async refreshState(deviceId: string, source: "poll" | "mqtt" = "poll") {
    const d = this.deviceOrThrow(deviceId);
    const s = await this.provider.getState(d.externalId);
    const fields = (Object.keys(s) as StateField[]).filter((k) => s[k] !== undefined);
    if (!fields.includes("online")) { s.online = true; fields.push("online"); }
    this.handle({ type: "state", deviceId: d.externalId, receivedAt: this.clock.now(), source, fieldsPresent: fields, normalizedState: s });
  }

  handle(e: DeviceEvent | ProviderHealth) {
    if (e.type === "health") {
      const was = this.health.status;
      this.health = e; this.bus.publish({ type: "provider.health", health: e });
      // voltou da queda: o push pode ter perdido mudanças → reconcilia o estado completo
      if (e.status === "connected" && was !== "connected" && this.started) void this.refreshAll("poll");
      return;
    }
    const device = this.byExternal.get(e.deviceId) ?? this.store.deviceByExternal(this.provider.id, e.deviceId);
    if (!device) return;
    this.byExternal.set(e.deviceId, device);
    const at = e.receivedAt;
    this.store.insertEventRaw(device.id, at, e.source, { fields: e.fieldsPresent, state: e.normalizedState });
    const { prev, changed } = this.states.apply({ deviceId: device.id, receivedAt: at, fieldsPresent: e.fieldsPresent, normalizedState: e.normalizedState });
    const sinceLast = at - (this.lastReading.get(device.id) ?? 0);
    const onlyTemp = changed.length > 0 && changed.every((f) => f === "currentTemp" || f === "humidity");
    const worthStoring = changed.length > 0 && (!onlyTemp || sinceLast >= TEMP_MIN_INTERVAL_MS);
    if (worthStoring || sinceLast >= HEARTBEAT_MS) {
      this.store.insertReading(device.id, at, this.states.get(device.id).values, e.source);
      this.lastReading.set(device.id, at);
    }
    // mudança nos campos controláveis fora da janela de eco de comando nosso = alteração externa
    const lastOwn = this.lastOwnCommand.get(device.id);
    const ctrlChanged = changed.filter((f) => CONTROLLED.includes(f));
    const external = ctrlChanged.length > 0 && !(lastOwn !== undefined && at - lastOwn <= OWN_ECHO_WINDOW_MS) && prev.power !== undefined;
    const st = this.states.get(device.id);
    this.bus.publish({ type: "device.state", deviceId: device.id, state: st.values, observedAt: st.observedAt as Record<string, number>, changed, source: e.source });
    if (external) this.bus.publish({ type: "device.external-change", deviceId: device.id, changed: ctrlChanged });
    this.gateway.onState(device.id);
    const change: StateChange = { device, prev, changed, source: e.source, at, external };
    for (const l of this.listeners) { try { void Promise.resolve(l(change)).catch(() => {}); } catch { /* listener não derruba o núcleo */ } }
  }
}
