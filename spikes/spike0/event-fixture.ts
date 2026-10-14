// Gera fixtures sanitizadas de eventos MQTT a partir de out/events.jsonl.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sanitize } from "./sanitize.ts";
const here = import.meta.dirname;
const lines = readFileSync(join(here, "out/events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.kind === "message");
const msgs = lines.map((e) => ({ t: e.t, msg: JSON.parse(e.payload) }));
const ids = [...new Set(msgs.map((m) => m.msg.deviceId as string))];
writeFileSync(join(here, "../../fixtures/lg/events.json"), JSON.stringify(sanitize(msgs.map((m) => m.msg), ids), null, 2));
console.log(`${msgs.length} eventos sanitizados`);
