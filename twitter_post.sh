#!/bin/bash

# Script para logar no Twitter (X) e fazer um post usando o Playwright Service.
# Configure suas credenciais abaixo:

TOKEN="3c535f2ad0b96c4c7f5bba3f61199cc800888de7b952b8b6802ed7a96d73004b"
URL="https://ffmpeg-7c7v.onrender.com/playwright/run"

USERNAME="wilkhp29"
PASSWORD="hElpdE$k2@!4"
TWEET_TEXT="Postado via Playwright Service! 🚀 #automation #playwright"

echo "Enviando requisição de automação para o Twitter..."

curl -s -X POST "$URL" \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d "{
       \"timeoutMs\": 90000,
       \"actions\": [
         { \"action\": \"goto\", \"url\": \"https://x.com/i/flow/login\" },
         { \"action\": \"waitFor\", \"selector\": \"input[name='text']\", \"timeoutMs\": 20000 },
         { \"action\": \"fill\", \"selector\": \"input[name='text']\", \"text\": \"$USERNAME\" },
         { \"action\": \"press\", \"selector\": \"input[name='text']\", \"key\": \"Enter\" },
         { \"action\": \"waitFor\", \"selector\": \"input[name='password']\", \"timeoutMs\": 10000 },
         { \"action\": \"fill\", \"selector\": \"input[name='password']\", \"text\": \"$PASSWORD\" },
         { \"action\": \"press\", \"selector\": \"input[name='password']\", \"key\": \"Enter\" },
         { \"action\": \"waitFor\", \"selector\": \"[data-testid='tweetTextarea_0']\", \"timeoutMs\": 30000 },
         { \"action\": \"fill\", \"selector\": \"[data-testid='tweetTextarea_0']\", \"text\": \"$TWEET_TEXT\" },
         { \"action\": \"click\", \"selector\": \"[data-testid='tweetButtonInline']\" },
         { \"action\": \"screenshot\", \"name\": \"twitter_post_done\" }
       ]
     }" | python3 -m json.tool

echo -e "\nJob finalizado. Verifique os logs acima para o resultado."
