const express = require("express");
const router = express.Router();
const subscribers = require("../Data/CLIENTS.json");
const channels = require("../Data/CHAINES.json");


// Get subscriptions for authenticated STB (from certificate)
router.get("/", (req, res) => {
// Use STB ID from certificate (set by middleware in server.js)
  try {
    const stbId = req.stbId;

    if (!stbId) {
      return res.status(401).json({
        error: "Non autorisé",
        message: "Certificat client requis pour accéder aux abonnements"
      });
    }
// Le code d'erreur HTTP 403 signifie que l'accèsa la ressource est refusé au client par le serveur
    const subscriber = subscribers.find(s => s.stb_id === stbId);
    if (!subscriber) {
      return res.status(403).json({
        error: "STB inconnue",
        stbId: stbId
      });
    }
    //Dans le cas ou les chaines dans CHAINES.json soien des tableaux (= voir mise en page dans le fichier json)
    //const allowedChannels = channels.filter(c =>
    //subscriber.subscription.includes(c.id)

    //Dans notre cas a (cause de la mise ne page) ce sont des objets donc:
    // const allowedChannels = channels.filter(c =>
    // subscriber.subscription.includes(c.id)

    const allowedChannels = channels.data.filter(c =>
      subscriber.subscriptions.includes(c.name)
    );

    res.json({
      stbId: subscriber.stb_id,
      room: subscriber.room,
      channels: allowedChannels
    });
  } catch (err) {
  console.error("[ERROR]", err.message);
  res.status(500).json({ error: "Errer serveur" });
  }
  });




// Get subscription par STB ID      (admin endpoint - deprecated, use / instead)
router.get("/:stbId", (req, res) => {
  try{
  const stbId = req.params.stbId;

  // Validate input
  if (!stbId || typeof stbId !== 'string') {
    return res.status(400).json({ error: "ID STB invalide" });
  }

  // Check if STB ID matches authenticated certificate
  if (req.stbId && req.stbId !== stbId) {
    return res.status(403).json({
      error: "Interdit",
      message: "Vous ne pouvez pas accéder aux informations d'une autre STB"
    });
  }

  const subscriber = subscribers.find(s => s.stb_id === stbId);
  if (!subscriber) {
    return res.status(404).json({ error: "STB inconnue" });
  }

  const allowedChannels = channels.data.filter(c =>
    subscriber.subscriptions.includes(c.name)
  );

  res.json({
    stbId: subscriber.stb_id,
    room: subscriber.room,
    channels: allowedChannels
  });
}catch (err){
  console.error("[ERROR]", err.message);
  res.status(500).json({error: "EReur serveur"})
}
});

module.exports = router;
// console.log("Channels loaded:", channels);(Affiche la totalité des chaines dispo)