# Relay — Referensi Fitur Lengkap

Dokumen ini adalah referensi produk dan operasional Relay. Isinya menjelaskan
fitur yang tersedia, bentuk data, aturan warisan, batas keamanan, dan tempat
mencari detail implementasi. Untuk arsitektur proses dan kontrak IPC, lihat
[ARCHITECTURE.md](../ARCHITECTURE.md).

Versi dokumen: Relay `0.32.x`.

## 1. Prinsip produk

1. **Local-first.** Workspace, request, environment, secret, cookie, history,
   dan session tersimpan di mesin pengguna. Relay Cloud opsional.
2. **Satu mesin untuk UI, CLI, dan MCP.** Request, runner, import/export, docs,
   mock, dan validasi memakai helper yang sama agar hasil tidak berbeda.
3. **Data loss tidak diterima.** Store memakai `schemaVersion`, backup `.bak`,
   dan normalisasi saat load.
4. **Secret tidak pernah menjadi plaintext di disk.** Nilai `type: "secret"`
   dienkripsi lewat Electron `safeStorage`; export dan MCP meredaksinya.
5. **Aksi berisiko butuh keputusan eksplisit.** Script import tidak otomatis
   dipercaya; MCP write/request butuh scope dan approval.

## 2. Peta UI

| Area | Fungsi |
|---|---|
| Activity rail | Collections, Environments, History, Docs |
| Header | Workspace switcher, environment pill, cloud/MCP/settings, tema |
| Sidebar | Tree collection/folder/request, pencarian global, pin, import/export |
| Request editor | Method/URL, Params, Authorization, Headers, Body, Pre-request, Tests, Examples, Docs, Mock |
| Response pane | Pretty/Raw/Preview, JSON tree, search, diff, save, timing, cookies |
| Runner | Jalankan collection/folder dengan retry, data, stop, report |
| Dashboard | Recent requests, pinned requests, quick actions, shortcut hints |
| Command palette | `Cmd/Ctrl+K` untuk membuka request/collection/action |
| Modal | Collection editor, environment, cookies, MCP, cloud, mock, docs, settings |

Shortcut global:

| Shortcut | Aksi |
|---|---|
| `Cmd/Ctrl+Enter` | Kirim request aktif |
| `Cmd/Ctrl+S` | Simpan request |
| `Cmd/Ctrl+W` | Tutup tab |
| `Cmd/Ctrl+K` | Command palette |

Tab, split pane, request aktif, dan posisi split dipulihkan setelah restart.
Tab dashboard juga dipulihkan sebagai dashboard, bukan request kosong.

## 3. Model data

```text
Workspace
  collections[]
    collection
      fieldValidations / responseValidations   (warisan)
      items[]
        folder
          fieldValidations / responseValidations (warisan)
          items[] (folder/request)
        request
  environments[]
  globals[]
  history[]
  cookieJar / network / mcp / mockServer      (main-side)
```

### 3.1 Request

```json
{
  "id": "req_...",
  "name": "Create merchant",
  "description": "",
  "method": "POST",
  "url": "https://api.example.com/merchants",
  "params": [{ "key": "tenant", "value": "acme", "enabled": true }],
  "pathVars": [{ "key": "id", "value": "1", "enabled": true }],
  "headers": [{ "key": "Accept", "value": "application/json", "enabled": true }],
  "body": {
    "mode": "none | raw | json | form-urlencoded | form-data | graphql",
    "raw": "",
    "rawFormat": "text | json | javascript | html | xml",
    "schema": "",
    "form": [{ "key": "field", "value": "value", "enabled": true }],
    "graphql": { "query": "", "variables": "" }
  },
  "auth": { "type": "inherit" },
  "settings": {
    "timeoutMs": null,
    "followRedirects": null,
    "maxRedirects": null,
    "verifyTls": null,
    "proxyId": null,
    "useCookieJar": true,
    "wsAutoReconnect": true,
    "wsHeartbeatMs": 30000
  },
  "grpc": {
    "protoPath": "",
    "service": "",
    "method": "",
    "message": "{}",
    "metadata": [],
    "streaming": false,
    "reflection": false
  },
  "preRequest": "",
  "tests": "",
  "examples": [],
  "mock": { "mode": "auto", "scenarios": [] },
  "fieldValidations": { "path": {}, "params": {}, "headers": {}, "body": {} },
  "responseValidations": { "body": {}, "headers": {} }
}
```

Field di dalam `settings` yang bernilai `null` berarti mewarisi network setting
aplikasi. Nilai di level request selalu menang.

### 3.2 Collection dan folder

Collection dan folder memiliki `description`, `auth`, `preRequest`, `tests`,
`fieldValidations`, dan `responseValidations`. Collection juga memiliki
`variables`, `mcpAccess`, metadata Confluence, dan daftar `items`.

Folder tidak memiliki variables; variable tetap di collection atau environment.

### 3.3 Environment dan globals

```json
{ "id": "env_...", "name": "Production", "variables": [
  { "key": "BASE_URL", "value": "https://api.example.com", "enabled": true, "type": "default" },
  { "key": "API_KEY", "value": "", "enabled": true, "type": "secret", "secretEnc": "..." }
]}
```

`type: "secret"` selalu disimpan dengan `value: ""` + `secretEnc` di disk.
Plaintext hanya ada di state renderer selama aplikasi berjalan.

## 4. Workspace dan collection

### 4.1 Workspace

- Beberapa workspace lokal; satu workspace aktif.
- Dashboard menampilkan recent request, pinned request, dan quick action.
- Workspace bisa diexport/import sebagai backup JSON atau folder Git-friendly.
- Relay Cloud bisa attach workspace untuk sync, member, komentar, dan monitor.
- Kebijakan MCP sensitif dapat diatur per workspace.

### 4.2 Collection tree

- Collection berisi folder dan request secara rekursif.
- Drag/drop untuk memindahkan node; move up/down; duplicate; rename; delete.
- Folder bisa punya auth, script, dan validation yang diwarisi request.
- Contoh respons tersimpan sebagai child request di tree.
- Collection bisa dijalankan sebagai runner atau folder saja.
- Collection bisa diimpor, diexport, didokumentasikan, di-mock, dan disinkronkan
  ke Confluence.

### 4.3 Collection editor

Tab: **Overview**, **Authorization**, **Variables**, **Validation**, **Scripts**.

- Overview: description, trust script, MCP sensitive-data policy.
- Authorization: default auth collection; request `inherit` memakai ini.
- Variables: collection-scoped variables, termasuk secret.
- Validation: request/response rules yang diwarisi semua request di bawahnya.
- Scripts: pre-request dan tests collection.

### 4.4 Folder editor

Folder mendukung:

- nama, deskripsi, auth, pre-request, tests;
- validasi request/response untuk semua request di subtree;
- run folder;
- add request/folder, duplicate, move, delete;
- edit validation dari context menu.

### 4.5 Inheritance

| Aspek | Urutan |
|---|---|
| Auth | collection -> folder -> ... -> request; request `inherit` mengambil ancestor terdekat yang bukan `inherit` |
| Pre-request | collection -> folder -> request, dijalankan berurutan |
| Tests | collection -> folder -> request, dijalankan berurutan |
| Field validation | collection -> folder -> request; field yang sama di child menimpa properti yang diisi |
| Response validation | collection -> folder -> request; aturan yang sama |

Aturan validasi child yang hanya mengisi `description` tetap mewarisi `rules`
dan constraint dari parent. Request-level clear hanya menghapus override
request; aturan parent muncul kembali.

## 5. Request

### 5.1 URL, params, path variables

- Query parameter bisa dari URL mentah dan tabel params; duplikasi di-dedupe.
- Path variable memakai `:name` atau `{name}` saat impor.
- Variabel `{{name}}` dan dynamic variable diresolusi sebelum send.
- URL yang tidak valid atau token yang tidak dikenal ditampilkan di UI; token
  tidak dikenal dibiarkan + warning.

### 5.2 Header

- Header tabel dengan enable/disable.
- **Bulk Edit** untuk menempel/mengganti banyak header sekaligus; format
  `Key: Value` dan awalan `# ` untuk baris disabled.
- **Header presets** lokal: simpan header aktif sebagai preset, apply dengan
  merge case-insensitive, dan hapus preset. Preset disimpan di localStorage
  aplikasi, bukan di workspace/backup.
- Auto-header `Content-Type`, `Accept`, auth, dan cookie dapat dihitung engine.
- Header sensitif diredaksi di export dan MCP.
- Header response ditampilkan terpisah.

### 5.3 Body

| Mode | Perilaku |
|---|---|
| `none` | Tanpa body |
| `raw` | Teks bebas + format Text/JSON/JavaScript/HTML/XML; content type otomatis untuk JSON/JS/HTML/XML |
| `json` | Editor JSON; pretty/error feedback; schema panel |
| `form-urlencoded` | Key/value form + Bulk Edit (`key=value`) |
| `form-data` | Key/value + file field (`type: "file"`) + Bulk Edit untuk field teks; file dipertahankan |
| `graphql` | Query + variables JSON; dikirim sebagai JSON GraphQL |

File form-data menyimpan path/nama file; export Postman memakai `type: "file"`
dan `src`, dan dokumentasi menampilkan nama file sebagai value.

Body `raw`/JSON punya tombol **Schema**:

- panel editor JSON Schema di samping body;
- **Generate from Body** menginfer `type`, `properties`, `required`, dan item
  array dari body JSON;
- jika schema sudah berisi, konfirmasi **Replace content?** muncul sebelum
  menimpa;
- schema ikut tersimpan di request dan round-trip Postman melalui extension
  `_relaySchema`.

### 5.4 Auth

Semua auth diselesaikan di main process, bukan renderer.

| Tipe | Mode / catatan |
|---|---|
| `inherit` | Memakai auth ancestor terdekat |
| `none` | Tanpa auth |
| `bearer` | Token / header prefix |
| `basic` | Username + password |
| `apikey` | Header atau query |
| `oauth1` | HMAC-SHA1, HMAC-SHA256, PLAINTEXT; header/query |
| `oauth2` | Authorization Code + PKCE, Client Credentials, Password, Refresh Token; scope, audience, extra params, client auth body/basic |
| `digest` | MD5/SHA-256, retry 401 dengan `www-authenticate` |
| `ntlm` | NTLMv2, MD4 internal |
| `awsv4` | Region/service, header/query, session token |
| `jwt` | HS256/384/512, RS256/384/512, payload, kid, header prefix |

OAuth2 Authorization Code memakai loopback `127.0.0.1` port acak, validasi
`state`, PKCE S256, dan single-use callback. Token tidak pernah dikirim balik
lewat IPC status.

### 5.5 Examples dan diff

- Response bisa disimpan sebagai example di request.
- Example menyimpan status, header, body, content type, dan snapshot request.
- Response aktif bisa dibandingkan dengan example atau response sebelumnya.
- Example ikut export/import Postman dan backup Relay.

### 5.6 Docs dan mock per request

Tab **Docs** mengelola dokumentasi request, validasi field, dan response.
Tab **Mock** mengelola scenario mock untuk request tersebut.

## 6. Variables dan secrets

### 6.1 Precedence

Dari prioritas tertinggi:

```text
local > iterationData > environment > collection > globals
```

- `local`: `pm.variables` selama satu eksekusi.
- `iterationData`: baris CSV runner.
- `environment`: environment aktif.
- `collection`: variable collection.
- `globals`: workspace globals.

Dynamic variable diresolusi sebelum lookup map, sehingga nama variabel `$guid`
tidak menimpa generator.

### 6.2 Dynamic variables

| Token | Hasil |
|---|---|
| `{{$guid}}` | UUID |
| `{{$timestamp}}` | Unix timestamp detik |
| `{{$isoTimestamp}}` | ISO-8601 |
| `{{$randomInt}}` | Integer 0–1000 |
| `{{$randomFirstName}}` | Nama depan dari pool kecil |
| `{{$randomEmail}}` | Email contoh |

Token dynamic yang tidak dikenal dibiarkan dan dilaporkan sebagai unresolved.

### 6.3 Secret variables

- Tipe `default` atau `secret`.
- Input secret memakai password field + Show/Hide.
- Secret dimask di console, tampilan request terkirim, export, dan MCP.
- Saat persist, plaintext dienkripsi dengan `safeStorage`; ciphertext disimpan
  di `secretEnc`, `value` dikosongkan.
- Bila enkripsi gagal, penyimpanan dilewati dan UI menampilkan banner
  `Changes not saved`; tidak ada fallback plaintext.
- Export Postman/environment/backup menulis nilai kosong + `type: "secret"`.
- Secret scan mencari nilai yang tampak token/API key tetapi masih default,
  lalu menawarkan **Mark as secret**.

## 7. Script runtime

### 7.1 Sandbox

- Dijalankan di main process dengan `vm.createContext`.
- `codeGeneration.strings = false`, `wasm = false`.
- Tanpa `process`, `require` bebas, `fs`, `child_process`, `Buffer`,
  `fetch`, `setImmediate`.
- Allow-list library: `crypto-js`, `moment`, `uuid`.
- Timeout 5 detik per script.
- Console dibatasi 1000 entri / 64 KB.
- `pm.sendRequest` adalah satu-satunya jalur network dari script.

### 7.2 `pm` API

Tersedia antara lain:

- `pm.response` (`code`, `status`, `responseTime`, `headers`, `json`, `text`,
  `to.have.*`).
- `pm.request` (URL, query, header, body, path variable).
- `pm.variables`, `pm.environment`, `pm.collectionVariables`, `pm.globals`.
- `pm.iterationData`.
- `pm.cookies`.
- `pm.visualizer`.
- `pm.execution.setNextRequest()` / `skipRequest()`.
- `pm.sendRequest`.
- Chai-style `expect` lintas realm.
- Alias legacy `postman.*`.

### 7.3 Snippets dan packages

Dialog **Script tools** menyediakan snippet siap pakai dan paket allow-list.
Snippet disisipkan ke editor pre-request/tests; paket mengikuti runtime di atas.
Library di luar allow-list tidak tersedia.

### 7.4 Trust gate

- Collection hasil import diberi `scriptsTrusted: false`.
- Saat send/run, Relay meminta konfirmasi sebelum menjalankan script.
- Tolak = script dilewati dan dicatat; terima = collection ditandai trusted.
- Collection Runner memakai keputusan trust yang sama.

## 8. Network

### 8.1 Presedensi

```text
request.settings -> app network settings -> default
```

| Field | Default | Catatan |
|---|---|---|
| `timeoutMs` | 30000 | 1–3600000; lewat AbortSignal |
| `followRedirects` | true | 3xx dikembalikan bila false |
| `maxRedirects` | 5 | 0–50 |
| `verifyTls` | true | false = `rejectUnauthorized:false` + warning |
| `proxyId` | null | `'none'` = direct |
| `useCookieJar` | true | false = tidak baca/tulis jar |

### 8.2 Proxy dan TLS

- Proxy profile HTTP/HTTPS/SOCKS.
- Mode manual atau environment (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`).
- Bypass `*`, `.suffix`, `*.suffix`.
- Custom CA, client certificate, private key, passphrase, servername.
- Kredensial proxy/client cert disimpan terenkripsi di main dan tidak pernah
  dikirim balik ke renderer.
- `verifyTls: false` menampilkan badge peringatan.

### 8.3 Abort, timeout, dan limit

- Setiap send punya `requestId`; Stop memanggil `http:abort`.
- Timeout memakai satu `AbortController` + timer.
- Response maksimum 50 MB; melebihi cap = error, bukan body terpotong.
- Response binary tidak didekode UTF-8; byte asli tersedia untuk preview/save.

### 8.4 Cookies

- Cookie jar global dikelola main.
- Cookie bisa dilihat, ditambah/diubah, dihapus, atau dibersihkan.
- Request bisa mematikan jar (`useCookieJar: false`).
- Cookie sensitif diredaksi dari export/MCP.

## 9. Response viewer

- Pretty (Monaco read-only), Raw, Preview.
- JSON tree dengan filter path.
- Pretty XML.
- HTML preview dalam iframe sandbox.
- Image dan PDF preview; Save/Download byte asli.
- Search dengan highlight.
- Redirect chain.
- Timing breakdown: start, socket, DNS, connect, TLS, TTFB, total.
- Response diff terhadap example atau response sebelumnya.
- Cookies dari response.
- Test results dan console script.
- Response history per request untuk diff.

## 10. Runner dan CLI

### 10.1 Collection Runner

Opsi:

- collection atau folder;
- iterasi dan delay;
- CSV data file;
- retry + delay;
- stop on error;
- save response snapshot;
- keep variable values;
- stop button yang menghentikan request aktif dan mencegah step berikutnya.

Conditional flow `setNextRequest`/`skipRequest` dihormati dengan loop guard.
Report: JSON, JUnit XML, HTML mandiri. Konfigurasi terakhir disimpan di
localStorage `relay-runner-config`.

### 10.2 CLI

```bash
node cli/relay.mjs run collection.json \
  --env production.json \
  --data data.csv \
  --iterations 1 \
  --delay 0 \
  --report html \
  --out relay-report.html \
  --bail \
  --verbose
```

Exit code:

| Code | Arti |
|---|---|
| 0 | Semua request/test lulus |
| 1 | Ada request/test gagal atau `--bail` |
| 2 | Input/flag/report error |

CLI memakai engine Node yang sama, script sandbox, variable scope, dan report
yang sama dengan UI.

## 11. Protokol dan GraphQL

| Protokol | Skema | Fitur |
|---|---|---|
| HTTP/HTTPS | `http://`, `https://` | Semua fitur request/response |
| WebSocket | `ws://`, `wss://` | Connect, header, protocol, frame teks/biner, close, history, auto-reconnect, heartbeat |
| MQTT | `mqtt://`, `mqtts://` | Connect, publish, subscribe, unsubscribe, QoS 0–2, retain |
| Socket.IO | `socketio://`, `socketios://` | Connect, emit, listen `onAny` |
| gRPC | `grpc://`, `grpcs://` | Proto file, unary, server streaming, cancel, metadata, TLS by scheme |

Batas sesi protokol: timeout koneksi 10 detik, history 500 entri/1 MB, sesi
dibersihkan saat shutdown. gRPC unary dipetakan ke response biasa agar `sent`
dan test tetap konsisten.

GraphQL memakai HTTP biasa:

- query dan variables;
- introspection schema;
- completion Monaco untuk bahasa GraphQL;
- schema scoped per request.

## 12. Import, export, dan backup

### 12.1 Format import

| Format | Dukungan |
|---|---|
| Postman v2.1 | Collection, folder, request, auth, script, examples, path vars, form-data file, variables |
| OpenAPI 3 | Tag -> folder, `$ref`, parameter, request body, response schema, security scheme |
| Swagger 2 | Sama seperti OpenAPI 3 untuk bentuk yang didukung |
| HAR | Entry -> request, header, body, response example |
| cURL | `-X`, `-H`, `-d`, `-F`, `-u`, `-b`, `-G`, `--json`, `--data-urlencode`, quote/line continuation |
| Insomnia v4 | Collection, environment, request, body, auth |

Deteksi format otomatis tersedia di tombol Import.

### 12.2 Postman export/import fidelity

- Event pre-request dan test di collection/folder/request.
- Examples ke `item.response[]` termasuk `originalRequest`.
- Path vars ke `url.variable[]`.
- Form-data file (`type: "file"`, `src`).
- Description.
- Auth lengkap.
- Globals dan workspace backup `_relayBackup` v1.
- Validasi Relay disimpan sebagai extension `_relayFieldValidations` /
  `_relayResponseValidations` di backup.

Field yang tidak punya slot Postman (mis. `oauth2.extraParams`, `clientAuth`,
`redirectUri`) hanya bertahan di backup Relay.

### 12.3 Workspace Git-friendly

Export workspace menjadi folder:

```text
relay-workspace.json
collections/<slug>-<id>.json
environments/<slug>-<id>.json
globals.json
```

Secret ditulis tanpa `value`/`secretEnc`; import mengembalikannya sebagai secret
kosong untuk diisi ulang. ID yang bertabrakan di-remap konsisten. Path traversal
ditolak; batas 200 file / 2 MB per file.

## 13. Dokumentasi dan validasi

### 13.1 Export dokumentasi

Collection bisa diexport menjadi:

- **HTML mandiri** — inline CSS, tanpa aset eksternal;
- **PDF** — melalui desktop app;
- **Confluence storage format** — documentation, OpenAPI, Swagger, atau both;
- **OpenAPI 3.0.3** — untuk integrasi tool lain.

Opsi HTML/PDF:

- template Classic, Professional, Minimal;
- tema system/light/dark + accent;
- bahasa English/Indonesia;
- include examples;
- resolve variables dari environment aktif;
- watermark dan metadata (author, prepared for, organization, version,
  classification, disclaimer);
- collection summary dan collection JSON opsional.

Secret tidak pernah diresolve atau diexport.

### 13.2 Validasi field

Dua kelompok:

```json
{
  "fieldValidations": { "path": {}, "params": {}, "headers": {}, "body": {} },
  "responseValidations": { "body": {}, "headers": {} }
}
```

Satu rule:

```json
{
  "rules": ["required", "integer"],
  "min": 0,
  "max": 0,
  "minLength": null,
  "maxLength": null,
  "minimum": 1,
  "maximum": 100,
  "minItems": null,
  "maxItems": null,
  "pattern": "^[0-9]+$",
  "format": "email",
  "enum": [],
  "example": "1",
  "default": "1",
  "description": "ID referensi"
}
```

Rule yang didukung: `required`, `nullable`, `string`, `integer`, `numeric`,
`boolean`, `email`, `url`, `array`, `object`, `unique`, ditambah custom token
`max:100` untuk kompatibilitas.

Constraint:

- `min`/`max` legacy: arti tergantung tipe (panjang string, nilai numerik,
  jumlah item);
- `minLength`/`maxLength`: string;
- `minimum`/`maximum`: numerik;
- `minItems`/`maxItems`: array;
- `pattern`: regex; UI menandai regex tidak valid dan export OpenAPI
  mengabaikannya;
- `enum`: nilai yang diizinkan;
- `example`/`default`: contoh dan fallback.

Validasi diwarisi collection -> folder -> request. Request-level override
menang. Field discovery berasal dari request dan saved example; key dari
validasi yang diimpor tetap ditampilkan walau belum ada di request.

OpenAPI import memetakan schema/parameter/header/response ke validasi. OpenAPI
export memetakan validasi kembali ke schema, required, constraint, pattern,
format, enum, dan response header.

## 14. Mock server

### 14.1 Mode lokal

- Satu mock server aktif.
- Route = `METHOD + pathname`; `:param` adalah wildcard segmen.
- Respons = scenario terpilih, fallback example terakhir.
- Tanpa example: `501`; route tidak dikenal: `404` + daftar route.
- CORS `*`, preflight `OPTIONS`, delay 0–10 detik.
- Log 200 entri: `{ at, method, path, status, ms }`.

### 14.2 Mode server

- Bind `0.0.0.0` atau IPv4 interface.
- Wajib token `relay_mock_...`.
- Token hanya ditampilkan sekali; disk menyimpan SHA-256 + prefix.
- Token lewat `Authorization: Bearer`, `x-relay-mock-token`, atau `?__token=`.
- `mock:status` mengembalikan URL dan mode.

### 14.3 Scenario

- `mode: auto | manual`.
- Kondisi per request.
- Override runtime dari modal.
- Override per panggilan `?__scenario=<id>`; hanya scenario enabled pada route
  itu, menang atas override runtime, dicatat `reason: "query"`.
- Relay Cloud juga menyediakan server mock dengan endpoint, scenario, log, dan
  role management.

## 15. Relay Cloud dan kolaborasi

Fitur cloud bersifat opsional; UI tetap lokal tanpa login.

| Fitur | Isi |
|---|---|
| Auth | Login/register, session perangkat, refresh single-flight |
| Sync | Attach/detach workspace, push/pull perubahan, resolusi konflik, retry |
| Team | Member, role, invite link, audit log, presence/SSE |
| Devices | Daftar perangkat aktif dan revoke |
| Comments | Komentar per request, mention, feed mention, edit/hapus |
| Monitors | Create/update/run/delete monitor, riwayat run, alert webhook |
| Mocks | Server mock cloud dengan endpoint/scenario/log |
| Secrets | Enkripsi per workspace/device; server hanya menyimpan ciphertext |

Saat backend tidak tersedia, workspace lokal tetap bisa dipakai dan status
cloud menunjukkan error tanpa memblokir request.

## 16. MCP server

MCP server adalah endpoint lokal opt-in untuk klien AI. Detail lengkap ada di
[docs/mcp-server.md](mcp-server.md) dan panduan pemakaian AI di
[docs/ai-guide.md](ai-guide.md).

Ringkasan:

- Endpoint `http://127.0.0.1:47821/mcp` (port dapat diubah).
- Token per klien, hanya ditampilkan sekali; disk menyimpan hash + prefix.
- Scope: `read`, `secrets`, `request`, `write`, `mock`, `confluence`, `cloud`,
  `settings`.
- Approval `always`, `session`, atau `never` untuk aksi non-read.
- Tool: app, workspaces, collections, requests, environments, execute, protocol,
  mock, confluence, cloud, settings, docs, backup.
- Semua hasil melewati redaksi secret/auth/cookie/proxy/ciphertext.
- Body maksimum 1 MiB; output tool maksimum 256 KiB; approval 60 detik; eksekusi
  5 menit; sesi idle 30 menit.

## 17. Keamanan

- Renderer tanpa Node; semua I/O dan jaringan lewat IPC main.
- `contextIsolation: true`, `nodeIntegration: false`.
- Script sandbox + trust gate.
- Secret `safeStorage`, tanpa fallback plaintext.
- Export dan MCP meredaksi nilai sensitif.
- Proxy/client certificate secret disimpan terenkripsi di main.
- MCP hanya loopback, token per klien, scope, approval, Host/Origin check,
  audit read sensitif.
- Jangan menulis token/secret ke repo, log, screenshot, atau dokumen.

## 18. Persistensi, session, dan tema

- Data: `<userData>/rest-tamer-data.json`, tulisan atomik + `.bak`.
- Migrasi menyimpan backup versi lama dan mempertahankan field yang tidak
  dikenal.
- Session tab di localStorage `relay-session`; respons/test result tidak
  dipersist.
- Split pane, theme, accent, history limit, runner config, docs export options
  memakai localStorage masing-masing.
- Quit handshake: tab dirty memunculkan Discard/Cancel; tab bersih langsung
  keluar.
- Tema: System/Light/Dark + 8 accent; Monaco mengikuti token CSS.
- History: filter, search, grouping tanggal, hapus per item, retensi 10–1000.

## 19. Codegen, update, dan UX tambahan

- **Generate code**: cURL, JavaScript `fetch`, Python `requests`, dan HTTPie dari
  request aktif. Secret/auth sensitif diredaksi dari output code.
- **Copy as cURL** tersedia dari command palette dan action menu.
- **Visualizer**: `pm.visualizer.set()` dirender di tab visualizer yang
  di-sandbox.
- **Update channel**: Stable/Beta, pengecekan update hanya pada build packaged,
  unduhan otomatis, dan konfirmasi sebelum restart. Build unsigned memakai
  installer macOS khusus.
- **Feature tour/guide** untuk onboarding; donation prompt bisa dimatikan lewat
  environment test.
- **Appearance**: mode System/Light/Dark, 8 accent, Monaco mengikuti tema.
- **Workspace dashboard**: recent request, pinned request, quick actions, dan
  shortcut hints.
- **Response history**: per request, untuk diff; tidak dipersist bersama body.

## 20. Batas dan troubleshooting

| Batas | Nilai |
|---|---|
| Response | 50 MB |
| Script | 5 detik |
| Console | 1000 entri / 64 KB |
| Mock log | 200 entri |
| Protokol history | 500 entri / 1 MB |
| MCP body | 1 MiB |
| MCP output | 256 KiB |
| MCP approval | 60 detik |
| MCP execution | 5 menit |
| MCP session idle | 30 menit |
| Git workspace | 200 file / 2 MB per file |

Masalah umum:

- **Request gagal TLS lokal** — cek `verifyTls`, custom CA, atau client cert.
- **Proxy tidak dipakai** — cek `proxyId`, mode manual/environment, dan bypass.
- **Variable tidak ter-resolve** — cek scope dan typo; lihat warning unresolved.
- **Script tidak jalan** — collection import belum trusted.
- **Secret hilang setelah restart** — `safeStorage` gagal atau secret belum
  diisi ulang setelah import.
- **MCP 401** — token revoked/rotated atau header salah.
- **MCP 403** — scope klien kurang.
- **MCP approval timeout** — jawab modal dalam 60 detik.
- **Mock 404** — route = method + path; cek base URL dan prefix.
- **OpenAPI pattern hilang** — regex tidak valid; perbaiki di Docs.
- **Confluence publish gagal** — cek config, page id/title, dan koneksi.

## 21. Peta file penting

| Path | Isi |
|---|---|
| `src/App.jsx` | State aplikasi, send/save, session, shortcuts, modal wiring |
| `src/components/` | UI request, response, sidebar, docs, runner, cloud, mock, MCP |
| `src/lib/collectionTree.js` | Tree, normalisasi, move/duplicate, path ancestor |
| `src/lib/factory.js` | Bentuk request/collection/environment |
| `src/lib/fieldValidations.js` | Rule, normalisasi, field discovery, inheritance |
| `src/lib/openapiDocs.js` | OpenAPI export |
| `src/lib/import/openapi.js` | OpenAPI/Swagger import |
| `src/lib/postmanFormat.js` | Postman import/export/backup |
| `src/lib/apiDocs.js` | HTML/PDF docs |
| `src/lib/confluenceDocs.js` | Confluence storage format |
| `src/lib/runner.js` | Collection runner |
| `src/lib/report.js` | JSON/JUnit/HTML report |
| `src/lib/mcpActions.js` | Implementasi aksi MCP |
| `src/lib/mcpRedact.js` | Redaksi hasil MCP |
| `shared/mcpTools.js` | Katalog tool/aksi/scope/approval |
| `electron/` | Main process, network, auth, sandbox, mock, MCP, cloud, Confluence |
| `packages/core/src/` | Engine/runner/variables yang bisa dipakai CLI/worker |
| `cli/relay.mjs` | CLI collection runner |
| `test/unit/` | Unit test Vitest |
| `e2e/` | Playwright Electron |

## 22. Testing, build, dan rilis

```bash
npm run lint
npm test
npm run test:e2e
npm run check
```

- Unit: Vitest, environment Node, termasuk server HTTP/HTTPS lokal, mock IdP,
  fixture TLS, dan escape suite sandbox.
- E2E: Playwright `_electron` terhadap build produksi dan user-data sementara.
- CI: `.github/workflows/ci.yml` (unit Ubuntu, E2E macOS) dan
  `.github/workflows/build.yml` (build/release multi-OS).
- Release: bump `package.json`, commit, tag `vX.Y.Z`, push tag. Detail:
  [RELEASING.md](../RELEASING.md).

## 23. Dokumen terkait

- [ARCHITECTURE.md](../ARCHITECTURE.md) — proses, IPC, persistensi, protokol.
- [docs/ai-guide.md](ai-guide.md) — panduan AI/MCP.
- [docs/mcp-server.md](mcp-server.md) — setup dan katalog MCP.
- [ROADMAP.md](../ROADMAP.md) — status parity dan rencana.
- [RELEASING.md](../RELEASING.md) — signing, notarization, auto-update.
- [docs/confluence-mock-scenarios-plan.md](confluence-mock-scenarios-plan.md) —
  detail Confluence dan mock scenario.
- [docs/backend-collaboration-plan.md](backend-collaboration-plan.md) — detail
  backend, sync, member, monitor, komentar.
