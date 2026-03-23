const express = require("express");
const router = express.Router();

let stbConnections = {};

router.get("/connect", (req, res) => {

  const stbId = req.stbId;

  stbConnections[stbId] = {
    lastSeen: new Date()
  };

  console.log("[INFO] STB connectée :", stbId);

  res.json({
    message: "STB connectée",
    stbId: stbId
  });

});

router.get("/list", (req, res) => {

  res.json(stbConnections);

});

module.exports = router;