// routes/channels.js
// Expose la liste des chaînes IPTV disponibles.
// Utilisé par le dashboard admin et le streamer.

const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const path    = require("path");

const CHAINES_PATH = path.join(__dirname, "../Data/CHAINES.json");

// ── Lecture dynamique ────────────────────────────────────────────
// Relit le fichier à chaque requête → toujours à jour si le streamer
// a mis à jour CHAINES.json via POST /admin/chaines/sync
function readChaines() {
  return JSON.parse(fs.readFileSync(CHAINES_PATH, "utf8"));
}

// ────────────────────────────────────────────────────────────────
// GET /channels
// Retourne l'objet complet CHAINES.json (packs + data)
// ────────────────────────────────────────────────────────────────
router.get("/", (req, res) => {
  try {
    res.json(readChaines());
  } catch (err) {
    console.error("[ERROR] GET /channels :", err.message);
    res.status(500).json({ error: "Erreur lecture CHAINES.json" });
  }
});

// ────────────────────────────────────────────────────────────────
// GET /channels/:channelId
// Retourne une chaîne par son ID numérique
// CORRIGÉ : cherche dans json.data (et non dans json directement)
// ────────────────────────────────────────────────────────────────
router.get("/:channelId", (req, res) => {
  try {
    const channelId = parseInt(req.params.channelId, 10);

    if (isNaN(channelId)) {
      return res.status(400).json({ error: "ID de chaîne invalide (doit être un entier)" });
    }

    const json    = readChaines();
    const channel = (json.data || []).find(c => c.id === channelId); // CORRIGÉ

    if (!channel) {
      return res.status(404).json({
        error:     "Chaîne non trouvée",
        channelId
      });
    }

    res.json(channel);

  } catch (err) {
    console.error("[ERROR] GET /channels/:id :", err.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

module.exports = router;
