// routes/subscriptions.js
// Gère les abonnements des STB :
//   - Lecture  : GET  /subscriptions          → chaînes autorisées (packs + à-la-carte)
//   - Lecture  : GET  /subscriptions/:stbId   → idem par ID
//   - Écriture : POST /subscriptions/packs    → la STB s'abonne/désabonne d'un pack
//   - Écriture : POST /subscriptions/channels → la STB ajoute/retire une chaîne à-la-carte
//
// Toute modification est écrite dans CLIENTS.json ET broadcastée au dashboard via SSE.

const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const path    = require("path");

const CLIENTS_PATH = path.join(__dirname, "../Data/CLIENTS.json");
const CHAINES_PATH = path.join(__dirname, "../Data/CHAINES.json");

// ── Lecture/écriture dynamique ───────────────────────────────────
function readClients() {
  return JSON.parse(fs.readFileSync(CLIENTS_PATH, "utf8"));
}
function writeClients(data) {
  fs.writeFileSync(CLIENTS_PATH, JSON.stringify(data, null, 2), "utf8");
}
function readChaines() {
  return JSON.parse(fs.readFileSync(CHAINES_PATH, "utf8"));
}

// ── Résolution des chaînes effectives ───────────────────────────
// = union(chaînes de chaque pack souscrit) + chaînes à-la-carte
function resolveChannels(client, chainesJson) {
  const allChannels   = chainesJson.data  || [];
  const allPacks      = chainesJson.packs || [];
  const packsClient   = client.packs         || [];
  const alaCarteNames = client.subscriptions || [];

  const fromPacks = new Set();
  packsClient.forEach(packId => {
    const pack = allPacks.find(p => p.id === packId);
    if (pack) pack.chaines.forEach(name => fromPacks.add(name));
  });

  const allNames = new Set([...fromPacks, ...alaCarteNames]);
  return allChannels.filter(ch => allNames.has(ch.name));
}

// ── Broadcast SSE au dashboard + révocation d'accès ─────────────
function notifyDashboard(clients, revokedUrls = []) {
  try {
    const adminRouter = require("./admin.js");
    if (adminRouter.broadcastSSE) {
      // Met à jour le dashboard
      adminRouter.broadcastSSE({ type: "clients", payload: clients });
      // Si des chaînes ont été retirées, envoie l'événement de révocation
      // → la STB doit arrêter la lecture de ces URLs multicast
      if (revokedUrls.length > 0) {
        adminRouter.broadcastSSE({
          type:    "access_revoked",
          payload: { urls: revokedUrls }
        });
      }
    }
    if (adminRouter.pushLog) {
      const msg = revokedUrls.length > 0
        ? `Abonnements mis à jour · ${revokedUrls.length} chaîne(s) révoquée(s)`
        : "Abonnements mis à jour via STB";
      adminRouter.pushLog("ok", msg);
    }
  } catch (_) {}
}

// ── Calcule les URLs révoquées entre avant/après modification ────
// Retourne les URLs multicast qui étaient accessibles avant
// et ne le sont plus après la modification
function getRevokedUrls(clientBefore, clientAfter, chainesJson) {
  const before = new Set(resolveChannels(clientBefore, chainesJson).map(c => c.multicast.url));
  const after  = new Set(resolveChannels(clientAfter,  chainesJson).map(c => c.multicast.url));
  // URLs présentes avant mais absentes après = révoquées
  return [...before].filter(url => !after.has(url));
}

// ── Réponse standard pour une STB ────────────────────────────────
function buildResponse(subscriber, chainesJson) {
  const channels = resolveChannels(subscriber, chainesJson);
  return {
    stbId:         subscriber.stb_id,
    room:          subscriber.room,
    packs:         subscriber.packs         || [],
    subscriptions: subscriber.subscriptions || [],
    channels,
    channelCount:  channels.length
  };
}

// ════════════════════════════════════════════════════════════════
// GET /subscriptions
// Retourne les chaînes autorisées pour la STB identifiée par certificat
// ════════════════════════════════════════════════════════════════
router.get("/", (req, res) => {
  try {
    const stbId = req.stbId;

    if (!stbId) {
      return res.status(401).json({
        error:   "Non autorisé",
        message: "Certificat client requis"
      });
    }

    const clients    = readClients();
    const subscriber = clients.find(s => s.stb_id === stbId);

    if (!subscriber) {
      return res.status(403).json({ error: "STB inconnue", stbId });
    }

    res.json(buildResponse(subscriber, readChaines()));

  } catch (err) {
    console.error("[ERROR] GET /subscriptions :", err.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ════════════════════════════════════════════════════════════════
// GET /subscriptions/:stbId
// Lecture par ID (admin ou la STB elle-même)
// ════════════════════════════════════════════════════════════════
router.get("/:stbId", (req, res) => {
  try {
    const { stbId } = req.params;

    if (!stbId || typeof stbId !== "string") {
      return res.status(400).json({ error: "ID STB invalide" });
    }

    // Une STB authentifiée ne peut lire que ses propres données
    if (req.stbId && req.stbId !== stbId) {
      return res.status(403).json({
        error:   "Interdit",
        message: "Accès aux données d'une autre STB refusé"
      });
    }

    const clients    = readClients();
    const subscriber = clients.find(s => s.stb_id === stbId);

    if (!subscriber) {
      return res.status(404).json({ error: "STB inconnue : " + stbId });
    }

    res.json(buildResponse(subscriber, readChaines()));

  } catch (err) {
    console.error("[ERROR] GET /subscriptions/:stbId :", err.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ════════════════════════════════════════════════════════════════
// POST /subscriptions/packs
// La STB s'abonne ou se désabonne d'un pack.
//
// Corps JSON :
//   { "action": "add" | "remove", "packId": "info" }
//
// Exemple depuis le Raspberry Pi :
//   curl -k --cert certs/stb-01.crt --key certs/stb-01.key \
//     -X POST https://middleware:3000/subscriptions/packs \
//     -H "Content-Type: application/json" \
//     -d '{"action":"add","packId":"sport"}'
// ════════════════════════════════════════════════════════════════
router.post("/packs", (req, res) => {
  try {
    const stbId = req.stbId;

    if (!stbId) {
      return res.status(401).json({ error: "Certificat client requis" });
    }

    const { action, packId } = req.body;

    if (!action || !packId) {
      return res.status(400).json({
        error:   "Paramètres manquants",
        message: "Corps attendu : { action: 'add'|'remove', packId: 'string' }"
      });
    }

    if (!["add", "remove"].includes(action)) {
      return res.status(400).json({ error: "action doit être 'add' ou 'remove'" });
    }

    // Vérifie que le pack existe dans CHAINES.json
    const chainesJson = readChaines();
    const packExists  = (chainesJson.packs || []).find(p => p.id === packId);

    if (!packExists) {
      return res.status(404).json({ error: "Pack inexistant : " + packId });
    }

    // Met à jour CLIENTS.json
    const clients    = readClients();
    const idx        = clients.findIndex(s => s.stb_id === stbId);

    if (idx === -1) {
      return res.status(403).json({ error: "STB inconnue : " + stbId });
    }

    // Sauvegarde l'état AVANT modification pour calculer les révocations
    const clientBefore = JSON.parse(JSON.stringify(clients[idx]));

    clients[idx].packs = clients[idx].packs || [];

    if (action === "add") {
      if (!clients[idx].packs.includes(packId)) {
        clients[idx].packs.push(packId);
        console.log(`[INFO] STB ${stbId} → ajout pack "${packId}"`);
      }
    } else {
      clients[idx].packs = clients[idx].packs.filter(p => p !== packId);
      console.log(`[INFO] STB ${stbId} → retrait pack "${packId}"`);
    }

    // Calcule les URLs révoquées (chaînes auxquelles la STB n'a plus accès)
    const revokedUrls = getRevokedUrls(clientBefore, clients[idx], chainesJson);
    if (revokedUrls.length > 0) {
      console.log(`[SECURITY] STB ${stbId} → accès révoqué sur ${revokedUrls.length} chaîne(s) : ${revokedUrls.join(", ")}`);
    }

    writeClients(clients);
    notifyDashboard(clients, revokedUrls);

    // Retourne la config complète mise à jour + liste des URLs révoquées
    // → la STB peut arrêter immédiatement la lecture de ces flux
    const response = buildResponse(clients[idx], chainesJson);
    res.json({
      success:      true,
      action,
      packId,
      revokedUrls,  // ← URLs multicast à arrêter côté STB
      ...response
    });

  } catch (err) {
    console.error("[ERROR] POST /subscriptions/packs :", err.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ════════════════════════════════════════════════════════════════
// POST /subscriptions/channels
// La STB ajoute ou retire une chaîne à-la-carte.
//
// Corps JSON :
//   { "action": "add" | "remove", "channelName": "Arte" }
//
// Exemple depuis le Raspberry Pi :
//   curl -k --cert certs/stb-01.crt --key certs/stb-01.key \
//     -X POST https://middleware:3000/subscriptions/channels \
//     -H "Content-Type: application/json" \
//     -d '{"action":"add","channelName":"Arte"}'
// ════════════════════════════════════════════════════════════════
router.post("/channels", (req, res) => {
  try {
    const stbId = req.stbId;

    if (!stbId) {
      return res.status(401).json({ error: "Certificat client requis" });
    }

    const { action, channelName } = req.body;

    if (!action || !channelName) {
      return res.status(400).json({
        error:   "Paramètres manquants",
        message: "Corps attendu : { action: 'add'|'remove', channelName: 'string' }"
      });
    }

    if (!["add", "remove"].includes(action)) {
      return res.status(400).json({ error: "action doit être 'add' ou 'remove'" });
    }

    // Vérifie que la chaîne existe dans CHAINES.json
    const chainesJson   = readChaines();
    const channelExists = (chainesJson.data || []).find(c => c.name === channelName);

    if (!channelExists) {
      return res.status(404).json({ error: "Chaîne inexistante : " + channelName });
    }

    // Met à jour CLIENTS.json
    const clients = readClients();
    const idx     = clients.findIndex(s => s.stb_id === stbId);

    if (idx === -1) {
      return res.status(403).json({ error: "STB inconnue : " + stbId });
    }

    // Sauvegarde l'état AVANT modification
    const clientBefore = JSON.parse(JSON.stringify(clients[idx]));

    clients[idx].subscriptions = clients[idx].subscriptions || [];

    if (action === "add") {
      if (!clients[idx].subscriptions.includes(channelName)) {
        clients[idx].subscriptions.push(channelName);
        console.log(`[INFO] STB ${stbId} → ajout à-la-carte "${channelName}"`);
      }
    } else {
      clients[idx].subscriptions = clients[idx].subscriptions.filter(n => n !== channelName);
      console.log(`[INFO] STB ${stbId} → retrait à-la-carte "${channelName}"`);
    }

    // Calcule les URLs révoquées
    const revokedUrls = getRevokedUrls(clientBefore, clients[idx], chainesJson);
    if (revokedUrls.length > 0) {
      console.log(`[SECURITY] STB ${stbId} → accès révoqué : ${revokedUrls.join(", ")}`);
    }

    writeClients(clients);
    notifyDashboard(clients, revokedUrls);

    const response = buildResponse(clients[idx], chainesJson);
    res.json({
      success:     true,
      action,
      channelName,
      revokedUrls, // ← URLs à arrêter côté STB
      ...response
    });

  } catch (err) {
    console.error("[ERROR] POST /subscriptions/channels :", err.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ════════════════════════════════════════════════════════════════
// DELETE /subscriptions/packs/all
// La STB se désabonne de TOUS ses packs (reset)
// ════════════════════════════════════════════════════════════════
router.delete("/packs/all", (req, res) => {
  try {
    const stbId = req.stbId;
    if (!stbId) return res.status(401).json({ error: "Certificat client requis" });

    const clients = readClients();
    const idx     = clients.findIndex(s => s.stb_id === stbId);
    if (idx === -1) return res.status(403).json({ error: "STB inconnue : " + stbId });

    clients[idx].packs = [];
    writeClients(clients);
    notifyDashboard(clients);
    console.log(`[INFO] STB ${stbId} → tous les packs supprimés`);

    res.json({ success: true, message: "Tous les packs retirés", stbId });

  } catch (err) {
    console.error("[ERROR] DELETE /subscriptions/packs/all :", err.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ════════════════════════════════════════════════════════════════
// DELETE /subscriptions/channels/all
// La STB retire toutes ses chaînes à-la-carte
// ════════════════════════════════════════════════════════════════
router.delete("/channels/all", (req, res) => {
  try {
    const stbId = req.stbId;
    if (!stbId) return res.status(401).json({ error: "Certificat client requis" });

    const clients = readClients();
    const idx     = clients.findIndex(s => s.stb_id === stbId);
    if (idx === -1) return res.status(403).json({ error: "STB inconnue : " + stbId });

    clients[idx].subscriptions = [];
    writeClients(clients);
    notifyDashboard(clients);
    console.log(`[INFO] STB ${stbId} → toutes les chaînes à-la-carte retirées`);

    res.json({ success: true, message: "Toutes les chaînes à-la-carte retirées", stbId });

  } catch (err) {
    console.error("[ERROR] DELETE /subscriptions/channels/all :", err.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

module.exports = router;
