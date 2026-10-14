// Spike 0: registra cliente MQTT, obtém certificado, conecta e grava eventos por N segundos.
import { generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import forge from "node-forge";
import mqtt from "mqtt";
import { call, route, clientId, DATA_DIR } from "./lg.ts";

const dir = join(DATA_DIR, "lg");
const ROOT_CA_URL = "https://www.amazontrust.com/repository/AmazonRootCA1.pem";

async function ensureCert(): Promise<{ key: string; cert: string; topic: string }> {
  const kf = join(dir, "mqtt.key"), cf = join(dir, "mqtt.crt"), tf = join(dir, "mqtt.topic");
  if (existsSync(kf) && existsSync(cf) && existsSync(tf))
    return { key: readFileSync(kf, "utf8"), cert: readFileSync(cf, "utf8"), topic: readFileSync(tf, "utf8") };
  const reg = await call("POST", "/client", { type: "MQTT", "service-code": "SVC202", "device-type": "607", allowExist: true });
  console.log("client register", reg.status, reg.body?.error ? JSON.stringify(reg.body.error) : "ok");
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = forge.pki.publicKeyFromPem(pubPem);
  csr.setSubject([{ name: "commonName", value: "lg_thinq" }]);
  csr.sign(forge.pki.privateKeyFromPem(keyPem), forge.md.sha512.create());
  const csrB64 = forge.pki.certificationRequestToPem(csr).split("\n").filter((l) => l && !l.startsWith("-----")).join("");
  const cert = await call("POST", "/client/certificate", { "service-code": "SVC202", csr: csrB64 });
  console.log("certificate", cert.status, cert.body?.error ? JSON.stringify(cert.body.error) : "ok");
  const r = cert.body?.response?.result ?? cert.body?.response ?? cert.body?.result;
  if (!r?.certificatePem) throw new Error("sem certificatePem na resposta");
  writeFileSync(kf, keyPem, { mode: 0o600 }); writeFileSync(cf, r.certificatePem, { mode: 0o600 });
  writeFileSync(tf, r.subscriptions[0], { mode: 0o600 });
  return { key: keyPem, cert: r.certificatePem, topic: r.subscriptions[0] };
}

export async function runMqtt(secs: number, outDir: string) {
  const { key, cert, topic } = await ensureCert();
  const ca = await (await fetch(ROOT_CA_URL)).text();
  const rt = await route();
  const server: string = rt.body?.response?.mqttServer ?? rt.body?.mqttServer;
  const wss: string | undefined = rt.body?.response?.webSocketServer ?? rt.body?.webSocketServer;
  console.log("mqtt server", server ? "ok" : "ausente", "wss", wss ? "ok" : "ausente");

  // assina eventos de todos os AC (timer 24h = máx. da doc) e push
  const devs = await call("GET", "/devices");
  const list: any[] = devs.body?.response?.devices ?? devs.body?.response ?? [];
  for (const d of list) {
    const e = await call("POST", `/event/${d.deviceId}/subscribe`, { expire: { unit: "HOUR", timer: 24 } });
    const p = await call("POST", `/push/${d.deviceId}/subscribe`);
    console.log("subscribe event", e.status, e.body?.error?.code ?? "ok", "push", p.status, p.body?.error?.code ?? "ok");
  }

  const url = server; // ex.: mqtts://xxx.iot.us-west-2.amazonaws.com:8883
  const out = join(outDir, "events.jsonl");
  const client = mqtt.connect(url, { clientId: clientId(), key, cert, ca, clean: false, keepalive: 6, reconnectPeriod: 5000, protocolVersion: 4 });
  const stamp = (kind: string, extra: object = {}) => appendFileSync(out, JSON.stringify({ t: Date.now(), kind, ...extra }) + "\n");
  client.on("connect", () => { console.log("MQTT connect"); stamp("connect"); client.subscribe(topic, { qos: 1 }, (err) => console.log("subscribe", err ? String(err) : "ok")); });
  client.on("reconnect", () => stamp("reconnect"));
  client.on("close", () => stamp("close"));
  client.on("error", (e) => { console.log("MQTT error", e.message); stamp("error", { message: e.message }); });
  client.on("message", (t, payload) => { stamp("message", { topic: "<topic>", payload: payload.toString() }); process.stdout.write("."); });
  await new Promise((r) => setTimeout(r, secs * 1000));
  client.end(true);
  console.log(`\nfim; eventos em ${out}`);
}
