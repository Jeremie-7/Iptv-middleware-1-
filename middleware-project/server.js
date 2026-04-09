const express = require('express');
const fs = require("fs");
const https = require ("https");
const path = require("path");

const app = express();
app.use(express.json());

// interface web admin
app.use(express.static(path.join(__dirname, "public")));

// Middleware to log all requests
//Fonction fléché
app.use((req, res, next) => {
  const timestamp = new Date().toISOString(); // Instancie une classe qui creer l'objet date grace a l'apllee du constructeur (= les parenthese sont l'apelle du constructeur)
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
const adminRoute = require("./routes/admin.js");
// const stbRoute = require("./routes/stb");

app.use("/channels", channelsRoutes); // utilise un middleware (fonction qui sinterpse entre une requete et une reponse) (Bien utiliser le mot middleware pour definir)
app.use("/subscriptions", subscriptionsRoutes);// utilise un middleware (fonction qui sinterpse entre une requete et une reponse)
app.use("/auth", authRoutes);// utilise un middleware (fonction qui sinterpse entre une requete et une reponse)
app.use("/stream", streamRoute);// utilise un middleware (fonction qui sinterpse entre une requete et une reponse)
app.use("/status", statusRoute);// utilise un middleware (fonction qui sinterpse entre une requete et une reponse)
app.use("/admin", adminRoute);
// app.use("/stb", stbRoute);//lien avec monitoring 
// app.use(express.static("public"));


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
    // stb_connected: connectedSTB.size
  });

});

// Dans server.js ou une nouvelle route routes/admin.js
app.get('/admin/clients', (req, res) => {
  const clients = require('./Data/CLIENTS.json');
  res.json(clients);
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
