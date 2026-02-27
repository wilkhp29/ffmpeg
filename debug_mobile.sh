#!/bin/bash

TOKEN="3c535f2ad0b96c4c7f5bba3f61199cc800888de7b952b8b6802ed7a96d73004b"
URL="https://ffmpeg-7c7v.onrender.com"
SESSION_NAME="twitter_wilkhp29"

# Proxy Reino Unido
PROXY_SERVER="http://31.59.20.176:6754"
PROXY_USER="eddvgndb"
PROXY_PASS="ty8jhulwy2ts"

curl -s -X POST "$URL/playwright/run" \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d "{
       \"session\": \"$SESSION_NAME\",
       \"timeoutMs\": 60000,
       \"userAgent\": \"Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1\",
       \"viewport\": { \"width\": 390, \"height\": 844 },
       \"blockResources\": [\"font\"],
       \"proxy\": {
         \"server\": \"$PROXY_SERVER\",
         \"username\": \"$PROXY_USER\",
         \"password\": \"$PROXY_PASS\"
       },
       \"actions\": [
         { \"action\": \"goto\", \"url\": \"https://x.com/compose/post\", \"waitUntil\": \"commit\" },
         { \"action\": \"waitFor\", \"timeoutMs\": 15000 },
         { \"action\": \"screenshot\", \"name\": \"debug_mobile_state\" }
       ]
     }" | python3 -m json.tool
