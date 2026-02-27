# FFmpeg Worker + Playwright Runner

Serviço HTTP único para:
- render de vídeo com FFmpeg (`/render`)
- automação web com Playwright (`/playwright/*`) para uso via n8n (HTTP Request)

## Stack

- `Express` + TypeScript
- Runtime padrão no container: `Node + tsx`
- `Playwright` (Chromium headless)
- `FFmpeg` no mesmo container

Observação: o projeto mantém suporte local com Bun via `npm run start:bun`, mas o deploy Docker foi ajustado para Node por robustez com Playwright.

## Endpoints

- `GET /health`
- `GET /`
- `POST /render`
- `POST /playwright/run` (Bearer obrigatório)
- `POST /playwright/save-state` (Bearer obrigatório)
- `GET /playwright/artifacts/:jobId/:filename` (Bearer obrigatório)

## Segurança Playwright

Todos os endpoints ` /playwright/* ` exigem:
- `Authorization: Bearer <PLAYWRIGHT_TOKEN>`

Proteções implementadas:
- allowlist de actions (sem `eval`/JS arbitrário)
- limite máximo de actions por job (`MAX_ACTIONS`)
- timeout total por job (`DEFAULT_TIMEOUT_MS`)
- allowlist de domínios por `ALLOW_DOMAINS`
- proteção contra path traversal em artefatos
- `uploadFromUrl` com limite de 10MB e somente `image/*`

## Variáveis de ambiente

### Playwright

- `PLAYWRIGHT_TOKEN` (obrigatório)
- `ALLOW_DOMAINS="x.com,linkedin.com"` (opcional; vazio permite qualquer domínio)
- `MAX_ACTIONS=50`
- `DEFAULT_TIMEOUT_MS=60000`
- `STORAGE_DIR=/app/storageStates`
- `OUTPUT_DIR=/app/outputs`
- `TMP_DIR=/app/tmp`

### Servidor/FFmpeg

- `PORT=10000`
- `MAX_AUDIO_DURATION_SEC=60`
- `FFMPEG_TIMEOUT_MS=180000`
- `FFMPEG_PRESET=veryfast`
- `FFMPEG_PATH=ffmpeg` (opcional)
- `FFPROBE_PATH=ffprobe` (opcional)
- `OUTPUT_ROOT` e `OUTPUT_BASE_URL` (fluxo FFmpeg existente)

## Contrato `POST /playwright/run`

Header:

```bash
Authorization: Bearer <PLAYWRIGHT_TOKEN>
Content-Type: application/json
```

Body:

```json
{
  "session": "x-main",
  "timeoutMs": 60000,
  "actions": [
    { "action": "goto", "url": "https://x.com/home", "waitUntil": "domcontentloaded" },
    { "action": "click", "selector": "button[data-testid='SideNav_NewTweet_Button']" },
    { "action": "fill", "selector": "div[role='textbox'][data-testid='tweetTextarea_0']", "text": "Olá do n8n" },
    { "action": "screenshot", "name": "x-compose", "fullPage": false },
    { "action": "extractText", "selector": "title", "key": "pageTitle" }
  ]
}
```

Formato curto também é aceito:

```json
{ "goto": { "url": "https://x.com" } }
```

Actions permitidas:
- `goto { url, waitUntil? }`
- `click { selector, delayMs? }`
- `fill { selector, text }`
- `press { selector, key }`
- `waitFor { selector?, state?, timeoutMs? }`
- `upload { selector, path }`
- `uploadFromUrl { selector, url }`
- `screenshot { name, fullPage? }`
- `extractText { selector, key }`
- `extractAttr { selector, attr, key }`
- `saveStorage { session }`

Resposta de sucesso:

```json
{
  "ok": true,
  "jobId": "f2ceecf4-5134-4a10-aef6-08ac403c7524",
  "tookMs": 7342,
  "outputs": {
    "artifacts": [
      {
        "name": "x-compose",
        "filename": "x-compose.png",
        "url": "/playwright/artifacts/f2ceecf4-5134-4a10-aef6-08ac403c7524/x-compose.png"
      }
    ],
    "extracted": {
      "pageTitle": "Home / X"
    },
    "storage": []
  },
  "logs": ["..."]
}
```

Resposta de erro:

```json
{
  "ok": false,
  "error": "mensagem",
  "details": {},
  "logs": []
}
```

## `POST /playwright/save-state`

Duas formas:

1. Salvar `storageState` recebido no body:

```json
{
  "session": "x-main",
  "storageState": { "cookies": [], "origins": [] }
}
```

2. Executar actions e salvar no final:

```json
{
  "session": "x-main",
  "actions": [
    { "action": "goto", "url": "https://x.com/home" },
    { "action": "waitFor", "selector": "[data-testid='SideNav_NewTweet_Button']", "timeoutMs": 15000 }
  ]
}
```

O endpoint adiciona automaticamente `saveStorage { session }` no final do job.

## Sessões persistentes

- Se a requisição vier com `"session": "x-main"` e existir `storageStates/x-main.json`, o runner carrega esse estado no `newContext`.
- A action `saveStorage` persiste estado em `STORAGE_DIR/<session>.json`.

## Artefatos

- Screenshots ficam em `OUTPUT_DIR/<jobId>/`.
- Download via `GET /playwright/artifacts/:jobId/:filename` com Bearer token.

## Exemplo cURL (n8n-friendly)

### 1) Publicar texto no X (demonstração)

```bash
curl -X POST "http://localhost:10000/playwright/run" \
  -H "Authorization: Bearer $PLAYWRIGHT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "session": "x-main",
    "actions": [
      {"action":"goto","url":"https://x.com/home"},
      {"action":"click","selector":"button[data-testid=\"SideNav_NewTweet_Button\"]"},
      {"action":"fill","selector":"div[data-testid=\"tweetTextarea_0\"]","text":"Post automatizado via n8n"},
      {"action":"click","selector":"button[data-testid=\"tweetButton\"]"},
      {"action":"screenshot","name":"x-post-ok"}
    ]
  }'
```

### 2) Publicar texto + imagem (`uploadFromUrl`)

```bash
curl -X POST "http://localhost:10000/playwright/run" \
  -H "Authorization: Bearer $PLAYWRIGHT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "session": "x-main",
    "actions": [
      {"action":"goto","url":"https://x.com/home"},
      {"action":"click","selector":"button[data-testid=\"SideNav_NewTweet_Button\"]"},
      {"action":"fill","selector":"div[data-testid=\"tweetTextarea_0\"]","text":"Post com imagem via Playwright Runner"},
      {"action":"uploadFromUrl","selector":"input[type=\"file\"]","url":"https://images.unsplash.com/photo-1469474968028-56623f02e42e"},
      {"action":"click","selector":"button[data-testid=\"tweetButton\"]"},
      {"action":"screenshot","name":"x-post-image-ok"}
    ]
  }'
```

## n8n: payload pronto (HTTP Request)

### Texto

```json
{
  "session": "x-main",
  "actions": [
    {"action":"goto","url":"https://x.com/home"},
    {"action":"click","selector":"button[data-testid='SideNav_NewTweet_Button']"},
    {"action":"fill","selector":"div[data-testid='tweetTextarea_0']","text":"{{$json.text}}"},
    {"action":"click","selector":"button[data-testid='tweetButton']"},
    {"action":"screenshot","name":"posted-text"}
  ]
}
```

### Texto + imagem (uploadFromUrl)

```json
{
  "session": "x-main",
  "actions": [
    {"action":"goto","url":"https://x.com/home"},
    {"action":"click","selector":"button[data-testid='SideNav_NewTweet_Button']"},
    {"action":"fill","selector":"div[data-testid='tweetTextarea_0']","text":"{{$json.text}}"},
    {"action":"uploadFromUrl","selector":"input[type='file']","url":"{{$json.imageUrl}}"},
    {"action":"click","selector":"button[data-testid='tweetButton']"},
    {"action":"screenshot","name":"posted-image"}
  ]
}
```

No n8n, configure:
- Método: `POST`
- URL: `https://seu-servico/playwright/run`
- Header: `Authorization: Bearer <PLAYWRIGHT_TOKEN>`
- Content-Type: `application/json`

## Gerar storageState manualmente (headful)

Script:

```bash
npm run save-state -- --session x-main --url https://x.com/login
```

Fluxo:
1. O Chromium abre em modo visual.
2. Faça login manualmente.
3. Volte ao terminal e pressione `ENTER`.
4. O estado será salvo em `STORAGE_DIR/x-main.json`.

## Rodar local com Docker

Build:

```bash
docker build -t ffmpeg-playwright-runner .
```

Run:

```bash
docker run --rm -p 10000:10000 \
  -e PORT=10000 \
  -e PLAYWRIGHT_TOKEN=seu-token-forte \
  -e ALLOW_DOMAINS="x.com,images.unsplash.com" \
  -e STORAGE_DIR=/app/storageStates \
  -e OUTPUT_DIR=/app/outputs \
  -e TMP_DIR=/app/tmp \
  ffmpeg-playwright-runner
```

Healthcheck:

```bash
curl http://localhost:10000/health
```
