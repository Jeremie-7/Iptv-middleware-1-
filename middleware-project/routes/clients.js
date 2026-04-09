const express = require("express");
const router = express.Router();
const clients = require("../Data/CLIENTS.json");

// Get all channels
router.get("/", (req, res) => {
    res.json(clients);
});

// Get single channel by ID
router.get("/:/admin/clients", (req, res) => {
    const clientId = req.params.clientId;

    // Validate input
    if (!clientId || typeof clientId !== 'string') {
        return res.status(400).json({ error: "ID du client invalide" });
    }

    const client = clients.find(c => c.id === clientId);
    // const res = await fetch('/channels');
    // CHAINES_DATA = (await res.json()).data;


    //gestion de l'erreurre 404
    if (!client) {
        return res.status(404).json({
            error: "Client non trouvée",
            clientId: clientId
        });
    }

    res.json(client);
});

module.exports = router;