#!/bin/bash

# SCRIPT PRO MAX - Twitter Post via URL (ROBUSTO V2)
# Uso: ./twitter_post_image.sh "URL_DA_IMAGEM" "TEXTO_DO_TWEET"

TOKEN="demo_token"
URL="http://localhost:3000"
SESSION_NAME="twitter_wilkhp29"

# Argumentos ou Defaults
IMAGE_URL=${1:-"https://api.memegen.link/images/custom/Pizza_grande_calabresa_na_promossao.png?background=https://images.unsplash.com/photo-1565299624946-b28f40a0ae38%3Fcrop%3Dentropy%26cs%3Dtinysrgb%26fit%3Dmax%26fm%3Djpg%26ixid%3DM3w4ODEyOTF8MHwxfGFsbHx8fHx8fHx8fDE3NzIxNTExNTN8%26ixlib%3Drb-4.1.0%26q%3D80%26w%3D1080%26w%3D1080%26h%3D1080%26fit%3Dcrop%26auto%3Dformat"}
TWEET_TEXT=${2:-"Postando imagem dinâmica! 🚀 #automation #playwright #x #success"}

# Proxy Reino Unido
PROXY_SERVER="http://31.59.20.176:6754"
PROXY_USER="eddvgndb"
PROXY_PASS="ty8jhulwy2ts"

echo "1. Sincronizando sessão no Localhost..."
curl -s -X POST "$URL/playwright/save-state" \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d "{
       \"session\": \"$SESSION_NAME\",
       \"storageState\": $(cat tools/twitter_session.json)
     }" | grep -q "ok" || { echo "Falha na sessão"; exit 1; }

echo "2. Gerando Payload JSON seguro via Python..."
# Criamos o JSON usando Python para garantir que caracteres especiais na URL não quebrem o JSON
JSON_PAYLOAD=$(python3 -c "
import json, sys

image_url = sys.argv[1]
tweet_text = sys.argv[2]
session_name = sys.argv[3]
proxy_server = sys.argv[4]
proxy_user = sys.argv[5]
proxy_pass = sys.argv[6]

payload = {
    'session': session_name,
    'timeoutMs': 120000,
    'proxy': {
        'server': proxy_server,
        'username': proxy_user,
        'password': proxy_pass
    },
    'actions': [
        { 'action': 'goto', 'url': 'https://x.com/home', 'waitUntil': 'commit' },
        { 'action': 'waitFor', 'timeoutMs': 30000 },
        # Fechar banner de cookies se existir
        { 
            'action': 'evaluate', 
            'script': '(text) => { const btns = Array.from(document.querySelectorAll(\"button\")); const btn = btns.find(b => b.textContent.includes(\"Accept all cookies\") || b.textContent.includes(\"Aceitar todos os cookies\")); if(btn) { btn.click(); return \"clicked\"; } return \"not_found\"; }'
        },
        # Upload da imagem
        { 'action': 'uploadFromUrl', 'selector': 'input[data-testid=\"fileInput\"]', 'url': image_url },
        { 'action': 'waitFor', 'selector': '[data-testid=\"attachments\"]', 'timeoutMs': 30000 },
        # Preencher texto usando evaluate com argumento seguro
        { 
            'action': 'evaluate', 
            'script': '(text) => { const el = document.querySelector(\"[data-testid=\\\"tweetTextarea_0\\\"]\"); if(el) { el.innerText = text; el.dispatchEvent(new Event(\"input\", { bubbles: true })); return true; } return false; }',
            'arg': tweet_text,
            'key': 'fill_status'
        },
        # Clicar no botão Postar
        { 
            'action': 'evaluate', 
            'script': '() => { const btn = document.querySelector(\"[data-testid=\\\"tweetButtonInline\\\"]\"); if(btn) { btn.click(); return true; } return false; }',
            'key': 'click_status'
        },
        { 'action': 'screenshot', 'name': 'final_post_result' }
    ]
}
print(json.dumps(payload))
" "$IMAGE_URL" "$TWEET_TEXT" "$SESSION_NAME" "$PROXY_SERVER" "$PROXY_USER" "$PROXY_PASS")

echo "3. Postando Imagem Dinâmica..."
curl -s -X POST "$URL/playwright/run" \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d "$JSON_PAYLOAD" | python3 -m json.tool

echo -e "\nFinalizado. Verifique seu Twitter!"
