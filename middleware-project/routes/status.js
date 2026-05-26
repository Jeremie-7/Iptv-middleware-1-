// routes/status.js
// Health check du middleware — utilisé par les STB et le dashboard.
// Retourne le statut du service, le nombre de chaînes et de STB connectées.

const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const path    = require("path");

const CHAINES_PATH = path.join(__dirname, "../Data/CHAINES.json");

// ── Lecture dynamique ────────────────────────────────────────────
function readChaines() {
  return JSON.parse(fs.readFileSync(CHAINES_PATH, "utf8"));
}

// ── Suivi des STB connectées ─────────────────────────────────────
// Stocke les STB qui ont appelé /status avec horodatage.
// Une STB est considérée "active" si elle a appelé dans les 5 dernières minutes.
const connectedStb = new Map(); // stbId → { lastSeen: Date }
const STB_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function cleanupStale() {
  const now = Date.now();
  for (const [id, info] of connectedStb.entries()) {
    if (now - info.lastSeen > STB_TIMEOUT_MS) {
      connectedStb.delete(id);
    }
  }
}

// ────────────────────────────────────────────────────────────────
// GET /status
// Retourne l'état général du middleware.
// Si la STB présente un certificat, elle est enregistrée comme active.
// ────────────────────────────────────────────────────────────────
router.get("/", (req, res) => {
  try {
    // Enregistre la STB si authentifiée
    if (req.stbId) {
      connectedStb.set(req.stbId, { lastSeen: Date.now() });
    }

    // Nettoie les STB inactives
    cleanupStale();

    // Relit CHAINES.json pour avoir le vrai compte à jour
    const chainesJson  = readChaines();
    const channelCount = (chainesJson.data || []).length; // CORRIGÉ : plus channels.count figé

    res.json({
      middleware:   "running",
      channels:     channelCount,
      packs:        (chainesJson.packs || []).length,
      stbConnected: connectedStb.size,
      stbList:      req.stbId ? [...connectedStb.keys()] : undefined, // visible seulement si authentifié
      time:         new Date().toISOString()
    });

  } catch (err) {
    console.error("[ERROR] GET /status :", err.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

module.exports = router;
