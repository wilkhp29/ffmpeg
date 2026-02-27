#!/bin/bash

# Este script demonstra como usar o Playwright via API HTTP do projeto.

TOKEN="3c535f2ad0b96c4c7f5bba3f61199cc800888de7b952b8b6802ed7a96d73004b"
URL="http://localhost:3000/playwright/run"

echo "Enviando requisição para executar Playwright..."

curl -X POST "$URL" \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d '{
       "timeoutMs": 60000,
       "actions": [
         { "action": "goto", "url": "https://www.google.com" },
         { "action": "screenshot", "name": "google_home" },
         { "action": "extractText", "selector": "title", "key": "page_title" }
       ]
     }'

echo -e "\n\nJob finalizado."
