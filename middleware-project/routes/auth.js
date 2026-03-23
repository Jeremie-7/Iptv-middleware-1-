//Ce code est un module Express.js qui définit deux routes 
// API pour gérer l'authentification et les informations d'un client
const express = require("express"); // framework pour créer des serveurs web en node.js
const router = express.Router(); // un routeur Express pour définir des routes modulaires
const subscribers = require("../Data/CLIENTS.json");//chargement du fichier qui contient la liste des clients lequel ont associe avec la variable "subsciber" (qui ne chnage jama car c'est "const")


// Get current authentication status //Vérifie si req.stbId est présent
router.get("/status", (req, res) => { 
  const stbId = req.stbId;

//Si pas de stbId renvoie une réponse en JSON disant que l'utilisateur n'est pas authentifié avec un message
  if (!stbId) { 
    return res.status(200).json({
      authenticated: false,
      message: "Non authentifié (stb non reconnue)- certificat (client) requis"
    });
  }
//Sinoncherche le client dans la liste des abonnés (subscribers = le fichier CLIENTS.json) avec sstb_id
  const subscriber = subscribers.find(s => s.stb_id === stbId); 

//renvoie une réponse JSON contenant:
  res.status(200).json({
    authenticated: true,
    stbId: stbId,
//notation opérateur ternaire (façon compacte d’écrire une condition)
   // Vérifie si subscriber existe. S'il existe (condition vraie) alors la valeur de room sera subscriber.room
  //  Sinon (condition fausse), la valeur de room sera null 
    room: subscriber ? subscriber.room : null,//la pièce associée à l'abonné (ou null si non trouvé)
    subscriptionCount: subscriber ? subscriber.subscription.length : 0 //nombre d'abonnements
  });
});

// Get current STB info
router.get("/me", (req, res) => {
  const stbId = req.stbId; //
  
  if (!stbId) {
    return res.status(401).json({ 
      error: "Non autorisé",
      message: "Certificat client requis"
    });
  }

  const subscriber = subscribers.find(s => s.stb_id === stbId);
  
  if (!subscriber) {
    return res.status(404).json({ 
      error: "STB non trouvée",
      stbId: stbId
    });
  }

  res.json({ // renvoie la reponse en JSON contenant les informations de la STB
    stbId: subscriber.stb_id, //Quelle STB 
    room: subscriber.room, //Quelle chambre
    subscriptions: subscriber.subscription // Quels abonnements 
  });
});

module.exports = router;

