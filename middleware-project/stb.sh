#!/bin/bash

# ==========================================
# PROJET IPTV - SET-TOP BOX (VERSION FINALE)
# Option : mTLS + JSON Parser AWK + HDMI-CEC
# ==========================================

# --- CONFIGURATION ---
CONFIG_FILE="./channels.conf"
MIDDLEWARE_URL="https://192.168.10.40:3000/auth/me"
CERT_DIR="."   # dossier contenant ca.crt, stb-01.crt, stb-01.key

declare -A CHANNEL_NAMES
declare -A CHANNEL_URLS

CURRENT_CH=1
MAX_CH=0
CURRENT_URL=""   # URL de la chaîne en cours de lecture

TMP_INPUT=""
LAST_INPUT_TIME=0
INPUT_TIMEOUT=2

WATCH_PID=""

# ==========================================
# COMMUNICATION SÉCURISÉE (MIDDLEWARE)
# Appelle GET /auth/me avec certificat mTLS
# Reçoit : { channels:[{id, name, multicast:{url}}] }
# ==========================================
fetch_middleware() {
    echo "[*] Authentification mTLS auprès du Middleware..."

    curl -sk \
        --cacert "$CERT_DIR/ca.crt" \
        --cert   "$CERT_DIR/stb-01.crt" \
        --key    "$CERT_DIR/stb-01.key" \
        "$MIDDLEWARE_URL" > /tmp/CHAINES.json

    if [ ! -s /tmp/CHAINES.json ]; then
        echo "[!] Echec de connexion au Middleware."
        echo "[!] Utilisation du fichier de configuration local (cache)."
        return 1
    fi

    echo "[+] Réponse reçue. Extraction des données..."

    # ── Parser AWK pour la structure imbriquée de /auth/me ──────
    # Format JSON reçu :
    # { "channels": [
    #     { "id": 515,
    #       "name": "BFM TV",
    #       "multicast": { "url": "rtp://@239.255.10.1:5001" }
    #     }, ...
    # ]}
    # "url" est DANS multicast → on active in_multicast pour le trouver
    awk '
    BEGIN { id=""; name=""; url=""; in_multicast=0 }
    {
        # Extrait "id": 515
        if (match($0, /"id":[[:space:]]*([0-9]+)/, arr))
            id = arr[1]

        # Extrait "name": "BFM TV"
        if (match($0, /"name":[[:space:]]*"([^"]+)"/, arr))
            name = arr[1]

        # Détecte le bloc "multicast": {
        if ($0 ~ /"multicast"/)
            in_multicast = 1

        # Extrait "url": "rtp://..." DANS multicast
        if (in_multicast && match($0, /"url":[[:space:]]*"([^"]+)"/, arr)) {
            url = arr[1]
            in_multicast = 0
        }

        # Quand les 3 champs sont remplis → écrit la ligne
        if (id != "" && name != "" && url != "") {
            print id " | " name " | " url
            id=""; name=""; url=""
        }
    }
    ' /tmp/CHAINES.json > "$CONFIG_FILE"

    if [ -s "$CONFIG_FILE" ]; then
        local count
        count=$(wc -l < "$CONFIG_FILE")
        echo "[+] $count chaine(s) chargee(s) :"
        cat "$CONFIG_FILE"
    else
        echo "[!] Erreur : parsing JSON échoué."
        echo "[!] Contenu brut reçu :"
        cat /tmp/CHAINES.json
        return 1
    fi
}

# ==========================================
# SURVEILLANCE DES DROITS (toutes les 30s)
# Si la chaîne en cours est révoquée → coupe cvlc
# ==========================================
watch_rights() {
    echo "[*] Surveillance des droits démarrée (30s)"

    while true; do
        sleep 30

        curl -sk \
            --cacert "$CERT_DIR/ca.crt" \
            --cert   "$CERT_DIR/stb-01.crt" \
            --key    "$CERT_DIR/stb-01.key" \
            "$MIDDLEWARE_URL" > /tmp/CHAINES_refresh.json 2>/dev/null

        [ ! -s /tmp/CHAINES_refresh.json ] && continue

        # Récupère toutes les URLs autorisées après refresh
        AUTHORIZED_URLS=$(awk '
        BEGIN { in_multicast=0 }
        {
            if ($0 ~ /"multicast"/) in_multicast=1
            if (in_multicast && match($0, /"url":[[:space:]]*"([^"]+)"/, arr)) {
                print arr[1]
                in_multicast=0
            }
        }
        ' /tmp/CHAINES_refresh.json)

        # Vérifie si la chaîne en cours est encore autorisée
        if [ -n "$CURRENT_URL" ]; then
            if ! echo "$AUTHORIZED_URLS" | grep -qF "$CURRENT_URL"; then
                echo "[!] ACCÈS RÉVOQUÉ → arrêt de la chaîne en cours"
                pkill -9 vlc 2>/dev/null
                CURRENT_URL=""

                # Recharge la nouvelle liste de chaînes
                awk '
                BEGIN { id=""; name=""; url=""; in_multicast=0 }
                {
                    if (match($0, /"id":[[:space:]]*([0-9]+)/, arr)) id=arr[1]
                    if (match($0, /"name":[[:space:]]*"([^"]+)"/, arr)) name=arr[1]
                    if ($0 ~ /"multicast"/) in_multicast=1
                    if (in_multicast && match($0, /"url":[[:space:]]*"([^"]+)"/, arr)) {
                        url=arr[1]; in_multicast=0
                    }
                    if (id!="" && name!="" && url!="") {
                        print id " | " name " | " url
                        id=""; name=""; url=""
                    }
                }
                ' /tmp/CHAINES_refresh.json > "$CONFIG_FILE"

                # Recharge en mémoire
                unset CHANNEL_NAMES CHANNEL_URLS
                declare -gA CHANNEL_NAMES
                declare -gA CHANNEL_URLS
                MAX_CH=0
                load_channels

                # Relance sur la première chaîne encore autorisée
                for ch in $(seq 1 "$MAX_CH"); do
                    if [[ -n "${CHANNEL_URLS[$ch]}" ]]; then
                        CURRENT_CH="$ch"
                        launch_vlc "$CURRENT_CH"
                        break
                    fi
                done
            fi
        fi
    done
}

# ==========================================
# MOTEUR DE LECTURE VIDÉO
# Lance cvlc sur l'URL multicast reçue du middleware
# ==========================================
launch_vlc() {
    local ch="$1"
    local url="${CHANNEL_URLS[$ch]}"
    local name="${CHANNEL_NAMES[$ch]}"

    [ -z "$url" ] && echo "[!] Aucune URL pour canal $ch" && return

    echo "--------------------------------"
    echo "ZAPPING → CANAL $ch : $name"
    echo "URL     → $url"
    echo "--------------------------------"

    # Arrête le flux précédent
    pkill -9 vlc 2>/dev/null
    sleep 0.3

    # Mémorise l'URL en cours pour la surveillance
    CURRENT_URL="$url"

    # Signal HDMI-CEC pour activer la TV
    echo "as" | cec-client -s -d 1 2>/dev/null

    # Lance cvlc sur l'URL multicast rtp://@239.255.x.x:5001
    cvlc "$url" \
        --fullscreen \
        --no-video-title-show \
        --network-caching=500 \
        2>/dev/null &
}

# ==========================================
# LOGIQUE DE NAVIGATION (TÉLÉCOMMANDE)
# ==========================================
trim() {
    local s="$1"
    s="${s//$'\r'/}"
    s="${s#"${s%%[![:space:]]*}"}"
    s="${s%"${s##*[![:space:]]}"}"
    printf '%s' "$s"
}

load_channels() {
    [ ! -f "$CONFIG_FILE" ] && echo "[!] Pas de config." && return

    while IFS='|' read -r num name url; do
        num="$(trim "$num")"
        name="$(trim "$name")"
        url="$(trim "$url")"
        [[ -z "$num" || "$num" =~ ^# || ! "$num" =~ ^[0-9]+$ ]] && continue
        CHANNEL_NAMES["$num"]="$name"
        CHANNEL_URLS["$num"]="$url"
        (( num > MAX_CH )) && MAX_CH=$num
    done < "$CONFIG_FILE"

    echo "[+] $MAX_CH canal/canaux en mémoire."
}

commit_pending_input() {
    if [[ -n "$TMP_INPUT" && -n "${CHANNEL_URLS[$TMP_INPUT]}" ]]; then
        CURRENT_CH="$TMP_INPUT"
        launch_vlc "$CURRENT_CH"
    fi
    TMP_INPUT=""
}

handle_number() {
    local digit="$1"
    local now
    now=$(date +%s)
    (( now - LAST_INPUT_TIME > INPUT_TIMEOUT )) && TMP_INPUT=""
    TMP_INPUT="${TMP_INPUT}${digit}"
    LAST_INPUT_TIME=$now
    echo "Saisie : $TMP_INPUT"
    if (( ${#TMP_INPUT} >= 2 )); then
        commit_pending_input
    fi
}

next_channel() {
    local start="$CURRENT_CH"
    while true; do
        ((CURRENT_CH++))
        (( CURRENT_CH > MAX_CH )) && CURRENT_CH=1
        [[ -n "${CHANNEL_URLS[$CURRENT_CH]}" ]] && launch_vlc "$CURRENT_CH" && return
        [[ "$CURRENT_CH" -eq "$start" ]] && return
    done
}

prev_channel() {
    local start="$CURRENT_CH"
    while true; do
        ((CURRENT_CH--))
        (( CURRENT_CH < 1 )) && CURRENT_CH=$MAX_CH
        [[ -n "${CHANNEL_URLS[$CURRENT_CH]}" ]] && launch_vlc "$CURRENT_CH" && return
        [[ "$CURRENT_CH" -eq "$start" ]] && return
    done
}

cleanup() {
    echo "[*] Arrêt STB..."
    pkill -9 vlc        2>/dev/null
    pkill -f cec-client 2>/dev/null
    [ -n "$WATCH_PID" ] && kill "$WATCH_PID" 2>/dev/null
    exit 0
}

# ==========================================
# INITIALISATION ET LANCEMENT
# ==========================================
trap cleanup INT TERM
clear

echo "========================================="
echo "     STB IPTV CIEL 2026 - HDMI CEC"
echo "========================================="
echo "Middleware : $MIDDLEWARE_URL"

# Vérifie les certificats
for f in ca.crt stb-01.crt stb-01.key; do
    if [ ! -f "$CERT_DIR/$f" ]; then
        echo "[!] Certificat manquant : $CERT_DIR/$f"
        exit 1
    fi
done

# 1. Récupère les chaînes autorisées depuis le middleware
fetch_middleware || echo "[!] Démarrage en mode cache"

# 2. Charge les chaînes en mémoire
load_channels

if [ "$MAX_CH" -eq 0 ]; then
    echo "[!] Aucune chaîne disponible."
    exit 1
fi

# 3. Lance la première chaîne autorisée
for ch in $(seq 1 "$MAX_CH"); do
    if [[ -n "${CHANNEL_URLS[$ch]}" ]]; then
        CURRENT_CH="$ch"
        launch_vlc "$CURRENT_CH"
        break
    fi
done

# 4. Surveillance des droits en arrière-plan
watch_rights &
WATCH_PID=$!
echo "[*] Surveillance PID : $WATCH_PID"

# 5. Écoute HDMI-CEC
echo "[*] En attente commandes télécommande..."
exec 3< <(cec-client -d 8)

while true; do
    if IFS= read -r -t 0.2 line <&3; then
        [[ "$line" != *"44:"* ]] && continue
        code=$(echo "$line" | sed -n 's/.*44:\([0-9A-F][0-9A-F]\).*/\1/p')
        case "$code" in
            01) next_channel ;;
            02) prev_channel ;;
            20) handle_number 0 ;;
            21) handle_number 1 ;;
            22) handle_number 2 ;;
            23) handle_number 3 ;;
            24) handle_number 4 ;;
            25) handle_number 5 ;;
            26) handle_number 6 ;;
            27) handle_number 7 ;;
            28) handle_number 8 ;;
            29) handle_number 9 ;;
        esac
    fi

    now=$(date +%s)
    [[ -n "$TMP_INPUT" ]] && \
        (( now - LAST_INPUT_TIME >= INPUT_TIMEOUT )) && \
        commit_pending_input
done
