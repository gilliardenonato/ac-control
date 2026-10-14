import type { Action, Condition, RuleDefinition } from "@acc/domain";

const FAN: Record<string, string> = { low: "baixa", mid: "média", high: "alta", auto: "auto", nature: "natural", low_mid: "baixa-média", mid_high: "média-alta" };
const MODE: Record<string, string> = { cool: "frio", heat: "quente", dry: "seco", fan: "ventilar", auto: "auto" };
const DAY = ["", "seg", "ter", "qua", "qui", "sex", "sáb", "dom"];
const dur = (s: number) => (s % 3600 === 0 ? `${s / 3600} h` : s % 60 === 0 ? `${s / 60} min` : `${s} s`);

export function describeCondition(c: Condition, sensors: Record<string, string> = {}): string {
  switch (c.type) {
    case "temp": return `temperatura${c.sensor ? ` do sensor ${sensors[c.sensor] ?? "externo"}` : ""} ${c.op} ${c.value} °C${c.forSec ? ` por ${dur(c.forSec)}` : ""}`;
    case "timeWindow": return `entre ${c.from} e ${c.to}`;
    case "weekday": return `dias: ${c.in.map((d) => DAY[d]).join(", ")}`;
    case "deviceState": return [c.power === undefined ? "" : c.power ? "aparelho ligado" : "aparelho desligado", c.mode ? `modo ${MODE[c.mode] ?? c.mode}` : ""].filter(Boolean).join(" e ");
    case "onDuration": return `ligado ${c.op} ${dur(c.seconds)}`;
    case "all": return c.of.map((x) => describeCondition(x, sensors)).join(" e ");
    case "any": return `(${c.of.map((x) => describeCondition(x, sensors)).join(" ou ")})`;
    case "not": return `não (${describeCondition(c.of, sensors)})`;
  }
}
export function describeActions(a: Action[]): string {
  return a.map((x) => {
    if (x.type === "wait") return `aguardar ${dur(x.sec)}`;
    if (x.type === "runFor") return `manter por ${dur(x.sec)}`;
    const p: string[] = [];
    if (x.power !== undefined) p.push(x.power ? "ligar" : "desligar");
    if (x.mode) p.push(`modo ${MODE[x.mode] ?? x.mode}`);
    if (x.targetTemp !== undefined) p.push(`${x.targetTemp} °C`);
    if (x.fan) p.push(`ventilação ${FAN[x.fan] ?? x.fan}`);
    if (x.swingV !== undefined) p.push(`swing V ${x.swingV ? "on" : "off"}`);
    if (x.display !== undefined) p.push(x.display ? "acender o visor" : "apagar o visor");
    if (x.powerSave !== undefined) p.push(`economia ${x.powerSave ? "on" : "off"}`);
    return p.join(", ");
  }).join(" → ");
}
/** Texto curto para o card "automação ativa". */
export function describeRule(r: RuleDefinition, sensors: Record<string, string> = {}): { when: string; then: string; until: string | null; onEnd: string | null } {
  return { when: describeCondition(r.when, sensors), then: describeActions(r.actions), until: r.until ? describeCondition(r.until, sensors) : null, onEnd: r.onEnd?.length ? describeActions(r.onEnd) : null };
}
