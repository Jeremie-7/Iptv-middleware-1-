const express = require("express");
const router = express.Router();

const channels = require("../Data/CHAINES.json");

let connectedStb = new Set();

router.get("/", (req, res) => {

  const stbId = req.stbId;

  if (stbId) {
    connectedStb.add(stbId);
  }

  res.json({
    middleware: "running",
    channels: channels.count,
    stbConnected: connectedStb.size,
    time: new Date()
  });

});

module.exports = router;