# Relay MCP server

Relay bisa menjadi **MCP server lokal**: klien AI (Claude Desktop, Cursor, VS Code,
atau klien MCP apa pun) memakai data dan service yang sama dengan UI — workspace,
collection, request, environment, runner, mock server, Confluence, Relay Cloud,
riwayat, cookie, dan docs.

Sifatnya **opt-in** dan default **mati**:

- listen hanya di `127.0.0.1` (loopback), tidak pernah di `0.0.0.0`;
- setiap klien punya **token sendiri** + **scope** + **kebijakan approval**;
- aksi non-read memunculkan modal persetujuan di aplikasi, kecuali klien
  dikonfigurasi `never`;
- token hanya ditampilkan **sekali**; yang disimpan di disk hanya SHA-256 + prefix;
- server hanya hidup selama jendela Relay terbuka.

Endpoint: `http://127.0.0.1:<port>/mcp` (default port **47821**).

---

## 1. Menyalakan server

1. Buka menu workspace (tombol nama workspace di header) → **MCP server…**.
2. Isi **Port** (1024–65535) bila perlu, klik **Save port**.
3. Centang **Enable MCP server**.
4. Status berubah menjadi `running` dan URL endpoint tampil sebagai teks
   monospace di bawah status (tombol **Copy** di sebelahnya).

Port yang dipakai harus bebas. Kalau gagal listen (mis. `EADDRINUSE`), pesan
errornya tampil di modal dan status tetap `stopped`.

Server dihentikan otomatis saat jendela ditutup, dan dinyalakan lagi saat
jendela baru selesai dimuat (macOS: klik Dock).

---

## 2. Membuat client dan token

Di modal yang sama, bagian **New client**:

| Isian | Arti |
|---|---|
| **Name** | Nama klien (1–60 karakter, unik tanpa beda huruf besar/kecil). Maksimal 20 klien. |
| **Scopes** | Izin yang diberikan. Default hanya `read`. |
| **Approval for non-read actions** | `always` (default), `session`, atau `never`. |

Klik **Create client**. Token `relay_mcp_…` dan dua blok konfigurasi (HTTP dan
stdio) muncul **sekali**; salin sekarang. Setelah ditutup, token tidak bisa
dilihat lagi — gunakan **Rotate** untuk menerbitkan token baru.

- **Rotate** menerbitkan token baru dan langsung mematikan token lama (grant
  `session` ikut dihapus).
- **Revoke** menghapus klien; tokennya langsung ditolak (`401`).
- Mengubah scope juga menghapus grant `session`.

### Scope

| Scope | Boleh melakukan |
|---|---|
| `read` | Membaca workspace, request, environment, riwayat, docs, dan status |
| `secrets` | Membaca plaintext secret **hanya jika** workspace/collection mengizinkan |
| `request` | Mengirim request, menjalankan collection, membuka sesi protokol (WS/MQTT/Socket.IO/gRPC) |
| `write` | Membuat/mengubah/menghapus/import workspace, collection, folder, request, environment |
| `mock` | Menyalakan/mematikan mock server dan memilih skenario |
| `confluence` | Mengatur Confluence dan publish halaman |
| `cloud` | Sync, member, device, monitor, komentar Relay Cloud |
| `settings` | Network settings, cookie, dan tampilan |

### Akses data sensitif

Secara default MCP **selalu meredaksi** data sensitif:

- nilai variabel bertipe `secret`;
- token/password di auth request dan collection;
- nilai cookie;
- password proxy dan passphrase client certificate;
- ciphertext (`secretEnc`, `tokenEnc`, dll.) tidak pernah dikirim.

Redaksi ini berlaku untuk hasil tool maupun detail di modal approval.

Untuk mengizinkan plaintext, buka menu workspace → centang **Allow MCP to
read secrets in this workspace**. Ini berlaku untuk environment, globals, dan
collection di workspace tersebut. Setiap collection bisa override lewat
**Collection → Overview → MCP sensitive data**:

| Nilai | Arti |
|---|---|
| Inherit workspace setting | Ikut checkbox workspace (default). |
| Allow MCP to read secrets | Collection ini tetap mengirim plaintext walau workspace memblokir. |
| Always redact for MCP | Collection ini selalu diredaksi walau workspace mengizinkan. |

Selain variabel `secret`, nama field/header yang lazim membawa kredensial
tetap diredaksi walaupun nilainya ditulis literal dan tidak terdaftar sebagai
secret variable:

- header/query/path: `Authorization`, `Proxy-Authorization`, `Cookie`,
  `X-API-Key`, `token`, `password`, `secret`, `session_id`, `csrf`, `jwt`, dll.;
- body JSON: key seperti `password`, `access_token`, `client_secret`,
  `private_key`;
- form field: key seperti `api_key`, `client_secret`, `password`.

Nilainya diganti `""` (atau `hasValue` untuk baris variabel), bukan di-hash.
Variabel dianggap aman bila **bukan** `type: "secret"` dan namanya tidak cocok
dengan pola sensitif di atas. Karena itu, token yang disimpan dengan nama
netral seperti `VALUE` tetap berisiko dan sebaiknya ditandai sebagai secret.

Menu workspace → **Scan for secrets…** memindai nilai yang tampak seperti
token/API key tetapi masih bertipe default, lalu menawarkan **Mark as secret**.
Audit read sensitif disimpan di store utama dan bertahan setelah restart.

Catatan keamanan:

- Client MCP juga harus diberi scope **`secrets`**; tanpa scope itu semua
  plaintext tetap diredaksi.
- Hanya lakukan ini untuk workspace/collection tepercaya dan matikan lagi
  setelah selesai.
- Scope `read` tetap diperlukan; pengaturan ini tidak memberi izin tulis.
- Pengaturan hanya bisa diubah dari UI Relay, bukan lewat tool MCP.
- Ciphertext dan field internal tetap dibuang meskipun akses sensitif aktif.

### Approval

| Policy | Perilaku |
|---|---|
| `always` | Modal persetujuan muncul di **setiap** aksi non-read. |
| `session` | Modal muncul sekali per kombinasi klien+tool+action, lalu diizinkan sampai aplikasi ditutup, token dirotasi, atau scope diubah. |
| `never` | Tidak pernah bertanya. Hanya berikan ke klien yang benar-benar dipercaya. |

Modal menampilkan nama klien, `tool.action`, scope, ringkasan (mis. `Send POST
https://…` atau `relay_collections.create: AI Review`), dan detail param yang
sudah diredaksi. Menutup modal = **menolak**. Tidak ada jawaban dalam 60 detik =
ditolak (`approval_timeout`).

---

## 3. Menghubungkan klien

Ada dua cara: **HTTP** (langsung ke endpoint, paling simpel) atau **stdio**
(lewat bridge `mcp-stdio.cjs` untuk klien yang hanya mendukung stdio).

Kedua blok konfigurasi di bawah dihasilkan otomatis oleh modal setelah token
dibuat — salin dari sana, jangan diketik ulang.

### 3a. HTTP (Streamable HTTP)

```json
{
  "mcpServers": {
    "relay": {
      "type": "http",
      "url": "http://127.0.0.1:47821/mcp",
      "headers": {
        "Authorization": "Bearer relay_mcp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

Catatan:

- Token dikirim sebagai header `Authorization: Bearer <token>` di **setiap**
  request. Klien MCP yang mendukung remote server biasanya mengurus header ini
  dari konfigurasi di atas.
- `Accept: application/json, text/event-stream` dan
  `Mcp-Session-Id` diurus oleh SDK klien; jangan di-hardcode.
- Nama kunci konfigurasi mengikuti klien: **`mcpServers`** untuk Claude Desktop
  dan Cursor, **`servers`** + `"type": "http"` untuk VS Code
  (`.vscode/mcp.json`). Format ini bisa berubah antar versi klien.

### 3b. stdio (bridge)

Untuk klien yang hanya bisa menjalankan proses lokal. Bridge mem-proxy JSON-RPC
stdin/stdout ke endpoint HTTP di atas.

```json
{
  "mcpServers": {
    "relay": {
      "type": "stdio",
      "command": "/Applications/Relay.app/Contents/MacOS/Relay",
      "args": ["/Applications/Relay.app/Contents/Resources/app.asar/dist-electron/mcp-stdio.cjs"],
      "env": {
        "ELECTRON_RUN_AS_NODE": "1",
        "RELAY_MCP_URL": "http://127.0.0.1:47821/mcp",
        "RELAY_MCP_TOKEN": "relay_mcp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

- `command` dan `args` **harus** disalin dari blok `mcp-config-stdio` di modal:
  path binary Electron dan path `mcp-stdio.cjs` bergantung pada cara Relay
  dipasang/di-build.
- `ELECTRON_RUN_AS_NODE=1` membuat binary Relay berjalan sebagai Node, jadi
  tidak perlu instalasi Node terpisah. Kalau platform tidak mendukungnya,
  ganti `command` menjadi `node` dan pertahankan `args` + env yang sama.
- Bridge **tidak** mencetak apa pun ke stdout selain JSON-RPC; diagnostik hanya
  ke stderr. Kalau `RELAY_MCP_URL`/`RELAY_MCP_TOKEN` kosong, bridge keluar
  dengan kode 1.

### 3c. Contoh per klien

**Claude Desktop** — `claude_desktop_config.json` (menu Settings → Developer →
Edit Config), memakai blok **stdio** di atas di dalam `mcpServers`, lalu
restart aplikasi.

**Cursor** — `.cursor/mcp.json` di root project (atau konfigurasi global),
memakai blok **HTTP** di dalam `mcpServers`.

**VS Code (agent mode)** — `.vscode/mcp.json` dengan kunci `servers`:

```json
{
  "servers": {
    "relay": {
      "type": "http",
      "url": "http://127.0.0.1:47821/mcp",
      "headers": { "Authorization": "Bearer relay_mcp_xxx" }
    }
  }
}
```

Setelah terhubung, minta klien memanggil **`relay_help`** lebih dulu — tool itu
mengembalikan daftar scope dan seluruh katalog `tool → action → params`, jadi
model tidak perlu menebak nama field.

---

## 4. Cara memanggil tool

Semua tool memakai bentuk argumen yang sama:

```json
{ "action": "<nama aksi>", "params": { ... } }
```

- `params` divalidasi terhadap katalog. Nama tool/aksi/field yang tidak dikenal,
  field wajib yang hilang, tipe yang salah, atau nilai enum yang salah ditolak
  dengan `invalid_params`.
- Scope yang tidak dimiliki klien → `forbidden_scope`.
- Hasil selalu berbentuk envelope:

```json
{ "ok": true, "data": { ... } }
{ "ok": false, "error": { "code": "not_found", "message": "…" } }
```

`isError: true` dikirim pada hasil MCP saat `ok: false`.

### Uji tanpa klien (curl)

Urutan lengkap: `initialize` → ambil `Mcp-Session-Id` → kirim
`notifications/initialized` → panggil tool.

```bash
URL=http://127.0.0.1:47821/mcp
TOKEN=relay_mcp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# 1) initialize — simpan header Mcp-Session-Id dari respons
curl -s -D /tmp/relay-mcp-headers -X POST "$URL" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'

SID=$(grep -i '^mcp-session-id:' /tmp/relay-mcp-headers | tr -d '\r' | awk '{print $2}')

# 2) initialized (server menjawab 202, tanpa body)
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$URL" \
  -H "Authorization: Bearer $TOKEN" -H "Mcp-Session-Id: $SID" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

# 3) panggil tool
curl -s -X POST "$URL" \
  -H "Authorization: Bearer $TOKEN" -H "Mcp-Session-Id: $SID" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"relay_workspaces","arguments":{"action":"list"}}}'
```

Respons `initialize` memuat `result.serverInfo.name = "relay"` dan
`result.serverInfo.version` = versi aplikasi. Hasil `tools/call` ada di
`result.content[0].text` sebagai string JSON envelope.

### Contoh aksi

Buat collection:

```json
{
  "name": "relay_collections",
  "arguments": { "action": "create", "params": { "name": "AI Review" } }
}
```

Jalankan collection (scope `request`):

```json
{
  "name": "relay_execute",
  "arguments": {
    "action": "run_collection",
    "params": { "collectionId": "col_orders", "iterations": 1, "persistVariables": false }
  }
}
```

Kirim satu request inline (tanpa menyimpan apa pun):

```json
{
  "name": "relay_execute",
  "arguments": {
    "action": "send",
    "params": { "request": { "method": "GET", "url": "https://httpbin.org/get" } }
  }
}
```

`send`/`run_collection` mengembalikan hasil runner (`status`, `tests`, dan
`response` berisi `status`, `contentType`, `headers`, `body` yang dipotong
128 KiB). `saveHistory` dan `persistVariables` default **false** — perubahan
variabel oleh script tidak ditulis kecuali diminta.

---

## 5. Daftar tool

| Tool | Scope aksi | Aksi |
|---|---|---|
| `relay_help` | — | `help` (tanpa scope/approval) |
| `relay_app` | read | `info` |
| `relay_workspaces` | read / write | `list`, `get` / `create`, `rename`, `switch`, `delete` |
| `relay_collections` | read / write | `list`, `get`, `export_postman` / `create`, `update`, `delete`, `add_folder`, `rename_node`, `delete_node`, `move_node`, `duplicate_node`, `import_postman` |
| `relay_requests` | read / write | `list`, `get` / `create`, `update`, `delete`, `duplicate` |
| `relay_environments` | read / write | `list` / `create`, `update`, `delete`, `activate`, `set_globals` |
| `relay_execute` | request | `send`, `run_collection` |
| `relay_protocol` | request | `open`, `send`, `close`, `events`, `grpc_services`, `grpc_invoke`, `grpc_stream_start`, `grpc_stream_cancel` |
| `relay_mock` | read / mock | `status` / `start`, `stop`, `reload`, `select_scenario` |
| `relay_confluence` | read / confluence | `get_config` / `set_config`, `test`, `publish` |
| `relay_cloud` | read / cloud | `status`, `list_workspaces`, `members`, `audit`, `devices`, `comments`, `mentions`, `monitors`, `get_monitor`, `monitor_runs` / `attach`, `detach`, `sync`, `invite`, `update_member`, `remove_member`, `revoke_device`, `create_comment`, `update_comment`, `delete_comment`, `create_monitor`, `update_monitor`, `delete_monitor`, `run_monitor` |
| `relay_settings` | read / settings | `get_network`, `get_cookies`, `get_history`, `get_appearance` / `set_network`, `set_cookie`, `delete_cookie`, `clear_cookies`, `clear_history`, `set_appearance` |
| `relay_docs` | read | `collection_html`, `collection_confluence` |
| `relay_backup` | read / write | `export_workspace` / `import_workspace` |

Login/sign-up Relay Cloud, file picker native, kontrol jendela, dan auto-update
sengaja **tidak** diekspos; datanya tetap bisa dibaca lewat tool di atas.

---

## 6. Batas dan perilaku

| Hal | Nilai |
|---|---|
| Bind | `127.0.0.1` saja |
| Path | hanya `POST/GET/DELETE /mcp` |
| Host diizinkan | `127.0.0.1:<port>`, `localhost:<port>`, `[::1]:<port>` |
| Header `Origin` | selalu ditolak (`403`) — tidak ada CORS |
| Body request | maks 1 MiB (`413` kalau lebih) |
| Output tool | maks 256 KiB; lebih dari itu diganti `{truncated:true,bytes,preview}` |
| Sesi MCP | idle 30 menit lalu ditutup |
| Timeout approval | 60 detik |
| Timeout eksekusi | 5 menit |
| Port default | 47821 |

Kode error yang mungkin muncul di `error.code`:

`invalid_params`, `forbidden_scope`, `denied`, `approval_timeout`,
`invoke_timeout`, `app_unavailable`, `not_found`, `conflict`,
`cloud_unavailable`, `protocol_error`, `renderer_error`.

---

## 7. Rahasia dan redaksi

Hasil tool tidak pernah memuat rahasia yang dideklarasikan:

- baris variabel `type: 'secret'` dikembalikan sebagai
  `{key,type:'secret',enabled,hasValue}` — nilai dan `secretEnc` dibuang;
- field auth (`bearer.token`, `basic.password`, `oauth2.clientSecret`, dst.),
  password proxy, passphrase sertifikat klien, dan nilai cookie dihapus/di-blank;
- teks yang mengandung nilai secret yang dikenal diganti `••••`;
- export Postman/backup memakai salinan yang sudah diredaksi.

Aksi yang **butuh** rahasia tetap bisa dijalankan karena resolusi nilai terjadi
di renderer, bukan di server MCP. Risiko yang tersisa: kalau sebuah request
mengembalikan secret di body respons, body itu ikut terkirim ke klien — scope
`request` + approval adalah gerbang terakhirnya.

---

## 8. Troubleshooting

| Gejala | Penyebab | Solusi |
|---|---|---|
| `401` + `WWW-Authenticate` | Token salah, sudah dirotasi, atau klien di-revoke | Buat/rotate token, perbarui konfigurasi klien |
| `403 host_not_allowed` | Klien memakai host lain (mis. IP LAN) | Pakai `127.0.0.1`/`localhost`; server memang loopback-only |
| `403 origin_not_allowed` | Request membawa header `Origin` (browser) | Panggil dari klien MCP, bukan dari halaman web |
| `403 session_client_mismatch` | `Mcp-Session-Id` dipakai dengan token klien lain | Mulai sesi baru dengan token yang sama |
| `404` | Path salah atau sesi tidak dikenal/kedaluwarsa | Pakai `/mcp`; kirim ulang `initialize` |
| `405` | `GET /mcp` tanpa sesi valid | Buka stream hanya setelah `initialize` |
| `413` | Body > 1 MiB | Kirim payload lebih kecil (mis. `import_postman` per collection) |
| `forbidden_scope` | Klien tidak punya scope aksi itu | Tambah scope lewat Edit client |
| `denied` | Modal ditolak/ditutup | Ulangi dan klik **Allow once** / **Allow for session** |
| `approval_timeout` | Tidak ada jawaban 60 detik | Ulangi; naikkan ke `never` hanya untuk klien tepercaya |
| `app_unavailable` | Jendela Relay tertutup/reload saat aksi berjalan | Buka aplikasi, pastikan status `running` |
| Status `stopped` + error port | Port dipakai proses lain | Ganti port, klik **Save port**, aktifkan lagi |
| Klien tidak menemukan tool | Belum `initialize`/`tools/list` atau token salah | Cek log klien; pastikan URL `/mcp` dan header `Authorization` |

---

## 9. File terkait

| File | Isi |
|---|---|
| `shared/mcpScopes.js`, `shared/mcpTools.js` | Katalog scope/tool/aksi/param + validasi + `summarizeAction` |
| `electron/mcp/config.js` | Normalisasi config, pembuatan token, verifikasi `timingSafeEqual` |
| `electron/mcp/server.js` | HTTP MCP, auth, Host/Origin, sesi, approval, batas ukuran |
| `electron/mcp/runtime.js` | Lifecycle listener, bridge ke renderer, `recentCalls` |
| `electron/mcp/ipc.js` | Channel `mcp:*` (config, status, client, hasil invoke/approval) |
| `electron/mcp-stdio.cjs` | Bridge stdio → HTTP |
| `src/lib/mcpActions.js` | Implementasi setiap aksi memakai helper yang sama dengan UI |
| `src/lib/mcpRedact.js` | Redaksi secret/auth/proxy/cookie |
| `src/lib/useMcpBridge.js` | Antrean invoke + antrean approval di renderer |
| `src/components/McpSettingsModal.jsx`, `McpApprovalModal.jsx` | UI server/client dan modal izin |
| `e2e/mcp.spec.js` | Uji end-to-end: scope, approval, revoke, stdio |
