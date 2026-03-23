const express = require("express");
const router = express.Router();

const subscribers = require("../Data/CLIENTS.json");
const channels = require("../Data/CHAINES.json");

router.get("/:id", (req, res) => {
    try {

        const stbId = req.stbId;
        const channelId = parseInt(req.params.id);

        const subscriber = subscribers.find(s => s.stb_id === stbId);

        if (!subscriber) {
            console.log("[SECURITY] STB inconnue :", stbId);
            return res.status(403).json({ error: "STB non autorisée" });
        }

        const channel = channels.data.find(c => c.id === channelId);

        if (!channel) {
            return res.status(404).json({ error: "Chaîne inexistante" });
        }

        //Verif abonnement
        if (!subscriber.subscriptions.includes(channel.name)) {

            console.log(
                `[SECURITY] Accès refusé - STB ${stbId} a tenté d'accéder à ${channel.name}`
            );

            return res.status(403).json({
                error: "Accès refusé à cette chaîne"
            });
        }

        console.log(
            `[INFO] STB ${stbId} accède au flux ${channel.name}`
        );

        res.json({
            channel: channel.name,
            multicast: channel.multicast
        });

    } catch (err) {
        console.error("[ERROR]", err.message);
        res.status(500).json({ error: "Erreur serveur" });
    }
});

module.exports = router;