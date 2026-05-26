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
      if (cn) {
        req.stbId = cn;
        console.log(`Authenticated : ${req.stbId}`);
      }
    }
  }
  next();
});

// J'ai fais un dashboard admin et j'ai mis un système d’authentification pour pouvoir accéder au dashboard admin; Cependant lorsque je rentre le mdp et et l’identifiant je reçois : "route non trouvée"; Que faire ?

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


// Routes publiques (sans authentification TLS requise) (pour client)
// app.use("/register", adminRoute);  // POST /register
// app.use("/login",    adminRoute);  // POST /login
// app.use("/stb", stbRoute);//lien avec monitoring 
app.post("/register", (req, res) => {
  req.url = "/register";
  adminRoute(req, res, () => res.status(404).json({ error: "Route non trouvée" }));
});
app.use(express.static("public"));


// ::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
// app.use(express.json());
// app.post("/register", (req, res, next) => { req.url="/register"; adminRoute(req,res,next); });//pour que les abonnés renseignent leurs infos et accede a l'interface de selection d'abonnement
// app.post("/login",    (req, res, next) => { req.url="/login";    adminRoute(req,res,next); });// pour que l'admin s'identifie



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

app.use(express.static(path.join(__dirname, "public")));
//Route explicite qui redirige auomatiquement vers adimn.html
//Ainsi pas besoin de taper de le chemin complet seul celien suffit: https://middleware:3000/
// :::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
app.get("/", (req, res) => {
  res.redirect("/admin.html"); // (barriere de secu) afin de s'authentifier avant d'accerder au dashboard.
});
// J'ai la possibilté aussi de creer un index.tml qui redirige directement vers admin.html
// Avec cette comande: "echo '<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=/admin.html"></head></html>' \
//  > /home/ciel/Bureau/Projet_2026/middleware-project/public/index.html"
// Car qaund je tape le lien express cherche un index mais cmmme il n'y en a pas: erreur
// j'ai opté pour celle ci-desss car moins longue a metre en oeuvre (meme si l'autre reste tres courte aussi)


// Configuration serveur securisee TLS
const options = {
  key: fs.readFileSync("./certs/middleware.key"),// cle privée du serveur( a verif)
  cert: fs.readFileSync("./certs/middleware.crt"),// certificat du serveur(a verif)
  ca: fs.readFileSync("./certs/ca.crt"),
  requestCert: true,  // Demande le certificats
  rejectUnauthorized: false // Ne rejette pas les demandes non-autorisé (si "false" sinon rejette si y'a "true")(pas vérifier avec certificats)
};




// https.createServer(options, app).listen(3000, () => {
//   console.log("Middleware IPTV sécurisé (HTTPS + TLS) sur le port 3000");
// });
// Serveur HTTPS est créé et assigné à une variable ce qui permt l'utilisaion de web socket
const httpsServer = https.createServer(options, app);
httpsServer.listen(3000, () => {
  console.log("Middleware IPTV sécurisé (HTTPS + TLS) sur le port 3000");
});


//WebSocket est un standard du Web désignant un protocole réseau de la couche application et une interface de programmation du World Wide Web visant à créer des canaux de communication full-duplex par-dessus une connexion TCP pour les navigateurs web.
//WebSocket is a computer communications protocol, providing a bidirectional communication channel over a single Transmission Control Protocol (TCP) connection
//The WebSocket API makes it possible to open a two-way interactive communication session between the user's browser and a server. With this API, you can send messages to a server and receive responses without having to poll the server for a reply

//POUR RECEVOI LES CHAINES DIFFUSE DYNAMIQUEMENT (web socket)
const { WebSocketServer } = require("ws");

// Lance le serveur WebSocket sur le même port HTTPS
const wss = new WebSocketServer({ server: httpsServer });

wss.on("connection", (ws, req) => {
  console.log("[WS] Streamer connecté");

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data);

      if (msg.type === "sync_channels" && Array.isArray(msg.data)) { //vérifie si la valeur passée est un Array (tableau ou lise )
        // Même logique que /admin/chaines/sync
        const chaines = JSON.parse(fs.readFileSync(CHAINES_PATH, "utf8"));// Parser le json (je crois a verifier)
        chaines.data = msg.data.map(ch => {
          const ex = (chaines.data || []).find(c => c.id === ch.id);
          return { ...ch, pack: ex ? ex.pack : "divertissement" };
        });
        chaines.count = chaines.data.length;
        fs.writeFileSync(CHAINES_PATH, JSON.stringify(chaines, null, 2));

        // Notifie le dashboard
        const adminRouter = require("./routes/admin.js");
        if (adminRouter.broadcastSSE) {
          adminRouter.broadcastSSE({ type: "chaines", payload: chaines });
        }

        ws.send(JSON.stringify({ ok: true, count: chaines.data.length }));
        console.log(`[WS] Chaînes mises à jour · ${chaines.data.length}`);
      }
    } catch (err) {
      console.error("[WS] Erreur :", err.message);
    }
  });

  ws.on("close", () => console.log("[WS] Streamer déconnecté"));
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