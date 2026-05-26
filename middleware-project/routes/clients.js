// routes/clients.js
// Expose la liste des clients/abonnés.
// Note : les routes d'écriture (POST/PUT/DELETE) sont dans routes/admin.js
// Ce fichier gère uniquement la lecture publique.

const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const path    = require("path");

const CLIENTS_PATH = path.join(__dirname, "../Data/CLIENTS.json");

// ── Lecture dynamique ────────────────────────────────────────────
function readClients() {
  return JSON.parse(fs.readFileSync(CLIENTS_PATH, "utf8"));
}

// GET /clients
// Retourne tous les abonnés
router.get("/", (req, res) => {
  try {
    res.json(readClients());
  } catch (err) {
    console.error("[ERROR] GET /clients :", err.message);
    res.status(500).json({ error: "Erreur lecture CLIENTS.json" });
  }
});

// GET /clients/:stbId
// Retourne un abonné par son STB ID
// CORRIGÉ : route était "/:/admin/clients" (invalide) → "/:stbId"
// CORRIGÉ : cherchait par c.id → cherche par c.stb_id
router.get("/:stbId", (req, res) => {
  try {
    const { stbId } = req.params;

    if (!stbId || typeof stbId !== "string") {
      return res.status(400).json({ error: "STB ID invalide" });
    }

    const clients = readClients();
    const client  = clients.find(c => c.stb_id === stbId); // CORRIGÉ : était c.id

    if (!client) {
      return res.status(404).json({
        error: "Client non trouvé",
        stbId
      });
    }

    res.json(client);

  } catch (err) {
    console.error("[ERROR] GET /clients/:stbId :", err.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

module.exports = router;
