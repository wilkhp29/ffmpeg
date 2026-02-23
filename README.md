# FFmpeg Worker (URL mode) para Render

Serviço HTTP em Bun + Express (TypeScript) que recebe URLs de áudio/imagens, gera um vídeo vertical MP4 (1080x1920, 30fps) com FFmpeg e devolve o binário pronto para YouTube Shorts.

## Recursos

- `GET /health` -> `200 ok`
- `GET /` -> `200 ok`
- `POST /render` -> retorna `video/mp4` binário
- Entrada em JSON (`application/json`)
- Download de arquivos por URL com:
  - timeout de 30s por arquivo
  - limite de 50MB por arquivo
  - validação de `content-type`
  - suporte a redirects
- Slideshow via concat demuxer com repetição da última imagem quando o áudio é maior
- Overlay de texto opcional (`drawtext`) com fallback automático sem texto se fonte/drawtext falhar
- Mutex em memória: 1 job por vez (útil no plano free)
- Limite de duração de áudio (default: `60s`) para reduzir risco de timeout/queda
- Timeout de FFmpeg configurável (default: `180000ms`)
- Resposta do vídeo em streaming (evita carregar o MP4 inteiro em memória)

## Estrutura

```text
.
├── .dockerignore
├── .gitignore
├── Dockerfile
├── README.md
├── package.json
└── server.ts
```

## Contrato da API

`POST /render` com JSON:

```json
{
  "audio_url": "https://exemplo.com/audio.mp3",
  "image_urls": [
    "https://exemplo.com/img1.jpg",
    "https://exemplo.com/img2.png"
  ],
  "script": "Texto opcional de overlay",
  "title": "Opcional",
  "seconds_per_image": 3
}
```

Validações:
- `audio_url` obrigatório
- `image_urls` obrigatório (`1..10`)
- `seconds_per_image` opcional (default `3`, aceito `> 0` e `<= 20`)
- duração máxima de áudio (default `60s`)

## Rodando local com Docker

1. Build da imagem:

```bash
docker build -t ffmpeg-worker-url .
```

2. Subir container:

```bash
docker run --rm -p 3000:3000 -e PORT=3000 ffmpeg-worker-url
```

3. Healthcheck:

```bash
curl http://localhost:3000/health
```

## Teste com curl (retorno MP4 binário)

```bash
curl -X POST "http://localhost:3000/render" \
  -H "Content-Type: application/json" \
  -d '{
    "audio_url":"https://seu-host/audio.mp3",
    "image_urls":[
      "https://seu-host/img1.jpg",
      "https://seu-host/img2.png"
    ],
    "script":"Meu texto opcional",
    "seconds_per_image":3
  }' \
  --output output.mp4
```

Depois valide o arquivo:

```bash
ffprobe -v error -show_entries stream=codec_name,width,height,r_frame_rate -of compact=p=0:nk=1 output.mp4
```

## Deploy no Render (Free)

1. Suba este projeto para um repositório Git (GitHub/GitLab).
2. No Render: **New** -> **Web Service**.
3. Conecte o repositório.
4. Em runtime, escolha **Docker**.
5. Plano: **Free**.
6. `Start Command`: deixe em branco (o `CMD ["bun","run","start"]` já está no Dockerfile).
7. Configure o health check path para `/health`.
8. Clique em **Create Web Service**.

Render injeta `PORT` automaticamente. O servidor já usa `process.env.PORT`.

Variáveis opcionais de runtime:
- `MAX_AUDIO_DURATION_SEC` (default `60`)
- `FFMPEG_TIMEOUT_MS` (default `180000`)
- `FFMPEG_PRESET` (default `veryfast`)
- `FFMPEG_PATH` e `FFPROBE_PATH` (opcional)

## Observações importantes

- No plano free, existe **cold start** após inatividade.
- Para reduzir latência inicial, você pode pingar `GET /health` periodicamente.
- O endpoint retorna `video/mp4` diretamente no body da resposta (binário).
