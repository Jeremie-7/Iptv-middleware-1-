// routes/admin.js  — v2 avec gestion des packs
const express  = require("express");
const router   = express.Router();
const fs       = require("fs");
const path     = require("path");
const os       = require("os");
const crypto   = require("crypto");
const { execSync } = require("child_process");

const CLIENTS_PATH     = path.join(__dirname, "../Data/CLIENTS.json");
const CHAINES_PATH     = path.join(__dirname, "../Data/CHAINES.json");
const CREDENTIALS_PATH = path.join(__dirname, "../Data/admin-credentials.json");

// ── Helpers JSON ────────────────────────────────────────────────
function readClients() { return JSON.parse(fs.readFileSync(CLIENTS_PATH, "utf8")); }
function writeClients(d) { fs.writeFileSync(CLIENTS_PATH, JSON.stringify(d, null, 2), "utf8"); }
function readChaines() { return JSON.parse(fs.readFileSync(CHAINES_PATH, "utf8")); }
function writeChaines(d) { fs.writeFileSync(CHAINES_PATH, JSON.stringify(d, null, 2), "utf8"); }
function readCredentials() {
  try { return JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8")); }
  catch (_) { return { admins: [] }; }
}

// ══════════════════════════════════════════════════════════════
// GESTION DES SESSIONS ADMIN
// Tokens stockés en mémoire — expiration 8h
// ══════════════════════════════════════════════════════════════
const adminSessions = new Map(); // token → { username, role, expires }
const SESSION_DURATION = 8 * 60 * 60 * 1000; // 8 heures en ms

function createSession(username, role) {
  const token   = crypto.randomBytes(32).toString("hex");
  const expires = Date.now() + SESSION_DURATION;
  adminSessions.set(token, { username, role, expires });
  return token;
}

function validateToken(token) {
  if (!token) return null;
  const session = adminSessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expires) {
    adminSessions.delete(token);
    return null;
  }
  return session;
}
//
// Nettoyage automatique des sessions expirées toutes les heures
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of adminSessions.entries()) {
    if (now > session.expires) adminSessions.delete(token);
  }
}, 60 * 60 * 1000);

// ── Middleware de protection des routes admin ────────────────
// S'applique à TOUTES les routes sauf /auth/login et /auth/verify
function requireAdminAuth(req, res, next) {
  // Routes publiques — pas besoin de token
  // const publicRoutes = ["/auth/login", "/auth/verify"];
  const publicRoutes = ["/auth/login", "/auth/verify", "/packs", "/chaines/sync", "/register", "/login"];
  if (publicRoutes.some(r => req.path.startsWith(r))) return next();

  // Lecture du token depuis le header Authorization
  const authHeader = req.headers["authorization"] || "";
  const token      = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : req.query.token; // fallback via query string pour SSE

  const session = validateToken(token);
  if (!session) {
    // Requête navigateur → redirige vers login
    const accept = req.headers["accept"] || "";
    if (accept.includes("text/html")) {
      return res.redirect("/login.html");
    }
    return res.status(401).json({ error: "Non authentifié — accès dashboard refusé" });
  }

  // Injecte les infos admin dans la requête
  req.adminUser = session.username;
  req.adminRole = session.role;
  next();
}

// Applique le middleware à tout le router admin
router.use(requireAdminAuth);

// ══════════════════════════════════════════════════════════════
// POST /admin/auth/login
// Connexion admin depuis login.html
// Corps : { username, password }
// ══════════════════════════════════════════════════════════════
router.post("/auth/login", (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: "Identifiant et mot de passe requis" });
  }

  const creds = readCredentials();
  const admin = (creds.admins || []).find(
    a => a.username.toLowerCase() === username.toLowerCase()
  );

  if (!admin) {
    return res.status(401).json({ error: "Identifiant ou mot de passe incorrect" });
  }

  // Hash SHA-256 du mot de passe
  const hash = crypto.createHash("sha256").update(password).digest("hex");
  if (hash !== admin.password_hash) {
    pushLog("warn", `Tentative de connexion échouée · utilisateur : ${username}`);
    return res.status(401).json({ error: "Identifiant ou mot de passe incorrect" });
  }

  const token = createSession(admin.username, admin.role);
  pushLog("ok", `Connexion admin · ${admin.username}`);

  res.json({
    success:  true,
    token,
    username: admin.username,
    role:     admin.role,
    expires:  new Date(Date.now() + SESSION_DURATION).toISOString(),
  });
});


// router.post("/login", (req, res) => {
//   try {
//     const { identifiant, password } = req.body;
//     if (!identifiant || !password)
//       return res.status(400).json({ error: "Identifiant et mot de passe requis" });

//     const clients = readClients();
//     const client  = clients.find(
//       c => c.stb_id.toLowerCase() === identifiant.trim().toLowerCase()
//     );
//     if (!client)
//       return res.status(401).json({ error: "Identifiant ou mot de passe incorrect" });

//     // Si pas de password_hash → client créé manuellement (stb-01, Pythonapp...)
//     // On accepte n'importe quel mot de passe non vide (usage interne)
//     if (client.password_hash) {
//       const crypto = require("crypto");
//       const hash   = crypto.createHash("sha256")
//         .update(password + identifiant.trim()).digest("hex");
//       if (hash !== client.password_hash)
//         return res.status(401).json({ error: "Identifiant ou mot de passe incorrect" });
//     }

//     const chainesJson = readChaines();
//     const channels    = resolveChannels(client, chainesJson);
//     pushLog("ok", `Connexion client · ${identifiant}`);

//     res.json({
//       success: true, stbId: client.stb_id, room: client.room,
//       packs: client.packs || [], subscriptions: client.subscriptions || [],
//       channels, channelCount: channels.length,
//     });
//   } catch(err) {
//     res.status(500).json({ error: "Erreur serveur" });
//   }
// });

// ══════════════════════════════════════════════════════════════
// GET /admin/auth/verify
// Vérifie si un token est encore valide (appelé par login.html)
// ══════════════════════════════════════════════════════════════
router.get("/auth/verify", (req, res) => {
  const authHeader = req.headers["authorization"] || "";
  const token      = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const session    = validateToken(token);

  if (!session) return res.status(401).json({ valid: false });
  res.json({ valid: true, username: session.username, role: session.role });
});

// ══════════════════════════════════════════════════════════════
// POST /admin/auth/logout
// Révoque le token de la session courante
// ══════════════════════════════════════════════════════════════
router.post("/auth/logout", (req, res) => {
  const authHeader = req.headers["authorization"] || "";
  const token      = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (token) {
    const session = adminSessions.get(token);
    if (session) pushLog("ok", `Déconnexion admin · ${session.username}`);
    adminSessions.delete(token);
  }
  res.json({ success: true });
});


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
// Exposé pour que subscriptions.js puisse notifier le dashboard
router.broadcastSSE = broadcastSSE;
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
// Les chaînes déjà connues conservent leur pack.
// Les nouvelles chaînes sont automatiquement placées dans le pack "nouveautes".
// Le pack "Nouveautés" est créé automatiquement s'il n'existe pas.
router.post("/chaines/sync", (req, res) => {
  const { data } = req.body;
  if (!Array.isArray(data)) return res.status(400).json({ error: "data[] requis" });

  const json      = readChaines();
  const existing  = json.data  || [];
  const packs     = json.packs || [];

  // Crée le pack "Nouveautés" s'il n'existe pas encore
  const NOUVEAUTES_ID = "nouveautes";
  if (!packs.find(p => p.id === NOUVEAUTES_ID)) {
    packs.push({
      id:          NOUVEAUTES_ID,
      nom:         "Nouveautés",
      description: "Chaînes récemment détectées par le streamer",
      couleur:     "#22d3a0",
      chaines:     []
    });
    pushLog("ok", "Pack Nouveautés créé automatiquement");
  }

  const nouveautePack = packs.find(p => p.id === NOUVEAUTES_ID);
  const newChannelNames = [];

  // Mappe les chaînes reçues
  json.data = data.map(inc => {
    const ex = existing.find(c => c.id === inc.id);
    if (ex) {
      // Chaîne déjà connue → conserve son pack
      return { ...inc, pack: ex.pack };
    } else {
      // Nouvelle chaîne → pack "nouveautes"
      newChannelNames.push(inc.name);
      return { ...inc, pack: NOUVEAUTES_ID };
    }
  });

  // Met à jour la liste des chaînes dans le pack Nouveautés
  // (ajoute les nouvelles, retire celles qui ne sont plus diffusées)
  const allNewIds = new Set(data.map(c => c.id));
  nouveautePack.chaines = [
    // Garde les anciennes nouveautés encore diffusées
    ...nouveautePack.chaines.filter(name =>
      json.data.find(ch => ch.name === name && ch.pack === NOUVEAUTES_ID)
    ),
    // Ajoute les vraiment nouvelles
    ...newChannelNames.filter(n => !nouveautePack.chaines.includes(n))
  ];

  json.packs = packs;
  json.count = json.data.length;

  writeChaines(json);

  if (newChannelNames.length > 0) {
    pushLog("ok", `Sync streamer · ${json.data.length} chaînes · ${newChannelNames.length} nouvelle(s) → Nouveautés : ${newChannelNames.join(", ")}`);
  } else {
    pushLog("ok", `Sync streamer · ${json.data.length} chaînes · aucune nouveauté`);
  }

  broadcastSSE({ type: "chaines", payload: json });
  res.json({
    ok:           true,
    count:        json.data.length,
    newChannels:  newChannelNames.length,
    newNames:     newChannelNames
  });
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

// ══════════════════════════════════════════════════════════════
// POST /register
// Inscription d'un nouvel abonné depuis pageAbonnee.html

// Corps JSON :
//   { identifiant, password, room, packId }

// - Vérifie que l'identifiant n'est pas déjà pris
// - Vérifie que le pack existe
// - Hash le mot de passe (simple SHA-256, pas de bcrypt pour éviter les dépendances)
// - Crée l'entrée dans CLIENTS.json
// - Broadcast SSE au dashboard
// ══════════════════════════════════════════════════════════════
router.post("/register", (req, res) => {
  try {
    const { identifiant, password, room, packId, packs: packsArr } = req.body;

    // ── Validations ──────────────────────────────────────────
    if (!identifiant || identifiant.trim().length < 3) {
      return res.status(400).json({ error: "Identifiant trop court (minimum 3 caractères)" });
    }
    if (!password || password.length < 6) {
      return res.status(400).json({ error: "Mot de passe trop court (minimum 6 caractères)" });
    }
    if (!room) {
      return res.status(400).json({ error: "Numéro de chambre requis" });
    }

    // Accepte soit un tableau de packs soit un seul packId
    const chosenPacks = Array.isArray(packsArr) && packsArr.length > 0
      ? packsArr
      : (packId ? [packId] : []);

    if (!chosenPacks.length) {
      return res.status(400).json({ error: "Sélection d'au moins un abonnement requise" });
    }

    // ── Vérifie que tous les packs existent ──────────────────
    const chainesJson = readChaines();
    for (const pid of chosenPacks) {
      const packExists = (chainesJson.packs || []).find(p => p.id === pid);
      if (!packExists) return res.status(404).json({ error: "Pack inexistant : " + pid });
    }
    const firstPack = (chainesJson.packs || []).find(p => p.id === chosenPacks[0]);

    // ── Vérifie que l'identifiant n'est pas déjà pris ────────
    const clients = readClients();
    const idLower = identifiant.trim().toLowerCase();
    const exists  = clients.find(c => c.stb_id.toLowerCase() === idLower);
    if (exists) {
      return res.status(409).json({ error: "Cet identifiant est déjà utilisé" });
    }

    // ── Hash du mot de passe (crypto natif Node.js) ───────────
    // On utilise le module natif crypto pour éviter d'ajouter bcrypt
    const crypto = require("crypto");
    const passwordHash = crypto
      .createHash("sha256")
      .update(password + identifiant) // sel = identifiant (simple mais suffisant)
      .digest("hex");

    // ── Création de l'abonné ─────────────────────────────────
    const newClient = {
      stb_id:        identifiant.trim(),
      room:          String(room),
      password_hash: passwordHash,
      packs:         chosenPacks,
      subscriptions: [],
      registered_at: new Date().toISOString(),
    };

    clients.push(newClient);
    writeClients(clients);

    const channels = resolveChannels(newClient, chainesJson);

    pushLog("ok", `Nouvel abonné inscrit · ${identifiant} · chambre ${room} · packs : ${chosenPacks.join(', ')}`);
    broadcastSSE({ type: "clients", payload: clients });

    res.status(201).json({
      success:      true,
      stbId:        newClient.stb_id,
      room:         newClient.room,
      packs:        chosenPacks,
      pack:         firstPack ? firstPack.nom : chosenPacks[0],
      channelCount: channels.length,
    });

  } catch (err) {
    console.error("[ERROR] POST /register :", err.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ══════════════════════════════════════════════════════════════
// POST /login
// Authentification par identifiant + mot de passe
// Alternative à la STB qui utilise son certificat TLS

// Corps JSON :
//   { identifiant, password }

// Retourne la même réponse que GET /auth/me
// ══════════════════════════════════════════════════════════════
router.post("/login", (req, res) => {
  try {
    const { identifiant, password } = req.body;

    if (!identifiant || !password) {
      return res.status(400).json({ error: "Identifiant et mot de passe requis" });
    }

    const clients   = readClients();
    const client    = clients.find(c => c.stb_id.toLowerCase() === identifiant.trim().toLowerCase());

    if (!client) {
      return res.status(401).json({ error: "Identifiant ou mot de passe incorrect" });
    }

    // ── Vérifie le mot de passe ───────────────────────────────
    if (!client.password_hash) {
      // Client créé manuellement depuis le dashboard (pas de mot de passe)
      return res.status(401).json({ error: "Ce compte n'a pas de mot de passe — utilisez votre certificat TLS" });
    }

    const crypto = require("crypto");
    const hash   = crypto
      .createHash("sha256")
      .update(password + identifiant.trim())
      .digest("hex");

    if (hash !== client.password_hash) {
      return res.status(401).json({ error: "Identifiant ou mot de passe incorrect" });
    }

    // ── Retourne la config complète (même format que /auth/me) ─
    const chainesJson = readChaines();
    const channels    = resolveChannels(client, chainesJson);

    pushLog("ok", `Connexion par mot de passe · ${identifiant}`);

    res.json({
      success:       true,
      stbId:         client.stb_id,
      room:          client.room,
      packs:         client.packs         || [],
      subscriptions: client.subscriptions || [],
      channels,
      channelCount:  channels.length,
    });

  } catch (err) {
    console.error("[ERROR] POST /login :", err.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

module.exports = router;


// Ancienne version
// // routes/admin.js  — v2 avec gestion des packs
// const express  = require("express");
// const router   = express.Router();
// const fs       = require("fs");
// const path     = require("path");
// const os       = require("os");
// const { execSync } = require("child_process");

// const CLIENTS_PATH = path.join(__dirname, "../Data/CLIENTS.json");
// const CHAINES_PATH = path.join(__dirname, "../Data/CHAINES.json");

// // ── Helpers JSON -------------------------------------------------------------------------------------------------
// function readClients() { return JSON.parse(fs.readFileSync(CLIENTS_PATH, "utf8")); }
// function writeClients(d) { fs.writeFileSync(CLIENTS_PATH, JSON.stringify(d, null, 2), "utf8"); }
// function readChaines() { return JSON.parse(fs.readFileSync(CHAINES_PATH, "utf8")); }
// function writeChaines(d) { fs.writeFileSync(CHAINES_PATH, JSON.stringify(d, null, 2), "utf8"); }

// // ── Résolution : chaînes effectives d'un client --------------------------------------------------------------------
// // = union(chaînes de chaque pack souscrit) + subscriptions à-la-carte
// function resolveChannels(client, chainesJson) {
//   const allChannels   = chainesJson.data  || [];
//   const allPacks      = chainesJson.packs || [];
//   const packsClient   = client.packs        || [];
//   const alaCarteNames = client.subscriptions || [];

//   const fromPacks = new Set();
//   packsClient.forEach(packId => {
//     const pack = allPacks.find(p => p.id === packId);
//     if (pack) pack.chaines.forEach(name => fromPacks.add(name));
//   });

//   const allNames = new Set([...fromPacks, ...alaCarteNames]);
//   return allChannels.filter(ch => allNames.has(ch.name));
// }

// // ── Logs circulaires ------------------------------------------------------------------------------------------
// const serverLogs = [];
// function pushLog(level, message) {
//   serverLogs.unshift({ time: new Date().toLocaleTimeString("fr-FR"), level, message });
//   if (serverLogs.length > 200) serverLogs.pop();
//   broadcastSSE({ type: "log", payload: serverLogs[0] });
// }
// router.pushLog = pushLog;

// // ── SSE ---------------------------------------------------------------------------------------------
// const sseClients = new Set();
// function broadcastSSE(event) {
//   const data = "data: " + JSON.stringify(event) + "\n\n";
//   sseClients.forEach(res => { try { res.write(data); } catch (_) { sseClients.delete(res); } });
// }
// // Exposé pour que subscriptions.js puisse notifier le dashboard
// router.broadcastSSE = broadcastSSE;
// setInterval(() => broadcastSSE({ type: "status", payload: buildStatus() }), 3000);

// router.get("/stream", (req, res) => {
//   res.setHeader("Content-Type",  "text/event-stream");
//   res.setHeader("Cache-Control", "no-cache");
//   res.setHeader("Connection",    "keep-alive");
//   res.flushHeaders();
//   const chaines = readChaines();
//   res.write("data: " + JSON.stringify({ type: "init", payload: {
//     status: buildStatus(), logs: serverLogs.slice(0, 50),
//     clients: readClients(), chaines
//   }}) + "\n\n");
//   sseClients.add(res);
//   req.on("close", () => sseClients.delete(res));
// });

// // ── Status système ...................................!....................................................
// function buildStatus() {
//   const mem = process.memoryUsage();
//   const pm2 = !!process.env.pm_id;
//   let pm2Info = null;
//   if (pm2) {
//     try {
//       const list = JSON.parse(execSync("pm2 jlist", { timeout: 2000 }).toString());
//       const proc = list.find(p => p.pm_id == process.env.pm_id);
//       if (proc) pm2Info = { status: proc.pm2_env.status, restarts: proc.pm2_env.restart_time };
//     } catch (_) {}
//   }
//   return {
//     middleware: "running", uptime: Math.floor(process.uptime()),
//     pid: process.pid, node: process.version, platform: os.platform(), pm2, pm2Info,
//     mem: { rss: Math.round(mem.rss/1024/1024), heapUsed: Math.round(mem.heapUsed/1024/1024), heapTotal: Math.round(mem.heapTotal/1024/1024) },
//     system: { loadAvg: os.loadavg()[0].toFixed(2), cpus: os.cpus().length, memFree: Math.round(os.freemem()/1024/1024), memTotal: Math.round(os.totalmem()/1024/1024) },
//     time: new Date().toISOString()
//   };
// }

// router.get("/status", (req, res) => res.json(buildStatus()));

// // ── CLIENTS ----------------------------------------------------------------------------------------------------------------
// router.get("/clients", (req, res) => {
//   try { res.json(readClients()); } catch (e) { res.status(500).json({ error: e.message }); }
// });

// router.post("/clients", (req, res) => {
//   const { stb_id, room, packs, subscriptions } = req.body;
//   if (!stb_id || !room) return res.status(400).json({ error: "stb_id et room requis" });
//   const clients = readClients();
//   if (clients.find(c => c.stb_id === stb_id))
//     return res.status(409).json({ error: "STB ID déjà existant : " + stb_id });
//   const newClient = { room, stb_id, packs: packs || [], subscriptions: subscriptions || [] };
//   clients.push(newClient);
//   writeClients(clients);
//   pushLog("ok", `Nouvel abonné · ${stb_id} · chambre ${room} · packs: [${(packs||[]).join(", ")}]`);
//   broadcastSSE({ type: "clients", payload: clients });
//   res.status(201).json(newClient);
// });

// router.put("/clients/:stbId", (req, res) => {
//   const { stbId } = req.params;
//   const { packs, subscriptions, room } = req.body;
//   const clients = readClients();
//   const idx = clients.findIndex(c => c.stb_id === stbId);
//   if (idx === -1) return res.status(404).json({ error: "STB non trouvée : " + stbId });
//   if (packs         !== undefined) clients[idx].packs         = packs;
//   if (subscriptions !== undefined) clients[idx].subscriptions = subscriptions;
//   if (room          !== undefined) clients[idx].room          = room;
//   writeClients(clients);
//   pushLog("ok", `Abonné mis à jour · ${stbId} · packs: [${clients[idx].packs.join(", ")}]`);
//   broadcastSSE({ type: "clients", payload: clients });
//   res.json(clients[idx]);
// });

// router.delete("/clients/:stbId", (req, res) => {
//   const { stbId } = req.params;
//   let clients = readClients();
//   const before = clients.length;
//   clients = clients.filter(c => c.stb_id !== stbId);
//   if (clients.length === before) return res.status(404).json({ error: "STB non trouvée : " + stbId });
//   writeClients(clients);
//   pushLog("warn", `Abonné supprimé · ${stbId}`);
//   broadcastSSE({ type: "clients", payload: clients });
//   res.json({ ok: true });
// });

// // Chaînes effectives d'un abonné (pour STB / App Python)
// router.get("/clients/:stbId/channels", (req, res) => {
//   const { stbId } = req.params;
//   const client = readClients().find(c => c.stb_id === stbId);
//   if (!client) return res.status(404).json({ error: "STB non trouvée : " + stbId });
//   const chaines  = readChaines();
//   const resolved = resolveChannels(client, chaines);
//   res.json({ stb_id: client.stb_id, room: client.room, packs: client.packs, subscriptions: client.subscriptions, channels: resolved });
// });

// // ── CHAINES -----------------------------------------------------------------------------------------------------
// router.get("/chaines", (req, res) => {
//   try { res.json(readChaines()); } catch (e) { res.status(500).json({ error: e.message }); }
// });

// // ── PACKS------------------------------------------------------------------------------------------------------
// router.get("/packs", (req, res) => {
//   try { res.json(readChaines().packs || []); } catch (e) { res.status(500).json({ error: e.message }); }
// });

// router.post("/packs", (req, res) => {
//   const { id, nom, description, couleur, chaines } = req.body;
//   if (!id || !nom) return res.status(400).json({ error: "id et nom requis" });
//   const json = readChaines();
//   json.packs = json.packs || [];
//   if (json.packs.find(p => p.id === id))
//     return res.status(409).json({ error: "Pack déjà existant : " + id });
//   const newPack = { id, nom, description: description || "", couleur: couleur || "#6b7080", chaines: chaines || [] };
//   json.packs.push(newPack);
//   writeChaines(json);
//   pushLog("ok", `Nouveau pack · ${id} · "${nom}" · ${(chaines||[]).length} chaînes`);
//   broadcastSSE({ type: "chaines", payload: json });
//   res.status(201).json(newPack);
// });

// router.put("/packs/:packId", (req, res) => {
//   const { packId } = req.params;
//   const { nom, description, couleur, chaines } = req.body;
//   const json = readChaines();
//   const idx  = (json.packs || []).findIndex(p => p.id === packId);
//   if (idx === -1) return res.status(404).json({ error: "Pack non trouvé : " + packId });
//   if (nom         !== undefined) json.packs[idx].nom         = nom;
//   if (description !== undefined) json.packs[idx].description = description;
//   if (couleur     !== undefined) json.packs[idx].couleur     = couleur;
//   if (chaines     !== undefined) json.packs[idx].chaines     = chaines;
//   writeChaines(json);
//   pushLog("ok", `Pack modifié · ${packId} · ${json.packs[idx].chaines.length} chaînes`);
//   broadcastSSE({ type: "chaines", payload: json });
//   res.json(json.packs[idx]);
// });

// router.delete("/packs/:packId", (req, res) => {
//   const { packId } = req.params;
//   const json = readChaines();
//   const before = (json.packs || []).length;
//   json.packs = (json.packs || []).filter(p => p.id !== packId);
//   if (json.packs.length === before) return res.status(404).json({ error: "Pack non trouvé : " + packId });
//   // Retire ce pack de tous les abonnés
//   const clients = readClients();
//   let modified = false;
//   clients.forEach(c => {
//     if ((c.packs || []).includes(packId)) { c.packs = c.packs.filter(p => p !== packId); modified = true; }
//   });
//   if (modified) { writeClients(clients); broadcastSSE({ type: "clients", payload: clients }); }
//   writeChaines(json);
//   pushLog("warn", `Pack supprimé · ${packId}`);
//   broadcastSSE({ type: "chaines", payload: json });
//   res.json({ ok: true });
// });

// // ── Sync streamer → POST /admin/chaines/sync-------------------------------------------------------------
// // Les chaînes déjà connues conservent leur pack.
// // Les nouvelles chaînes sont automatiquement placées dans le pack "nouveautes". Et si le client veut changer son abonnement il peut ajouter les nouvelles chaines a la carte
// // Le pack "Nouveautés" est créé automatiquement s'il n'existe pas.
// router.post("/chaines/sync", (req, res) => {
//   const { data } = req.body;
//   if (!Array.isArray(data)) return res.status(400).json({ error: "data[] requis" });

//   const json      = readChaines();
//   const existing  = json.data  || [];
//   const packs     = json.packs || [];

//   // Crée le pack "Nouveautés" s'il n'existe pas encore
//   const NOUVEAUTES_ID = "nouveautes";
//   if (!packs.find(p => p.id === NOUVEAUTES_ID)) {
//     packs.push({
//       id:          NOUVEAUTES_ID,
//       nom:         "Nouveautés",
//       description: "Chaînes récemment détectées par le streamer",
//       couleur:     "#22d3a0",
//       chaines:     []
//     });
//     pushLog("ok", "Pack Nouveautés créé automatiquement");
//   }

//   const nouveautePack = packs.find(p => p.id === NOUVEAUTES_ID);
//   const newChannelNames = [];

//   // Mappe les chaînes reçues
//   json.data = data.map(inc => {
//     const ex = existing.find(c => c.id === inc.id);
//     if (ex) {
//       // Chaîne déjà connue → conserve son pack
//       return { ...inc, pack: ex.pack };
//     } else {
//       // Nouvelle chaîne → pack "nouveautes"
//       newChannelNames.push(inc.name);
//       return { ...inc, pack: NOUVEAUTES_ID };
//     }
//   });

//   // Met à jour la liste des chaînes dans le pack Nouveautés
//   // (ajoute les nouvelles, retire celles qui ne sont plus diffusées)
//   const allNewIds = new Set(data.map(c => c.id));
//   nouveautePack.chaines = [
//     // Garde les anciennes nouveautés encore diffusées
//     ...nouveautePack.chaines.filter(name =>
//       json.data.find(ch => ch.name === name && ch.pack === NOUVEAUTES_ID)
//     ),
//     // Ajoute les vraiment nouvelles
//     ...newChannelNames.filter(n => !nouveautePack.chaines.includes(n))
//   ];

//   json.packs = packs;
//   json.count = json.data.length;

//   writeChaines(json);

//   if (newChannelNames.length > 0) {
//     pushLog("ok", `Sync streamer · ${json.data.length} chaînes · ${newChannelNames.length} nouvelle(s) → Nouveautés : ${newChannelNames.join(", ")}`);
//   } else {
//     pushLog("ok", `Sync streamer · ${json.data.length} chaînes · aucune nouveauté`);
//   }

//   broadcastSSE({ type: "chaines", payload: json });
//   res.json({
//     ok:           true,
//     count:        json.data.length,
//     newChannels:  newChannelNames.length,
//     newNames:     newChannelNames
//   });
// });

// // ── Logs + redémarrage ------------------------------------------------------------------------------------
// router.get("/logs", (req, res) => res.json(serverLogs));

// router.post("/restart", (req, res) => {
//   pushLog("warn", "Redémarrage demandé depuis le dashboard");
//   broadcastSSE({ type: "restarting" });
//   res.json({ ok: true });
//   setTimeout(() => {
//     if (process.env.pm_id !== undefined) { try { execSync("pm2 reload " + process.env.pm_id); } catch (_) {} }
//     process.exit(0);
//   }, 300);
// });

// module.exports = router;

// // Pour que les clients ( stb puisse se connecter et choisisr ses abonnement)
// router.post("/register", (req, res) => {
//   const { identifiant, password, packId } = req.body;
//   // Crée l'abonné dans CLIENTS.json
//   // Hash le mot de passe avant de le stocker
//   // Broadcast SSE au dashboard
// });
// // Pour que l'admin  puisse se connecter sur le dashboardadministrateur

// router.post("/login", (req, res) => {
//   const { identifiant, password } = req.body;
//   // Vérifie le hash bcrypt
//   // Retourne la liste des chaînes si OK
// });
