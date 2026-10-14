import type { Store } from "@acc/storage";
import type { Clock } from "@acc/domain";
import type { Bus } from "./bus.ts";
import type { Core, StateChange } from "./core.ts";

/** POWER ON → POWER OFF = sessão. Persistida; sobrevive a restart (sessão aberta é reconciliada com o estado). */
export class SessionEngine {
  constructor(private store: Store, private core: Core, private bus: Bus, private clock: Clock) {}

  onState(c: StateChange) {
    if (!c.changed.includes("power")) return;
    const v = this.core.states.get(c.device.id).values;
    const open = this.store.openSessionOf(c.device.id);
    if (v.power === true && !open) {
      const { origin, ruleId } = this.originOf(c);
      const s = this.store.openSession({ deviceId: c.device.id, startTs: c.at, tempStart: v.currentTemp, targetTemp: v.targetTemp, mode: v.mode, fan: v.fan, origin, ruleId });
      this.bus.publish({ type: "session.opened", deviceId: c.device.id, sessionId: s.id });
    } else if (v.power === false && open) {
      // primeira observação com sessão aberta no banco = a app esteve fora: não sabemos quando desligou
      const closedBy = c.prev.power === undefined ? "shutdown_recovery" : "power_off";
      this.store.closeSession(open.id, c.at, closedBy, v.currentTemp);
      this.bus.publish({ type: "session.closed", deviceId: c.device.id, sessionId: open.id });
    }
  }

  private originOf(c: StateChange): { origin: string; ruleId?: string } {
    const recent = this.store.commands(c.device.id, 5).find((x) => x.attributes.power === true && x.status !== "failed" && c.at - x.createdAt <= 120_000);
    if (recent) return { origin: recent.origin, ruleId: recent.ruleId ?? undefined };
    return { origin: c.prev.power === undefined ? "unknown" : "external" };
  }
}
