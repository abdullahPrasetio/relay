# Relay

Relay adalah API client lokal-first untuk HTTP, GraphQL, WebSocket, MQTT,
Socket.IO, dan gRPC. Data tersimpan di mesin sendiri, dengan dukungan opsional
Relay Cloud, mock server, dokumentasi otomatis, dan MCP server untuk klien AI.

## Fitur utama

- HTTP request lengkap: query/path variable, header (bulk edit + preset), body raw/JSON/form/GraphQL + schema,
  redirect, timeout, abort, cookie jar, proxy, custom CA, mTLS, dan respons binary.
- Auth: bearer, basic, API key, OAuth 1.0, OAuth 2.0 (authorization code + PKCE,
  client credentials, password, refresh), Digest, NTLM, AWS SigV4, dan JWT.
- Script pre-request/test dengan sandbox `vm`, `pm.*` API, snippets, dan paket
  `crypto-js`/`moment`/`uuid`.
- Collection runner: retry, stop, data CSV, conditional flow, dan report
  JSON/JUnit/HTML.
- Import Postman v2.1, OpenAPI 3, Swagger 2, HAR, cURL, dan Insomnia.
- Dokumentasi collection: HTML mandiri, Confluence, OpenAPI 3, plus validasi
  request/response yang bisa diwarisi dari collection/folder.
- Mock server lokal dan server mock Relay Cloud dengan skenario.
- Workspace Git-friendly, backup/restore, Relay Cloud sync, komentar, member,
  device, dan monitor terjadwal.
- MCP server lokal opt-in dengan scope, approval, audit, dan redaksi secret.

## Mulai cepat

Prasyarat: Node.js 22+ dan npm.

```bash
npm install
npm run build:vite   # build renderer + main
npm start            # Electron memakai build di dist/

npm run dev          # renderer Vite saja, untuk pengembangan UI
```

Build produksi:

```bash
npm run dist          # macOS arm64
npm run dist:universal
npm run dist:win
npm run dist:linux
```

## Verifikasi

```bash
npm run lint
npm test
npm run test:e2e      # build + Playwright Electron
npm run check         # lint + unit + build
```

## Dokumentasi

| Dokumen | Isi |
|---|---|
| [docs/features.md](docs/features.md) | Referensi lengkap semua fitur, model data, batas, dan alur kerja |
| [docs/ai-guide.md](docs/ai-guide.md) | Panduan AI/MCP: discovery, tool, approval, workflow aman |
| [docs/mcp-server.md](docs/mcp-server.md) | Setup MCP, token/scope, HTTP/stdio, tool, troubleshooting |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Batas proses, IPC, persistensi, protokol, keamanan |
| [ROADMAP.md](ROADMAP.md) | Status parity Postman dan keputusan produk |
| [RELEASING.md](RELEASING.md) | Versioning, signing, rilis, auto-update |
| [docs/README.md](docs/README.md) | Indeks seluruh dokumen |

## Keamanan

- Renderer tidak punya akses Node; semua I/O dan jaringan lewat IPC main.
- Script berjalan di sandbox dengan trust gate untuk collection hasil import.
- Secret memakai `safeStorage`; plaintext tidak ditulis ke disk dan diredaksi
  dari export serta hasil MCP secara default.
- MCP bersifat opt-in, loopback-only, token per klien, scope terpisah, dan
  approval untuk aksi non-read.

## Lisensi

MIT.
