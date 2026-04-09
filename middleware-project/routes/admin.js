// routes/admin.js  — v2 avec gestion des packs
const express  = require("express");
const router   = express.Router();
const fs       = require("fs");
const path     = require("path");
const os       = require("os");
const { execSync } = require("child_process");

const CLIENTS_PATH = path.join(__dirname, "../Data/CLIENTS.json");
const CHAINES_PATH = path.join(__dirname, "../Data/CHAINES.json");

// ── Helpers JSON ────────────────────────────────────────────────
function readClients() { return JSON.parse(fs.readFileSync(CLIENTS_PATH, "utf8")); }
function writeClients(d) { fs.writeFileSync(CLIENTS_PATH, JSON.stringify(d, null, 2), "utf8"); }
function readChaines() { return JSON.parse(fs.readFileSync(CHAINES_PATH, "utf8")); }
function writeChaines(d) { fs.writeFileSync(CHAINES_PATH, JSON.stringify(d, null, 2), "utf8"); }

// ── Résolution : chaînes effectives d'un client ─────────────────
// = union(chaînes de chaque pack souscrit) + subscriptions à-la-carte
function resolveChannels(client, chainesJson) {
  const allChannels   = chainesJson.data  || [];
  const allPacks      = chainesJson.packs || [];
  const packsClient   = client.packs        || [];
  const alaCarteNames = client.subscriptions || [];

  const fromPacks = new Set();
  packsClient.forEach(packId => {
    const pack = allPacks.find(p => p.id === packId);
    if (pack) pack.chaines.forEach(name => fromPacks.add(name));
  });

  const allNames = new Set([...fromPacks, ...alaCarteNames]);
  return allChannels.filter(ch => allNames.has(ch.name));
}

// ── Logs circulaires ─────────────────────────────────────────────
const serverLogs = [];
function pushLog(level, message) {
  serverLogs.unshift({ time: new Date().toLocaleTimeString("fr-FR"), level, message });
  if (serverLogs.length > 200) serverLogs.pop();
  broadcastSSE({ type: "log", payload: serverLogs[0] });
}
router.pushLog = pushLog;

// ── SSE ──────────────────────────────────────────────────────────
const sseClients = new Set();
function broadcastSSE(event) {
  const data = "data: " + JSON.stringify(event) + "\n\n";
  sseClients.forEach(res => { try { res.write(data); } catch (_) { sseClients.delete(res); } });
}
setInterval(() => broadcastSSE({ type: "status", payload: buildStatus() }), 3000);

router.get("/stream", (req, res) => {
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.flushHeaders();
  const chaines = readChaines();
  res.write("data: " + JSON.stringify({ type: "init", payload: {
    status: buildStatus(), logs: serverLogs.slice(0, 50),
    clients: readClients(), chaines
  }}) + "\n\n");
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

// ── Status système ────────────────────────────────────────────────
function buildStatus() {
  const mem = process.memoryUsage();
  const pm2 = !!process.env.pm_id;
  let pm2Info = null;
  if (pm2) {
    try {
      const list = JSON.parse(execSync("pm2 jlist", { timeout: 2000 }).toString());
      const proc = list.find(p => p.pm_id == process.env.pm_id);
      if (proc) pm2Info = { status: proc.pm2_env.status, restarts: proc.pm2_env.restart_time };
    } catch (_) {}
  }
  return {
    middleware: "running", uptime: Math.floor(process.uptime()),
    pid: process.pid, node: process.version, platform: os.platform(), pm2, pm2Info,
    mem: { rss: Math.round(mem.rss/1024/1024), heapUsed: Math.round(mem.heapUsed/1024/1024), heapTotal: Math.round(mem.heapTotal/1024/1024) },
    system: { loadAvg: os.loadavg()[0].toFixed(2), cpus: os.cpus().length, memFree: Math.round(os.freemem()/1024/1024), memTotal: Math.round(os.totalmem()/1024/1024) },
    time: new Date().toISOString()
  };
}

router.get("/status", (req, res) => res.json(buildStatus()));

// ── CLIENTS ───────────────────────────────────────────────────────
router.get("/clients", (req, res) => {
  try { res.json(readClients()); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/clients", (req, res) => {
  const { stb_id, room, packs, subscriptions } = req.body;
  if (!stb_id || !room) return res.status(400).json({ error: "stb_id et room requis" });
  const clients = readClients();
  if (clients.find(c => c.stb_id === stb_id))
    return res.status(409).json({ error: "STB ID déjà existant : " + stb_id });
  const newClient = { room, stb_id, packs: packs || [], subscriptions: subscriptions || [] };
  clients.push(newClient);
  writeClients(clients);
  pushLog("ok", `Nouvel abonné · ${stb_id} · chambre ${room} · packs: [${(packs||[]).join(", ")}]`);
  broadcastSSE({ type: "clients", payload: clients });
  res.status(201).json(newClient);
});

router.put("/clients/:stbId", (req, res) => {
  const { stbId } = req.params;
  const { packs, subscriptions, room } = req.body;
  const clients = readClients();
  const idx = clients.findIndex(c => c.stb_id === stbId);
  if (idx === -1) return res.status(404).json({ error: "STB non trouvée : " + stbId });
  if (packs         !== undefined) clients[idx].packs         = packs;
  if (subscriptions !== undefined) clients[idx].subscriptions = subscriptions;
  if (room          !== undefined) clients[idx].room          = room;
  writeClients(clients);
  pushLog("ok", `Abonné mis à jour · ${stbId} · packs: [${clients[idx].packs.join(", ")}]`);
  broadcastSSE({ type: "clients", payload: clients });
  res.json(clients[idx]);
});

router.delete("/clients/:stbId", (req, res) => {
  const { stbId } = req.params;
  let clients = readClients();
  const before = clients.length;
  clients = clients.filter(c => c.stb_id !== stbId);
  if (clients.length === before) return res.status(404).json({ error: "STB non trouvée : " + stbId });
  writeClients(clients);
  pushLog("warn", `Abonné supprimé · ${stbId}`);
  broadcastSSE({ type: "clients", payload: clients });
  res.json({ ok: true });
});

// Chaînes effectives d'un abonné (pour STB / App Python)
router.get("/clients/:stbId/channels", (req, res) => {
  const { stbId } = req.params;
  const client = readClients().find(c => c.stb_id === stbId);
  if (!client) return res.status(404).json({ error: "STB non trouvée : " + stbId });
  const chaines  = readChaines();
  const resolved = resolveChannels(client, chaines);
  res.json({ stb_id: client.stb_id, room: client.room, packs: client.packs, subscriptions: client.subscriptions, channels: resolved });
});

// ── CHAINES ───────────────────────────────────────────────────────
router.get("/chaines", (req, res) => {
  try { res.json(readChaines()); } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PACKS ─────────────────────────────────────────────────────────
router.get("/packs", (req, res) => {
  try { res.json(readChaines().packs || []); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/packs", (req, res) => {
  const { id, nom, description, couleur, chaines } = req.body;
  if (!id || !nom) return res.status(400).json({ error: "id et nom requis" });
  const json = readChaines();
  json.packs = json.packs || [];
  if (json.packs.find(p => p.id === id))
    return res.status(409).json({ error: "Pack déjà existant : " + id });
  const newPack = { id, nom, description: description || "", couleur: couleur || "#6b7080", chaines: chaines || [] };
  json.packs.push(newPack);
  writeChaines(json);
  pushLog("ok", `Nouveau pack · ${id} · "${nom}" · ${(chaines||[]).length} chaînes`);
  broadcastSSE({ type: "chaines", payload: json });
  res.status(201).json(newPack);
});

router.put("/packs/:packId", (req, res) => {
  const { packId } = req.params;
  const { nom, description, couleur, chaines } = req.body;
  const json = readChaines();
  const idx  = (json.packs || []).findIndex(p => p.id === packId);
  if (idx === -1) return res.status(404).json({ error: "Pack non trouvé : " + packId });
  if (nom         !== undefined) json.packs[idx].nom         = nom;
  if (description !== undefined) json.packs[idx].description = description;
  if (couleur     !== undefined) json.packs[idx].couleur     = couleur;
  if (chaines     !== undefined) json.packs[idx].chaines     = chaines;
  writeChaines(json);
  pushLog("ok", `Pack modifié · ${packId} · ${json.packs[idx].chaines.length} chaînes`);
  broadcastSSE({ type: "chaines", payload: json });
  res.json(json.packs[idx]);
});

router.delete("/packs/:packId", (req, res) => {
  const { packId } = req.params;
  const json = readChaines();
  const before = (json.packs || []).length;
  json.packs = (json.packs || []).filter(p => p.id !== packId);
  if (json.packs.length === before) return res.status(404).json({ error: "Pack non trouvé : " + packId });
  // Retire ce pack de tous les abonnés
  const clients = readClients();
  let modified = false;
  clients.forEach(c => {
    if ((c.packs || []).includes(packId)) { c.packs = c.packs.filter(p => p !== packId); modified = true; }
  });
  if (modified) { writeClients(clients); broadcastSSE({ type: "clients", payload: clients }); }
  writeChaines(json);
  pushLog("warn", `Pack supprimé · ${packId}`);
  broadcastSSE({ type: "chaines", payload: json });
  res.json({ ok: true });
});

// ── Sync streamer → POST /admin/chaines/sync ─────────────────────
router.post("/chaines/sync", (req, res) => {
  const { data } = req.body;
  if (!Array.isArray(data)) return res.status(400).json({ error: "data[] requis" });
  const json = readChaines();
  json.data = data.map(inc => {
    const ex = (json.data || []).find(c => c.id === inc.id);
    return { ...inc, pack: ex ? ex.pack : "divertissement" };
  });
  json.count = json.data.length;
  writeChaines(json);
  pushLog("ok", `Sync streamer · ${json.data.length} chaînes`);
  broadcastSSE({ type: "chaines", payload: json });
  res.json({ ok: true, count: json.data.length });
});

// ── Logs + redémarrage ────────────────────────────────────────────
router.get("/logs", (req, res) => res.json(serverLogs));

router.post("/restart", (req, res) => {
  pushLog("warn", "Redémarrage demandé depuis le dashboard");
  broadcastSSE({ type: "restarting" });
  res.json({ ok: true });
  setTimeout(() => {
    if (process.env.pm_id !== undefined) { try { execSync("pm2 reload " + process.env.pm_id); } catch (_) {} }
    process.exit(0);
  }, 300);
});

module.exports = router;
