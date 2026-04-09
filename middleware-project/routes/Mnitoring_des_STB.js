// const express = require("express");
// const router = express.Router();

// let stbConnections = {};

// router.get("/connect", (req, res) => {

//   const stbId = req.stbId;

//   stbConnections[stbId] = {
//     lastSeen: new Date() // Instance lobjet date grace a l'appelle le constrcteur qui creer l'obet
//     //Verifie ce que j'ai dis juste avan
//   };

//   console.log("[INFO] STB connectée :", stbId);

//   res.json({
//     message: "STB connectée",
//     stbId: stbId
//   });

// });

// router.get("/list", (req, res) => {

//   res.json(stbConnections);

// });

// module.exports = router;