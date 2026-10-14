import { ProviderError } from "@acc/domain";
import type { AttributePatch, Capabilities, Clock, DeviceState, Origin } from "@acc/domain";
import type { ACProvider } from "@acc/provider-api";
import type { CommandRow, Store } from "@acc/storage";

export interface GatewayConfig {
  minIntervalMs: number;      // espaçamento mínimo entre comandos ao mesmo aparelho
  confirmTimeoutMs: number;   // espera por evento antes de reconciliar com GET state
  retryDelaysMs: number[];    // backoff para erros transitórios
  globalMaxPerHour: number;   // teto de comandos enviados por aparelho/hora (qualquer origem)
  flipFlopCount: number;      // inversões de power na janela que abrem o breaker
  flipFlopWindowMs: number;
}
export const DEFAULT_GATEWAY_CONFIG: GatewayConfig = {
  minIntervalMs: 3000, confirmTimeoutMs: 8000, retryDelaysMs: [2000, 5000], globalMaxPerHour: 30, flipFlopCount: 3, flipFlopWindowMs: 30 * 60_000,
};

export interface CommandRequest {
  deviceId: string;
  attributes: AttributePatch;
  origin: Origin;
  ruleId?: string;
  idempotencyKey?: string;
  /** Guardas da regra (só para origem automation). */
  guards?: { minOnSec: number; minOffSec: number; maxCommandsPerHour: number };
  /** Ignora minOn/minOff/breaker (ex.: desligar por maxRuntime). Dedup e teto por hora continuam valendo. */
  force?: boolean;
}

export type GatewayEvent =
  | { type: "command.status"; command: CommandRow }
  | { type: "breaker.open"; deviceId: string; reason: string };

export interface GatewayDeps {
  store: Store;
  provider: ACProvider;
  clock: Clock;
  sleep?: (ms: number) => Promise<void>;
  externalId(deviceId: string): string;
  capabilities(deviceId: string): Promise<Capabilities>;
  state(deviceId: string): DeviceState;
  /** Instante da última mudança de power observada (para minOn/minOff). */
  powerSince(deviceId: string): number | undefined;
  /** Faz GET state e alimenta o StateStore (reconciliação). */
  refreshState(deviceId: string): Promise<void>;
  emit(e: GatewayEvent): void;
  config?: Partial<GatewayConfig>;
}

const TOLERANCE = 0.05;

/** Único caminho para enviar comandos ao aparelho. */
export class CommandGateway {
  private cfg: GatewayConfig;
  private queues = new Map<string, Promise<void>>();
  private lastSendAt = new Map<string, number>();
  private pendingConfirm = new Map<string, { cmd: CommandRow; patch: AttributePatch }[]>();
  private sleep: (ms: number) => Promise<void>;

  constructor(private d: GatewayDeps) {
    this.cfg = { ...DEFAULT_GATEWAY_CONFIG, ...d.config };
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  // --- breaker (persistido em settings; aberto até reset manual) ---
  breakerOpen(deviceId: string): { reason: string; at: number } | null { return this.d.store.getSetting<{ reason: string; at: number } | null>(`breaker:${deviceId}`, null); }
  resetBreaker(deviceId: string) { this.d.store.setSetting(`breaker:${deviceId}`, null); }
  private openBreaker(deviceId: string, reason: string) {
    this.d.store.setSetting(`breaker:${deviceId}`, { reason, at: this.d.clock.now() });
    this.d.emit({ type: "breaker.open", deviceId, reason });
  }

  /** Registra e enfileira. Retorna a linha do comando (pending, skipped ou failed). */
  async submit(req: CommandRequest): Promise<CommandRow> {
    const { store, clock } = this.d;
    const now = clock.now();
    if (req.idempotencyKey) {
      const prev = store.commandByIdempotency(req.deviceId, req.idempotencyKey);
      if (prev) return prev;
    }
    const cmd = store.insertCommand({ deviceId: req.deviceId, origin: req.origin, ruleId: req.ruleId, idempotencyKey: req.idempotencyKey, attributes: req.attributes, now });
    const finish = (p: Parameters<Store["updateCommand"]>[1]) => { store.updateCommand(cmd.id, p); const c = store.command(cmd.id)!; this.d.emit({ type: "command.status", command: c }); return c; };
    const skip = (reason: string) => finish({ status: "skipped", skipReason: reason });

    // 1. validação contra capabilities
    const caps = await this.d.capabilities(req.deviceId);
    const err = validatePatch(req.attributes, caps);
    if (err) return finish({ status: "failed", errorKind: "invalidCommand", skipReason: err });

    const isAuto = req.origin.startsWith("automation:");
    const st = this.d.state(req.deviceId);

    // 2. breaker (só automação)
    if (isAuto && !req.force && this.breakerOpen(req.deviceId)) return skip("breaker_open");

    // 3. dedup: remove campos já satisfeitos (só quando o campo foi observado)
    const patch = reduceToChanges(req.attributes, st);
    if (Object.keys(patch).length === 0) return skip("already_in_state");

    // 4. proteção do compressor (só automação, salvo force)
    if (isAuto && !req.force && req.guards) {
      const since = this.d.powerSince(req.deviceId);
      if (since !== undefined) {
        const elapsed = (now - since) / 1000;
        if (patch.power === false && st.values.power === true && elapsed < req.guards.minOnSec) return skip("min_on");
        if (patch.power === true && st.values.power === false && elapsed < req.guards.minOffSec) return skip("min_off");
      }
    }

    // 5. limites de taxa
    const sentHour = store.sentCommandsSince(req.deviceId, now - 3_600_000);
    if (sentHour.length >= this.cfg.globalMaxPerHour) return skip("rate_limited");
    if (isAuto && req.guards) {
      const autoHour = sentHour.filter((c) => c.origin.startsWith("automation:")).length;
      if (autoHour >= req.guards.maxCommandsPerHour) { this.openBreaker(req.deviceId, `automação excedeu ${req.guards.maxCommandsPerHour} comandos/h`); return skip("breaker_open"); }
    }
    // 6. flip-flop de power (automação)
    if (isAuto && patch.power !== undefined) {
      const flips = store.sentCommandsSince(req.deviceId, now - this.cfg.flipFlopWindowMs).filter((c) => c.origin.startsWith("automation:") && c.attributes.power !== undefined).length;
      if (flips + 1 > this.cfg.flipFlopCount) { this.openBreaker(req.deviceId, `oscilação de power (${flips + 1} inversões em ${this.cfg.flipFlopWindowMs / 60000} min)`); return skip("breaker_open"); }
    }

    // enfileira por aparelho (serial)
    const prev = this.queues.get(req.deviceId) ?? Promise.resolve();
    const run = prev.then(() => this.execute(req.deviceId, cmd.id, patch)).catch(() => {});
    this.queues.set(req.deviceId, run);
    return store.command(cmd.id)!;
  }

  /** Aguarda a fila esvaziar (testes/shutdown). */
  async idle() { await Promise.all([...this.queues.values()]); }

  /** Chamado pelo núcleo a cada estado novo: confirma comandos pendentes cujo patch já vale. */
  onState(deviceId: string) {
    const list = this.pendingConfirm.get(deviceId);
    if (!list?.length) return;
    const st = this.d.state(deviceId);
    this.pendingConfirm.set(deviceId, list.filter((p) => {
      if (!satisfied(p.patch, st.values)) return true;
      this.confirm(p.cmd.id);
      return false;
    }));
  }

  private confirm(id: string) {
    const now = this.d.clock.now();
    const c = this.d.store.command(id)!;
    if (c.status !== "sent") return;
    this.d.store.updateCommand(id, { status: "confirmed", confirmedAt: now, latencyMs: now - (c.sentAt ?? now) });
    this.d.emit({ type: "command.status", command: this.d.store.command(id)! });
  }

  private async execute(deviceId: string, id: string, patch: AttributePatch) {
    const { store, clock, provider } = this.d;
    const emit = () => this.d.emit({ type: "command.status", command: store.command(id)! });
    // espaçamento mínimo entre envios
    const wait = (this.lastSendAt.get(deviceId) ?? -Infinity) + this.cfg.minIntervalMs - clock.now();
    if (wait > 0) await this.sleep(wait);

    for (let attempt = 0; ; attempt++) {
      try {
        this.lastSendAt.set(deviceId, clock.now());
        store.updateCommand(id, { status: "sent", sentAt: clock.now() }); emit();
        await provider.setAttributes(this.d.externalId(deviceId), patch);
        break;
      } catch (e) {
        const pe = e instanceof ProviderError ? e : new ProviderError("fatal", String(e));
        // 2302/2304: aparelho já está nesse estado de power -> idempotente
        if (pe.kind === "notSupportedInState" && patch.power !== undefined && (pe.code === "2302" || pe.code === "2304")) {
          store.updateCommand(id, { status: "skipped", skipReason: "already_in_state" }); emit(); return;
        }
        const delay = this.cfg.retryDelaysMs[attempt];
        if (pe.retryable && delay !== undefined) { await this.sleep(delay); continue; }
        store.updateCommand(id, { status: "failed", errorKind: pe.kind, errorCode: pe.code }); emit(); return;
      }
    }
    // confirmação: evento (onState) ou reconciliação por GET state
    const cmd = store.command(id)!;
    const list = this.pendingConfirm.get(deviceId) ?? [];
    list.push({ cmd, patch }); this.pendingConfirm.set(deviceId, list);
    await this.sleep(this.cfg.confirmTimeoutMs);
    if (store.command(id)!.status !== "sent") return;
    try { await this.d.refreshState(deviceId); } catch { /* segue como não confirmado */ }
    this.onState(deviceId);
    if (store.command(id)!.status === "sent") {
      this.pendingConfirm.set(deviceId, (this.pendingConfirm.get(deviceId) ?? []).filter((p) => p.cmd.id !== id));
      store.updateCommand(id, { errorKind: "unconfirmed" }); emit();
    }
  }
}

export function validatePatch(p: AttributePatch, caps: Capabilities): string | null {
  const keys = Object.keys(p) as (keyof AttributePatch)[];
  if (keys.length === 0) return "comando vazio";
  if (p.targetTemp !== undefined) {
    const t = caps.temperature;
    if (!t) return "aparelho não suporta temperatura alvo";
    if (p.targetTemp < t.min || p.targetTemp > t.max) return `temperatura fora de ${t.min}-${t.max}`;
    const steps = (p.targetTemp - t.min) / t.step;
    if (Math.abs(steps - Math.round(steps)) > 1e-6) return `temperatura deve respeitar passo ${t.step}`;
  }
  if (p.mode !== undefined && !caps.modes.includes(p.mode)) return `modo ${p.mode} não suportado`;
  if (p.fan !== undefined && !caps.fan?.values.includes(p.fan)) return `fan ${p.fan} não suportado`;
  if ((p.swingV !== undefined && !caps.swing?.vertical) || (p.swingH !== undefined && !caps.swing?.horizontal)) return "swing não suportado";
  if (p.powerSave !== undefined && !caps.powerSave) return "power-save não suportado";
  if (p.display !== undefined && !caps.display) return "visor não suportado";
  return null;
}

export function reduceToChanges(p: AttributePatch, st: DeviceState): AttributePatch {
  const out: AttributePatch = {};
  const v = st.values;
  if (p.power !== undefined && v.power !== p.power) out.power = p.power;
  if (p.mode !== undefined && v.mode !== p.mode) out.mode = p.mode;
  if (p.targetTemp !== undefined && !(v.targetTemp !== undefined && Math.abs(v.targetTemp - p.targetTemp) < TOLERANCE)) out.targetTemp = p.targetTemp;
  if (p.fan !== undefined && v.fan !== p.fan) out.fan = p.fan;
  if (p.display !== undefined && v.display !== p.display) out.display = p.display;
  if (p.swingV !== undefined) out.swingV = p.swingV; // sem estado observado: sempre envia
  if (p.swingH !== undefined) out.swingH = p.swingH;
  if (p.powerSave !== undefined) out.powerSave = p.powerSave;
  return out;
}

function satisfied(p: AttributePatch, v: DeviceState["values"]): boolean {
  return (p.power === undefined || v.power === p.power) && (p.mode === undefined || v.mode === p.mode)
    && (p.targetTemp === undefined || (v.targetTemp !== undefined && Math.abs(v.targetTemp - p.targetTemp) < TOLERANCE))
    && (p.fan === undefined || v.fan === p.fan)
    && (p.display === undefined || v.display === undefined || v.display === p.display);
}
