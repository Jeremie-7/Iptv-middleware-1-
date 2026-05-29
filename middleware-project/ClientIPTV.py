"""
╔══════════════════════════════════════════════════════════════════╗
║           CLIENT IPTV — Application Bureau Python               ║
║           Projet IPTV 2026 — Lycée Newton                       ║
║           Étudiant 4 : Kante Mamadou                            ║
╚══════════════════════════════════════════════════════════════════╝

Fonctionnement :
    1. Au démarrage → GET /channels avec certificat client TLS
       Le middleware identifie le client grâce au certificat
       et renvoie uniquement les chaînes autorisées
    2. Refresh automatique toutes les secondes
       Si Jeremy ajoute ou retire des chaînes → mise à jour automatique
    3. Lecture des flux multicast RTP via ffplay

Prérequis réseau :
    Ajouter dans /etc/hosts :
        192.168.5.119   middleware
"""

# ── Imports ───────────────────────────────────────────────────────────────────
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

import threading
import time
import subprocess
import tkinter as tk
import json
import socket
import os
import re
from tkinter import messagebox
import requests

# ══════════════════════════════════════════════════════════════════════════════
# CONFIGURATION
# ══════════════════════════════════════════════════════════════════════════════

# URL du Middleware via nom de domaine (CN du certificat = "middleware")
MIDDLEWARE_BASE   = "https://192.168.10.40:3000"
ENDPOINT_CHANNELS = "/auth/me"
ENDPOINT_AUTH     = "/auth/me"

# Intervalle de rafraîchissement des chaînes en secondes
REFRESH_INTERVAL = 10  # toutes les 5 secondes — évite de surcharger le serveur

# Certificat CA du serveur Jeremy — pour vérifier son identité
CA_CERT = os.path.join(os.path.dirname(__file__), "ca.crt")

# Certificat client — prouve notre identité au middleware
# Jeremy lit ce certificat et décide quelles chaînes nous autoriser
CLIENT_CERT = (
    os.path.join(os.path.dirname(__file__), "pythonapp.crt"),
    os.path.join(os.path.dirname(__file__), "pythonapp.key")
)

TIMEOUT         = 10
FICHIER_CHAINES = os.path.join(os.path.dirname(__file__), "CHAINES.json")

# ══════════════════════════════════════════════════════════════════════════════
# THÈME VISUEL
# ══════════════════════════════════════════════════════════════════════════════

C = {
    "bg":     "#0a0c0f",
    "panel":  "#111318",
    "card":   "#16191f",
    "hover":  "#1e222b",
    "select": "#1a1f2e",
    "border": "#2a3444",
    "red":    "#af4750",
    "red2":   "#b02030",
    "redhi":  "#ff6b7a",
    "cyan":   "#51bcd1",
    "cyan2":  "#0088aa",
    "white":  "#637fce",
    "grey":   "#8892a4",
    "dim":    "#4a5568",
    "green":  "#00ff88",
    "yellow": "#ffd700",
}

F = {
    "title": ("Courier New", 18, "bold"),
    "item":  ("Courier New", 12),
    "badge": ("Courier New",  9, "bold"),
    "btn":   ("Courier New", 11, "bold"),
    "small": ("Courier New",  8),
    "tiny":  ("Courier New",  7),
    "sub":   ("Courier New", 10),
    "mono":  ("Courier New",  9),
}


# ══════════════════════════════════════════════════════════════════════════════
# FONCTIONS UTILITAIRES
# ══════════════════════════════════════════════════════════════════════════════

def get_url_chaine(c):
    """
    Extrait l'URL depuis le format JSON de Jeremy.
    Format Jeremy : {"multicast": {"url": "rtp://@239.255.6.1:5001"}}
    Format standard : {"url": "rtp://239.0.0.1:1234"}
    """
    if "url" in c and c["url"]:
        return c["url"]
    if "multicast" in c and isinstance(c["multicast"], dict):
        return c["multicast"].get("url", "")
    return ""


def normaliser_chaines(data):
    """
    Adapte la réponse de /auth/me au format interne { nom, url, ... }
    """
    # /auth/me retourne { channels: [{name, multicast:{url}, ...}] }
    if isinstance(data, dict) and "channels" in data:
        chaines = data["channels"]
    elif isinstance(data, list):
        chaines = data
    else:
        return []

    result = []
    for ch in chaines:
        nom = ch.get("name", ch.get("nom", ""))
        url = ""
        if "multicast" in ch:
            url = ch["multicast"].get("url", "")
        elif "url" in ch:
            url = ch["url"]
        if nom and url:
            result.append({
                "nom":       nom,
                "url":       url,
                "frequency": ch.get("frequency", ""),
                "pack":      ch.get("pack", ""),
                "id":        ch.get("id", ""),
            })
    return result



def charger_chaines_locales():
    """Charge les chaînes depuis CHAINES.json (mode fallback)."""
    try:
        with open(FICHIER_CHAINES, "r", encoding="utf-8") as f:
            return normaliser_chaines(json.load(f))
    except FileNotFoundError:
        return []
    except json.JSONDecodeError:
        return []


# ══════════════════════════════════════════════════════════════════════════════
# CLASSE PRINCIPALE
# ══════════════════════════════════════════════════════════════════════════════

class IptvClient:
    """
    Application cliente IPTV — Etudiant 4 Kante Mamadou.

    Authentification par certificat TLS uniquement.
    Refresh automatique des chaînes toutes les REFRESH_INTERVAL secondes.

    Les 3 fonctions clés :
        fetch_channels() → GET /channels + certificat → chaînes autorisées
        play()           → ffplay rtp://@239.255.6.x:5001
        stop()           → termine ffplay proprement
    """

    def __init__(self, root):
        self.root        = root
        self.channels    = []
        self.proc        = None
        self.proc_src    = None
        self.loading     = False
        self._blink      = True
        self._play_start = None
        self._refresh_actif = True  # contrôle le refresh automatique
        self.session     = requests.Session()

        root.title("IPTV • Broadcast Client")
        root.geometry("820x780")
        root.configure(bg=C["bg"])
        root.minsize(700, 620)
        root.protocol("WM_DELETE_WINDOW", self._quit)

        self._build()
        self._tick_blink()
        self._tick_clock()

        # Premier chargement immédiat
        self.fetch_channels()

        # Démarrage du refresh automatique
        self._tick_refresh()

    # ══════════════════════════════════════════════════════════════════════════
    # REFRESH AUTOMATIQUE
    # ══════════════════════════════════════════════════════════════════════════

    def _tick_refresh(self):
        """
        Rafraîchit la liste des chaînes toutes les REFRESH_INTERVAL secondes.
        Utilise root.after() pour ne pas bloquer l'interface.
        Si Jeremy ajoute ou retire des chaînes → l'app se met à jour automatiquement.
        """
        if self._refresh_actif:
            # Lance le refresh en arrière-plan
            self._refresh_silencieux()
            # Planifie le prochain refresh
            self.root.after(REFRESH_INTERVAL * 1000, self._tick_refresh)

    def _refresh_silencieux(self):
        """
        Toutes les 10 secondes :
            1. GET /auth/me avec certificat → s'authentifie auprès du middleware
               Le middleware vérifie le certificat et confirme l'identité
            2. GET /channels → récupère les chaînes autorisées pour ce certificat
               Si Jeremy a modifié ou restreint l'accès → liste mise à jour

        Pas d'identifiant ni de mot de passe — uniquement le certificat TLS.
        Ne perturbe pas la lecture en cours.
        """
        def _run():
            try:
                # ── Étape 1 : Authentification via /auth/me ───────────────────
                # Le middleware lit le certificat client et confirme l'identité
                auth = self.session.get(
                    MIDDLEWARE_BASE + ENDPOINT_AUTH,   # https://middleware:3000/auth/me
                    cert=CLIENT_CERT,                  # pythonapp.crt + pythonapp.key
                    verify=CA_CERT,                    # vérifie le serveur
                    timeout=TIMEOUT
                )
                print(f"[AUTH/ME] Statut : {auth.status_code}")

                # Si le middleware refuse → on n'a plus accès
                if auth.status_code in (401, 403):
                    print("[AUTH/ME] Accès refusé par le middleware")
                    self.root.after(0, lambda: self._update_list_silencieux([], ""))
                    self.root.after(0, lambda: self._status(
                        "⛔ Accès refusé par le middleware", C["red"]))
                    return

                if auth.status_code != 200:
                    print(f"[AUTH/ME] Erreur {auth.status_code} → skip refresh")
                    return

                # ── Étape 2 : Récupération des chaînes autorisées ─────────────
                r = self.session.get(
    MIDDLEWARE_BASE + ENDPOINT_CHANNELS,
    cert=CLIENT_CERT,
    verify=CA_CERT,
    timeout=TIMEOUT
)

                if r.status_code != 200:
                    return

                nouvelles = normaliser_chaines(r.json())

                # Compare avec les chaînes actuelles
                noms_actuels  = {c["nom"] for c in self.channels}
                noms_nouveaux = {c["nom"] for c in nouvelles}

                # Met à jour seulement s'il y a un changement
                if noms_actuels != noms_nouveaux:
                    print(f"[REFRESH] Changement détecté → {len(nouvelles)} chaînes")
                    sel_avant = self.listbox.curselection()
                    nom_selectionne = ""
                    if sel_avant:
                        nom_selectionne = self.channels[sel_avant[0]].get("nom", "")
                    self.root.after(0, lambda ch=nouvelles, nom=nom_selectionne:
                                    self._update_list_silencieux(ch, nom))

            except Exception as ex:
                print(f"[REFRESH] Erreur silencieuse : {ex}")
                pass

        threading.Thread(target=_run, daemon=True).start()

    def _update_list_silencieux(self, nouvelles_chaines, nom_selectionne=""):
        """
        Met à jour la liste sans perturber la lecture en cours.
        Restaure la sélection si la chaîne est encore disponible.
        """
        self.channels = nouvelles_chaines
        self.listbox.delete(0, tk.END)

        idx_a_selectionner = None
        for i, ch in enumerate(self.channels):
            nom  = ch.get("nom", "?")
            pack = ch.get("pack", "")
            label = f"  {i+1:02d}  ▸  {nom}"
            if pack:
                label += f"  [{pack}]"
            self.listbox.insert(tk.END, label)
            # Cherche si la chaîne sélectionnée est encore là
            if nom == nom_selectionne:
                idx_a_selectionner = i

        # Restaure la sélection
        if idx_a_selectionner is not None:
            self.listbox.selection_set(idx_a_selectionner)

        self.count_lbl.config(text=f"[ {len(self.channels)} ]")
        print(f"[REFRESH] Liste mise à jour — {len(self.channels)} chaînes")

    # ══════════════════════════════════════════════════════════════════════════
    # INTERFACE
    # ══════════════════════════════════════════════════════════════════════════

    def _build(self):
        self._topbar()
        tk.Frame(self.root, bg=C["red"], height=2).pack(fill=tk.X)
        main = tk.Frame(self.root, bg=C["bg"])
        main.pack(fill=tk.BOTH, expand=True, padx=14, pady=(0, 14))
        self._channel_panel(main)
        self._side_panel(main)
        self._statusbar()

    def _topbar(self):
        bar = tk.Frame(self.root, bg=C["panel"], height=52)
        bar.pack(fill=tk.X)
        bar.pack_propagate(False)
        tk.Label(bar, text="▶ BROADCAST", font=F["title"],
                 bg=C["panel"], fg=C["white"]).pack(side=tk.LEFT, padx=(20, 0), pady=8)
        tk.Label(bar, text=" CLIENT", font=F["title"],
                 bg=C["panel"], fg=C["red"]).pack(side=tk.LEFT)
        self.live_dot = tk.Label(bar, text="●", font=("Courier New", 14),
                                  bg=C["panel"], fg=C["red"])
        self.live_dot.pack(side=tk.LEFT, padx=(24, 2))
        tk.Label(bar, text="LIVE", font=F["badge"],
                 bg=C["panel"], fg=C["red"]).pack(side=tk.LEFT)
        self.clock = tk.Label(bar, text="", font=F["badge"],
                               bg=C["panel"], fg=C["cyan"])
        self.clock.pack(side=tk.RIGHT, padx=20)
        # Indicateur refresh
        self.lbl_refresh = tk.Label(bar, text=f"↻ {REFRESH_INTERVAL}s",
                                     font=F["badge"], bg=C["panel"], fg=C["dim"])
        self.lbl_refresh.pack(side=tk.RIGHT, padx=8)
        tk.Label(bar, text="⬡ MAMADOU", font=F["badge"],
                 bg=C["panel"], fg=C["grey"]).pack(side=tk.RIGHT, padx=8)

    def _channel_panel(self, parent):
        left = tk.Frame(parent, bg=C["bg"])
        left.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

        hdr = tk.Frame(left, bg=C["bg"])
        hdr.pack(fill=tk.X, pady=(12, 4))
        tk.Label(hdr, text="CHAÎNES AUTORISÉES", font=F["sub"],
                 bg=C["bg"], fg=C["grey"]).pack(side=tk.LEFT)
        self.count_lbl = tk.Label(hdr, text="[ 0 ]", font=F["badge"],
                                   bg=C["bg"], fg=C["cyan"])
        self.count_lbl.pack(side=tk.RIGHT)
        tk.Frame(left, bg=C["border"], height=1).pack(fill=tk.X, pady=(0, 4))

        # Indicateur certificat + refresh
        tk.Label(
            left,
            text=f"⬡ AUTH : pythonapp.crt  |  REFRESH : {REFRESH_INTERVAL}s  |  {MIDDLEWARE_BASE}",
            font=F["tiny"], bg=C["bg"], fg=C["cyan2"]
        ).pack(anchor="w", pady=(0, 4))

        box = tk.Frame(left, bg=C["card"],
                       highlightbackground=C["border"], highlightthickness=1)
        box.pack(fill=tk.BOTH, expand=True)
        sb = tk.Scrollbar(box, bg=C["panel"], troughcolor=C["card"],
                          activebackground=C["red2"], bd=0,
                          highlightthickness=0, width=8)
        sb.pack(side=tk.RIGHT, fill=tk.Y)
        self.listbox = tk.Listbox(
            box, font=F["item"], bg=C["card"], fg=C["white"],
            selectbackground=C["select"], selectforeground=C["redhi"],
            activestyle="none", relief="flat", bd=0,
            highlightthickness=0, yscrollcommand=sb.set, cursor="hand2"
        )
        self.listbox.pack(fill=tk.BOTH, expand=True, padx=2, pady=2)
        sb.config(command=self.listbox.yview)
        self.listbox.bind("<<ListboxSelect>>", self._on_select)
        self.listbox.bind("<Double-Button-1>", lambda e: self.play())
        self.listbox.bind("<Return>",          lambda e: self.play())

        # Panneau EN COURS
        tk.Frame(left, bg=C["border"], height=1).pack(fill=tk.X, pady=(6, 0))
        now_frame = tk.Frame(left, bg=C["panel"])
        now_frame.pack(fill=tk.X)
        tk.Label(now_frame, text="EN COURS", font=F["badge"],
                 bg=C["panel"], fg=C["dim"]).pack(anchor="w", padx=12, pady=(6, 2))
        self.now_playing_lbl = tk.Label(
            now_frame, text="▶  Aucune lecture en cours",
            font=("Courier New", 10, "bold"),
            bg=C["panel"], fg=C["dim"], anchor="w"
        )
        self.now_playing_lbl.pack(fill=tk.X, padx=12, pady=(0, 2))
        self.now_url_lbl = tk.Label(
            now_frame, text="", font=F["small"],
            bg=C["panel"], fg=C["dim"], anchor="w"
        )
        self.now_url_lbl.pack(fill=tk.X, padx=12)
        self.elapsed_lbl = tk.Label(
            now_frame, text="", font=F["tiny"],
            bg=C["panel"], fg=C["dim"], anchor="w"
        )
        self.elapsed_lbl.pack(fill=tk.X, padx=12, pady=(0, 6))

        # Panneau DONNÉES FLUX
        tk.Frame(left, bg=C["border"], height=1).pack(fill=tk.X)
        data_frame = tk.Frame(left, bg=C["card"])
        data_frame.pack(fill=tk.X)
        tk.Label(data_frame, text="DONNÉES FLUX", font=F["badge"],
                 bg=C["card"], fg=C["dim"]).pack(anchor="w", padx=12, pady=(6, 4))

        def _row(parent, label, color=None):
            color = color or C["cyan"]
            f = tk.Frame(parent, bg=C["card"])
            f.pack(fill=tk.X, padx=12, pady=1)
            tk.Label(f, text=label, font=F["tiny"],
                     bg=C["card"], fg=C["dim"], anchor="w", width=16).pack(side=tk.LEFT)
            lbl = tk.Label(f, text="—", font=F["tiny"],
                           bg=C["card"], fg=color, anchor="w")
            lbl.pack(side=tk.LEFT)
            return lbl

        self.lbl_debit          = _row(data_frame, "⬡ DÉBIT")
        self.lbl_resolution     = _row(data_frame, "⬡ RÉSOLUTION")
        self.lbl_codec          = _row(data_frame, "⬡ CODEC")
        self.lbl_localisation   = _row(data_frame, "⬡ MON IP")
        self.lbl_middleware_loc = _row(data_frame, "⬡ MIDDLEWARE", C["yellow"])
        tk.Frame(data_frame, bg=C["card"], height=6).pack()

    def _side_panel(self, parent):
        right = tk.Frame(parent, bg=C["bg"], width=185)
        right.pack(side=tk.RIGHT, fill=tk.Y, padx=(12, 0))
        right.pack_propagate(False)

        card = tk.Frame(right, bg=C["card"],
                        highlightbackground=C["border"], highlightthickness=1)
        card.pack(fill=tk.X, pady=(12, 8))
        tk.Label(card, text="INFOS CHAÎNE", font=F["badge"],
                 bg=C["card"], fg=C["dim"]).pack(anchor="w", padx=10, pady=(8, 4))
        tk.Frame(card, bg=C["bg"], height=1).pack(fill=tk.X, padx=10)
        self.thumb = tk.Canvas(card, width=155, height=88,
                                bg="#0d1017", highlightthickness=0)
        self.thumb.pack(padx=10, pady=8)
        self._thumb_idle()
        self.info_nom = tk.Label(card, text="—",
                                  font=("Courier New", 10, "bold"),
                                  bg=C["card"], fg=C["white"],
                                  wraplength=155, justify="center")
        self.info_nom.pack(padx=8, pady=(0, 3))
        self.info_url = tk.Label(card, text="Sélectionne une chaîne",
                                  font=F["small"], bg=C["card"], fg=C["dim"],
                                  wraplength=155, justify="center")
        self.info_url.pack(padx=8, pady=(0, 4))
        self.info_freq = tk.Label(card, text="",
                                   font=F["tiny"], bg=C["card"], fg=C["dim"],
                                   wraplength=155, justify="center")
        self.info_freq.pack(padx=8, pady=(0, 10))

        self._btn(right, "▶  REGARDER",   C["red"],  C["white"], C["red2"],  self.play          ).pack(fill=tk.X, pady=(0, 5))
        self._btn(right, "↻  ACTUALISER", C["card"], C["cyan"],  C["hover"], self.fetch_channels).pack(fill=tk.X, pady=(0, 5))
        self._btn(right, "■  STOP",       C["card"], C["grey"],  C["hover"], self.stop          ).pack(fill=tk.X)

    def _btn(self, parent, text, bg, fg, hover, cmd):
        b = tk.Button(parent, text=text, font=F["btn"], bg=bg, fg=fg,
                      activebackground=hover, activeforeground=fg,
                      relief="flat", bd=0, pady=10, cursor="hand2", command=cmd)
        b.bind("<Enter>", lambda e: b.config(bg=hover))
        b.bind("<Leave>", lambda e: b.config(bg=bg))
        return b

    def _statusbar(self):
        tk.Frame(self.root, bg=C["border"], height=1).pack(fill=tk.X, side=tk.BOTTOM)
        bar = tk.Frame(self.root, bg=C["panel"], height=26)
        bar.pack(fill=tk.X, side=tk.BOTTOM)
        bar.pack_propagate(False)
        self.st_dot = tk.Label(bar, text="●", font=F["mono"],
                                bg=C["panel"], fg=C["dim"])
        self.st_dot.pack(side=tk.LEFT, padx=(12, 3))
        self.st_lbl = tk.Label(bar, text="Prêt", font=F["mono"],
                                bg=C["panel"], fg=C["grey"])
        self.st_lbl.pack(side=tk.LEFT)
        tk.Label(
            bar,
            text=f"AUTH : pythonapp.crt  |  {MIDDLEWARE_BASE}",
            font=F["mono"], bg=C["panel"], fg=C["cyan2"]
        ).pack(side=tk.RIGHT, padx=12)

    # ══════════════════════════════════════════════════════════════════════════
    # CANVAS
    # ══════════════════════════════════════════════════════════════════════════

    def _thumb_idle(self):
        c = self.thumb
        c.delete("all")
        c.create_rectangle(0, 0, 155, 88, fill="#0d1017", outline="")
        for x in range(0, 155, 20): c.create_line(x, 0, x, 88, fill="#151a22")
        for y in range(0, 88, 14):  c.create_line(0, y, 155, y, fill="#151a22")
        c.create_text(77, 38, text="▶",         font=("Courier New", 22), fill=C["border"])
        c.create_text(77, 66, text="NO SIGNAL", font=F["tiny"],           fill=C["dim"])

    def _thumb_live(self, nom):
        c = self.thumb
        c.delete("all")
        c.create_rectangle(0, 0, 155, 88, fill=C["select"], outline="")
        for y in range(0, 88, 6):
            c.create_rectangle(0, y, 155, y+3, fill="#0a0e16", outline="")
        c.create_rectangle(2, 2, 153, 86, outline=C["red"], width=1)
        c.create_text(77, 36, text="▶",          font=("Courier New", 20), fill=C["red"])
        c.create_text(77, 62, text=nom[:18],      font=("Courier New", 8, "bold"), fill=C["white"])
        c.create_text(77, 76, text="● EN DIRECT", font=F["tiny"],           fill=C["redhi"])

    # ══════════════════════════════════════════════════════════════════════════
    # TIMERS
    # ══════════════════════════════════════════════════════════════════════════

    def _tick_blink(self):
        self._blink = not self._blink
        self.live_dot.config(fg=C["red"] if self._blink else C["red2"])
        self.root.after(800, self._tick_blink)

    def _tick_clock(self):
        self.clock.config(text=f"⏱ {time.strftime('%H:%M:%S')}")
        self.root.after(1000, self._tick_clock)

    def _tick_elapsed(self):
        if not self._play_start:
            return
        if self.proc and self.proc.poll() is not None:
            self.now_playing_lbl.config(text="▶  Lecture terminée", fg=C["dim"])
            self.elapsed_lbl.config(text="")
            self._play_start = None
            return
        elapsed = int(time.time() - self._play_start)
        h = elapsed // 3600
        m = (elapsed % 3600) // 60
        s = elapsed % 60
        self.elapsed_lbl.config(
            text=f"⏱  {h:02d}:{m:02d}:{s:02d} en cours", fg=C["grey"])
        self.root.after(1000, self._tick_elapsed)

    def _fmt_elapsed(self):
        if not self._play_start:
            return "00:00:00"
        elapsed = int(time.time() - self._play_start)
        h = elapsed // 3600
        m = (elapsed % 3600) // 60
        s = elapsed % 60
        return f"{h:02d}:{m:02d}:{s:02d}"

    def _status(self, text, color=None):
        color = color or C["grey"]
        self.st_lbl.config(text=text, fg=color)
        self.st_dot.config(fg=color)

    # ══════════════════════════════════════════════════════════════════════════
    # DONNÉES FLUX
    # ══════════════════════════════════════════════════════════════════════════

    def _fetch_stream_info(self, url):
        def _run():
            try:
                result = subprocess.run(
                    ["ffprobe", "-v", "quiet", "-print_format", "json",
                     "-show_streams", url],
                    capture_output=True, text=True, timeout=15
                )
                data = json.loads(result.stdout)
                resolution, codec_info = "—", "—"
                for stream in data.get("streams", []):
                    if stream.get("codec_type") == "video":
                        w     = stream.get("width",  "?")
                        h     = stream.get("height", "?")
                        codec = stream.get("codec_name", "?").upper()
                        fps   = stream.get("r_frame_rate", "")
                        if "/" in fps:
                            try:
                                num, den = fps.split("/")
                                fps_val  = round(int(num) / int(den))
                                resolution = f"{w}×{h} @ {fps_val}fps"
                            except Exception:
                                resolution = f"{w}×{h}"
                        codec_info = codec
                        break
                self.root.after(0, lambda r=resolution, co=codec_info:
                                self._update_resolution_codec(r, co))
            except Exception:
                self.root.after(0, lambda: self._update_resolution_codec("—", "—"))
        threading.Thread(target=_run, daemon=True).start()

    def _update_resolution_codec(self, resolution, codec):
        self.lbl_resolution.config(text=resolution, fg=C["cyan"])
        self.lbl_codec.config(text=codec,           fg=C["cyan"])

    def _monitor_debit(self, proc_ytdlp):
        def _run():
            try:
                for line in iter(proc_ytdlp.stderr.readline, b""):
                    line = line.decode("utf-8", errors="ignore").strip()
                    match = re.search(
                        r'at\s+(\d+\.?\d*)\s*(GiB/s|MiB/s|KiB/s|GB/s|MB/s|KB/s|B/s)', line)
                    if match:
                        val, unite = float(match.group(1)), match.group(2)
                        if "GiB" in unite or "GB" in unite:
                            debit = f"{val * 8:.1f} Gb/s"
                        elif "MiB" in unite or "MB" in unite:
                            debit = f"{val * 8:.1f} Mb/s  ({val:.1f} MiB/s)"
                        elif "KiB" in unite or "KB" in unite:
                            debit = f"{val * 8 / 1000:.2f} Mb/s  ({val:.0f} KiB/s)"
                        else:
                            debit = f"{val:.0f} B/s"
                        self.root.after(0, lambda d=debit:
                            self.lbl_debit.config(text=d, fg=C["cyan"]))
                    match_prog = re.search(
                        r'\[download\]\s+(\d+\.?\d*)%.*?(\d+:\d+)', line)
                    if match_prog:
                        pct, eta = match_prog.group(1), match_prog.group(2)
                        self.root.after(0, lambda p=pct, e=eta:
                            self.elapsed_lbl.config(
                                text=f"⏱  {self._fmt_elapsed()}  —  {p}%  ETA {e}",
                                fg=C["grey"]))
            except Exception as ex:
                print(f"[monitor error] {ex}")
        threading.Thread(target=_run, daemon=True).start()

    def _fetch_localisation(self, url):
        def _run():
            try:
                r_moi    = requests.get(
                    "http://ip-api.com/json/?fields=country,city,isp,query", timeout=5)
                data_moi = r_moi.json()
                ma_loc   = f"{data_moi.get('query','?')} — {data_moi.get('city','?')}, {data_moi.get('country','?')}"
                self.root.after(0, lambda l=ma_loc:
                    self.lbl_localisation.config(text=l, fg=C["cyan"]))
                hostname = MIDDLEWARE_BASE.split("//")[-1].split(":")[0]
                ip_mid   = socket.gethostbyname(hostname)
                r_mid    = requests.get(
                    f"http://ip-api.com/json/{ip_mid}?fields=country,city,isp", timeout=5)
                data_mid = r_mid.json()
                loc_mid  = f"{ip_mid} — {data_mid.get('city','?')}, {data_mid.get('country','?')}"
                self.root.after(0, lambda l=loc_mid:
                    self.lbl_middleware_loc.config(text=l, fg=C["yellow"]))
            except Exception:
                self.root.after(0, lambda:
                    self.lbl_localisation.config(text="Non disponible", fg=C["dim"]))
        threading.Thread(target=_run, daemon=True).start()

    def _reset_stream_data(self):
        for lbl in [self.lbl_debit, self.lbl_resolution,
                    self.lbl_localisation, self.lbl_codec, self.lbl_middleware_loc]:
            lbl.config(text="—", fg=C["dim"])

    # ══════════════════════════════════════════════════════════════════════════
    # CHARGEMENT CHAÎNES — fonction clé n°1
    # ══════════════════════════════════════════════════════════════════════════

    def _on_select(self, _=None):
        sel = self.listbox.curselection()
        if not sel: return
        ch         = self.channels[sel[0]]
        nom, url   = ch.get("nom", "?"), ch.get("url", "")
        freq, pack = ch.get("frequency", ""), ch.get("pack", "")
        self.info_nom.config(text=nom)
        self.info_url.config(text=(url[:28] + "…") if len(url) > 28 else url)
        extra = []
        if freq: extra.append(f"📡 {freq}")
        if pack: extra.append(f"📦 {pack}")
        self.info_freq.config(text="  |  ".join(extra) if extra else "")
        self._thumb_live(nom)

    def fetch_channels(self):
        """
        Fonction clé n°1 — Chargement initial des chaînes.
        Authentification par certificat TLS uniquement.
        Affiche un message de statut pendant le chargement.
        """
        if self.loading: return
        self.loading = True

        def _run():
            try:
                self.root.after(0, lambda: self._status(
                    "🔐 Authentification par certificat…", C["cyan"]))

                # GET /channels avec certificat client
                r = self.session.get(
                    MIDDLEWARE_BASE + ENDPOINT_CHANNELS,
                    cert=CLIENT_CERT,   # pythonapp.crt + pythonapp.key
                    verify=CA_CERT,     # vérifie le serveur avec ca.crt
                    timeout=TIMEOUT
                )

                print(f"[CHANNELS] Statut : {r.status_code}")
                r.raise_for_status()

                ch = normaliser_chaines(r.json())
                if not ch:
                    ch = charger_chaines_locales()

                self.root.after(0, lambda: self._load_list(ch))

            except requests.exceptions.SSLError as e:
                print(f"[SSL] Erreur : {e} → fallback verify=False")
                try:
                    r = self.session.get(
                        MIDDLEWARE_BASE + ENDPOINT_CHANNELS,
                        cert=CLIENT_CERT,
                        verify=False,
                        timeout=TIMEOUT
                    )
                    r.raise_for_status()
                    ch = normaliser_chaines(r.json())
                    self.root.after(0, lambda: self._load_list(ch))
                except Exception:
                    self.root.after(0, lambda: self._load_list(charger_chaines_locales()))

            except requests.exceptions.ConnectionError:
                self.root.after(0, lambda: self._status(
                    "⚠ Middleware hors ligne — fichier local", C["yellow"]))
                self.root.after(0, lambda: self._load_list(charger_chaines_locales()))

            except Exception as e:
                print(f"[FETCH] Erreur : {e}")
                self.root.after(0, lambda: self._load_list(charger_chaines_locales()))

        threading.Thread(target=_run, daemon=True).start()

    def _load_list(self, chaines):
        """Met à jour la listbox avec les chaînes récupérées."""
        self.channels = chaines
        self.listbox.delete(0, tk.END)
        for i, ch in enumerate(self.channels):
            nom  = ch.get("nom", "?")
            pack = ch.get("pack", "")
            label = f"  {i+1:02d}  ▸  {nom}"
            if pack:
                label += f"  [{pack}]"
            self.listbox.insert(tk.END, label)
        self.count_lbl.config(text=f"[ {len(self.channels)} ]")
        self._status(f"✅ {len(self.channels)} chaîne(s) autorisées — refresh ↻{REFRESH_INTERVAL}s", C["cyan"])
        self.loading = False
        print(f"[LIST] {len(self.channels)} chaînes affichées")

    # ══════════════════════════════════════════════════════════════════════════
    # LECTURE — fonction clé n°2
    # ══════════════════════════════════════════════════════════════════════════

    def play(self):
        """
        Fonction clé n°2 — Lance la lecture du flux sélectionné.
        rtp:// → ffplay direct (multicast RTP via IGMP)
        http:// → yt-dlp + ffplay
        """
        sel = self.listbox.curselection()
        if not sel:
            messagebox.showwarning("Attention", "Sélectionne une chaîne !")
            return

        ch  = self.channels[sel[0]]
        url = ch.get("url", "")
        nom = ch.get("nom", "Chaîne")

        if not url:
            messagebox.showerror("Erreur", "URL introuvable.")
            return

        self.stop(silent=True)
        self._status(f"▶ {nom}", C["redhi"])
        self._thumb_live(nom)

        self._play_start = time.time()
        self.now_playing_lbl.config(text=f"▶  {nom}", fg=C["redhi"])
        self.now_url_lbl.config(
            text=f"⬡  {(url[:45] + '…') if len(url) > 45 else url}", fg=C["cyan2"])
        self.elapsed_lbl.config(text="⏱  00:00:00", fg=C["grey"])
        self._tick_elapsed()

        for lbl, txt in [
            (self.lbl_debit,          "analyse…"),
            (self.lbl_resolution,     "analyse…"),
            (self.lbl_localisation,   "recherche…"),
            (self.lbl_codec,          "analyse…"),
            (self.lbl_middleware_loc, "recherche…")
        ]:
            lbl.config(text=txt, fg=C["dim"])

        self._fetch_stream_info(url)
        self._fetch_localisation(url)

        try:
            if url.startswith("rtp://") or url.startswith("udp://"):
                print(f"[PLAY] RTP : {url}")
                self.proc = subprocess.Popen(
                    ["ffplay", "-fflags", "nobuffer", "-i", url],
                    stderr=subprocess.DEVNULL
                )
                self.lbl_debit.config(text="flux RTP direct", fg=C["cyan"])
            else:
                print(f"[PLAY] HTTP : {url}")
                p1 = subprocess.Popen(
                    ["yt-dlp", "-f", "best", "-o", "-", url],
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE
                )
                p2 = subprocess.Popen(
                    ["ffplay", "-"], stdin=p1.stdout, stderr=subprocess.DEVNULL)
                p1.stdout.close()
                self.proc_src = p1
                self.proc     = p2
                self._monitor_debit(p1)

        except FileNotFoundError:
            messagebox.showerror("Erreur",
                "ffplay introuvable.\nInstalle : sudo apt install ffmpeg")
            self._status("Erreur lecture", C["red"])

    # ══════════════════════════════════════════════════════════════════════════
    # STOP — fonction clé n°3
    # ══════════════════════════════════════════════════════════════════════════

    def stop(self, silent=False):
        """Fonction clé n°3 — Arrête proprement ffplay et yt-dlp."""
        for p in [self.proc, self.proc_src]:
            if p and p.poll() is None:
                p.terminate()
        self.proc = self.proc_src = self._play_start = None
        if not silent:
            self._status("■ Arrêté", C["grey"])
            self._thumb_idle()
            self.now_playing_lbl.config(text="▶  Aucune lecture en cours", fg=C["dim"])
            self.now_url_lbl.config(text="", fg=C["dim"])
            self.elapsed_lbl.config(text="")
            self._reset_stream_data()

    def _quit(self):
        """Fermeture propre — arrête le refresh et les processus."""
        self._refresh_actif = False  # arrête le refresh automatique
        self.stop(silent=True)
        self.root.destroy()


# ══════════════════════════════════════════════════════════════════════════════
# POINT D'ENTRÉE
# ══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    root = tk.Tk()
    IptvClient(root)
    root.mainloop()
