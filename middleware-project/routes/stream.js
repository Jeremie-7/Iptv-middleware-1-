// routes/stream.js
// Vérifie les droits d'accès d'une STB à une chaîne et retourne
// l'URL multicast si elle y est autorisée (via pack ou à-la-carte).

const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const path    = require("path");

const CLIENTS_PATH = path.join(__dirname, "../Data/CLIENTS.json");
const CHAINES_PATH = path.join(__dirname, "../Data/CHAINES.json");

// ── Lecture dynamique ────────────────────────────────────────────
function readClients() {
  return JSON.parse(fs.readFileSync(CLIENTS_PATH, "utf8"));
}
function readChaines() {
  return JSON.parse(fs.readFileSync(CHAINES_PATH, "utf8"));
}

// ── Vérifie si un client a accès à une chaîne (packs + à-la-carte)
function hasAccess(client, channelName, chainesJson) {
  const allPacks = chainesJson.packs || [];

  // Vérifie dans les packs souscrits
  for (const packId of (client.packs || [])) {
    const pack = allPacks.find(p => p.id === packId);
    if (pack && pack.chaines.includes(channelName)) return true;
  }

  // Vérifie dans les chaînes à-la-carte
  if ((client.subscriptions || []).includes(channelName)) return true;

  return false;
}

// ────────────────────────────────────────────────────────────────
// GET /stream/:id
// Retourne l'URL multicast d'une chaîne si la STB y est autorisée.
// :id = identifiant numérique de la chaîne (champ "id" dans CHAINES.json)
// ────────────────────────────────────────────────────────────────
router.get("/:id", (req, res) => {
  try {
    const stbId     = req.stbId;
    const channelId = parseInt(req.params.id, 10);

    // STB non authentifiée
    if (!stbId) {
      console.log("[SECURITY] Accès /stream sans certificat");
      return res.status(401).json({ error: "Certificat client requis" });
    }

    if (isNaN(channelId)) {
      return res.status(400).json({ error: "ID chaîne invalide" });
    }

    const clients    = readClients();
    const subscriber = clients.find(s => s.stb_id === stbId);

    if (!subscriber) {
      console.log("[SECURITY] STB inconnue :", stbId);
      return res.status(403).json({ error: "STB non autorisée" });
    }

    const chainesJson = readChaines();
    const channel     = (chainesJson.data || []).find(c => c.id === channelId);

    if (!channel) {
      return res.status(404).json({ error: "Chaîne inexistante : " + channelId });
    }

    // Vérifie l'accès via packs OU à-la-carte
    if (!hasAccess(subscriber, channel.name, chainesJson)) {
      console.log(`[SECURITY] Accès refusé · STB ${stbId} → chaîne ${channel.name}`);
      return res.status(403).json({
        error:   "Accès refusé à cette chaîne",
        channel: channel.name,
        hint:    "Cette chaîne n'est pas dans vos packs ni en à-la-carte"
      });
    }

    console.log(`[INFO] STB ${stbId} · accès autorisé · ${channel.name}`);

    res.json({
      channel:   channel.name,
      multicast: channel.multicast
    });

  } catch (err) {
    console.error("[ERROR] /stream/:id :", err.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

module.exports = router;
