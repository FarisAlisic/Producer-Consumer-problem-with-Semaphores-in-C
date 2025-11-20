import express from "express";
import { WebSocketServer } from "ws";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import routes from "./routes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_PORT = 8080;
const FRONTEND_DIR = path.resolve(__dirname, "../frontend");
const BACKEND_EXE  = path.resolve(__dirname, "../backend/demo");

const DEFAULTS = {
  BUF_SIZE: 12,
  PRODUCERS: 3,
  CONSUMERS: 3,
  RUN_SEC: 20,
  SEED: 42,
  SPEED_MS: 600,
  ITEM_TYPES: "milk,bread,eggs,cream"
};

const app = express();
app.use(express.json());
app.use(express.static(FRONTEND_DIR));
routes(app, spawnBackend, getParams, getRecent);

const server = app.listen(DEFAULT_PORT, () =>
  console.log(`Open http://localhost:${DEFAULT_PORT}`)
);
const wss = new WebSocketServer({ server });

let clients = new Set();
wss.on("connection", ws => { clients.add(ws); ws.on("close", () => clients.delete(ws)); });

let child = null;
let rl = null;
let waitStart = new Map(); // key: sem|thr -> ts
let recent = [];           // recent events for /dump
const maxRecent = 2000;

function broadcast(ev) {
  const json = JSON.stringify(ev);
  for (const c of clients) try { c.send(json); } catch {}
  recent.push(ev); if (recent.length > maxRecent) recent.shift();
}

function annotate(ev) {
  if (ev.t === "WAIT_BLOCK" || ev.t === "WAIT_TRY") {
    waitStart.set(`${ev.sem}|${ev.thr}`, ev.ts);
  } else if (ev.t === "WAIT_ACQUIRE") {
    const k = `${ev.sem}|${ev.thr}`;
    const t0 = waitStart.get(k);
    if (t0) { ev.wait_ms = (ev.ts - t0) / 1e6; waitStart.delete(k); }
    else ev.wait_ms = 0;
  }
}

function spawnBackend(params = {}) {
  if (child) child.kill("SIGTERM");

  const env = {
    ...process.env,
    PRODUCERS: String(params.producers ?? DEFAULTS.PRODUCERS),
    CONSUMERS: String(params.consumers ?? DEFAULTS.CONSUMERS),
    RUN_SEC:   String(params.runSec   ?? DEFAULTS.RUN_SEC),
    SEED:      String(params.seed     ?? DEFAULTS.SEED),
    ITEM_TYPES: params.itemTypes || DEFAULTS.ITEM_TYPES,
    SPEED_MS:  String(params.speedMs  ?? DEFAULTS.SPEED_MS)
  };

  const exe = BACKEND_EXE;
  child = spawn(exe, [], { env });

  rl = createInterface({ input: child.stdout });
  rl.on("line", line => {
    try { const ev = JSON.parse(line); annotate(ev); broadcast(ev); }
    catch { /* ignore non-JSON lines */ }
  });
  child.stderr.on("data", d => console.error(String(d)));
  child.on("exit", code => console.log("backend exited:", code));
}

function getParams() {
  return {
    bufSize: DEFAULTS.BUF_SIZE,
    producers: DEFAULTS.PRODUCERS,
    consumers: DEFAULTS.CONSUMERS,
    runSec: DEFAULTS.RUN_SEC,
    seed: DEFAULTS.SEED
  };
}
function getRecent() { return recent; }
