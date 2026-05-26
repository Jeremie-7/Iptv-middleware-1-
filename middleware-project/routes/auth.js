// routes/auth.js
// Gère l'authentification des STB par certificat TLS (CN = stb-xx)
// et retourne leur configuration complète (packs + chaînes effectives)

const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const path    = require("path");

const CLIENTS_PATH = path.join(__dirname, "../Data/CLIENTS.json");
const CHAINES_PATH = path.join(__dirname, "../Data/CHAINES.json");

// ── Lecture dynamique des fichiers ──────────────────────────────
// fs.readFileSync relit le fichier à chaque requête = toujours à jour
// contrairement à require() qui met le JSON en cache mémoire
function readClients() {
  return JSON.parse(fs.readFileSync(CLIENTS_PATH, "utf8"));
}
function readChaines() {
  return JSON.parse(fs.readFileSync(CHAINES_PATH, "utf8"));
}

// ── Calcule les chaînes effectives d'un abonné ──────────────────
// = union(chaînes de chaque pack souscrit) + chaînes à-la-carte
function resolveChannels(client, chainesJson) {
  const allChannels   = chainesJson.data  || [];
  const allPacks      = chainesJson.packs || [];
  const packsClient   = client.packs         || [];
  const alaCarteNames = client.subscriptions || [];

  // Noms de chaînes apportés par les packs souscrits
  const fromPacks = new Set();
  packsClient.forEach(packId => {
    const pack = allPacks.find(p => p.id === packId);
    if (pack) pack.chaines.forEach(name => fromPacks.add(name));
  });

  // Union avec les à-la-carte
  const allNames = new Set([...fromPacks, ...alaCarteNames]);

  // Retourne les objets chaîne complets (avec URL multicast)
  return allChannels.filter(ch => allNames.has(ch.name));
}

// ────────────────────────────────────────────────────────────────
// GET /auth/status
// Vérifie si la STB est authentifiée et connue dans CLIENTS.json
// ────────────────────────────────────────────────────────────────
router.get("/status", (req, res) => {
  const stbId = req.stbId; // injecté par le middleware TLS de server.js

  if (!stbId) {
    return res.status(200).json({
      authenticated: false,
      message: "Non authentifié — certificat client requis"
    });
  }

  const subscriber = readClients().find(s => s.stb_id === stbId);

  res.status(200).json({
    authenticated:  true,
    stbId,
    room:           subscriber ? subscriber.room                       : null,
    packs:          subscriber ? (subscriber.packs          || [])     : [],
    alaCarteCount:  subscriber ? (subscriber.subscriptions  || []).length : 0
  });
});

// ────────────────────────────────────────────────────────────────
// GET /auth/me
// Retourne la config complète de la STB :
//   packs souscrits + chaînes à-la-carte + liste complète des
//   chaînes accessibles avec URLs multicast (pour cvlc / ffplay)
// ────────────────────────────────────────────────────────────────
router.get("/me", (req, res) => {
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
    return res.status(404).json({
      error: "STB non trouvée dans CLIENTS.json",
      stbId
    });
  }

  const chainesJson      = readChaines();
  const channelsResolved = resolveChannels(subscriber, chainesJson);

  res.json({
    // Identité
    stbId:   subscriber.stb_id,
    room:    subscriber.room,

    // Abonnements
    packs:         subscriber.packs         || [], // ex: ["info", "sport"]
    subscriptions: subscriber.subscriptions || [], // chaînes à-la-carte

    // Chaînes accessibles calculées (packs + à-la-carte, sans doublons)
    // Chaque entrée : { id, name, pack, multiplex, frequency, multicast }
    channels:     channelsResolved,
    channelCount: channelsResolved.length
  });
});

module.exports = router;
