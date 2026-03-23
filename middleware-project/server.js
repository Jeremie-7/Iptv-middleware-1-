const express = require('express');
const fs = require("fs");
const https = require ("https");
const path = require("path");

const app = express();
app.use(express.json());

// Middleware to log all requests
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.url}`);
  next();
});

// Middleware to extract STB ID from client certificate
app.use((req, res, next) => {
  if (req.socket && req.socket.authorized) {
    // Extract STB ID from certificate subject
    const cert = req.socket.getPeerCertificate();
    if (cert && cert.subject) {
      // The CN (Common Name) contains the STB ID (e.g., "stb-01")
      const cn = cert.subject.CN;
      if (cn && cn.startsWith('stb-')) {
        req.stbId = cn;
        console.log(`  -> Authenticated STB: ${req.stbId}`);
      }
    }
  }
  next();
});

// interface web admin
app.use(express.static(path.join(__dirname, "public")));

// Importation et montage des routes IPTV
const channelsRoutes = require("./routes/channels.js");
const subscriptionsRoutes = require("./routes/subscriptions.js");
const authRoutes = require("./routes/auth.js");
const streamRoute = require("./routes/stream");
const statusRoute = require("./routes/status");
// const stbRoute = require("./routes/stb");

app.use("/channels", channelsRoutes);
app.use("/subscriptions", subscriptionsRoutes);
app.use("/auth", authRoutes);
app.use("/stream", streamRoute);
app.use("/status", statusRoute);
// app.use("/stb", stbRoute);//lien avec monitoring
app.use(express.static("public"));


// Health check endpoint: une URL ou une route q permet de verifier si le systeme fonctionne correctement
app.get('/api/status', (req, res) => {
  res.json({ 
    status: 'Middleware en cours de fonctionnement',
    timestamp: new Date().toISOString(),
    authenticated: !!req.stbId,
    stbId: req.stbId || null
  });
});

app.get("/status", (req,res)=>{

  res.json({
    service: "IPTV Middleware",
    status: "running",
    time: new Date()
  });

});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route non trouvée' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(`[ERROR] ${err.message}`);
  res.status(500).json({ error: 'Erreur interne du serveur' });
});

// Configuration serveur securisee TLS
const options = {
  key: fs.readFileSync("./certs/middleware.key"),
  cert: fs.readFileSync("./certs/middleware.crt"),
  ca: fs.readFileSync("./certs/ca.crt"),
  requestCert: true,  // Demande le certificats
  rejectUnauthorized: false // Ne rejette pas les demandes non-autorisé (si "false" sinon rejette si y'a "true")(pas vérifier avec certificats)
};

https.createServer(options, app).listen(3000, () => {
  console.log("Middleware IPTV sécurisé (HTTPS + TLS) sur le port 3000");
});
