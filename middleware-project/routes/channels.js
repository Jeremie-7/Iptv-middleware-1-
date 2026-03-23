const express = require("express");
const router = express.Router();
const channels = require("../Data/CHAINES.json");

// Get all channels
router.get("/", (req, res) => {
  res.json(channels);
});

// Get single channel by ID
router.get("/:channelId", (req, res) => {
  const channelId = req.params.channelId;
  
  // Validate input
  if (!channelId || typeof channelId !== 'string') {
    return res.status(400).json({ error: "ID de chaîne invalide" });
  }

  const channel = channels.find(c => c.id === channelId);
  

  //gestion de l'erreurre 404
  if (!channel) {
    return res.status(404).json({ 
      error: "Chaîne non trouvée",
      channelId: channelId
    });
  }

  res.json(channel);
});

module.exports = router;

