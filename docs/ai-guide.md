# Relay untuk AI dan MCP

Panduan ini ditujukan untuk agen AI yang memakai Relay melalui MCP, atau
manusia yang menulis prompt/system instruction untuk agen tersebut. Tujuannya
agar agen memahami model data Relay, memilih tool yang tepat, tidak merusak
data, dan tidak membocorkan secret.

Dokumen pendamping:

- [features.md](features.md) — referensi semua fitur.
- [mcp-server.md](mcp-server.md) — setup server, token, scope, HTTP/stdio,
  troubleshooting.

## 1. Aturan dasar untuk agen

1. **Mulai dari `relay_help`.** Jangan menebak nama tool, action, atau parameter.
   Katalog adalah sumber kebenaran.
2. **Baca sebelum menulis.** Panggil `relay_app.info`, lalu `relay_workspaces`,
   `relay_collections.get`, dan `relay_requests.get` sebelum mengubah apa pun.
3. **Jangan pernah mengarang ID.** Gunakan ID yang dikembalikan tool.
4. **Anggap semua aksi non-read berisiko.** `write`, `request`, `mock`,
   `confluence`, `cloud`, dan `settings` membutuhkan scope + approval.
5. **Jangan meminta atau menulis secret.** Jangan meminta token, password,
   cookie, atau isi environment secret. Gunakan referensi variabel.
6. **Jangan mengubah data yang tidak diminta.** Jangan rename, delete, move,
   atau overwrite request/collection tanpa instruksi eksplisit.
7. **Verifikasi hasil.** Setelah write, baca ulang objeknya. Setelah send,
   periksa status/body/test. Setelah run, periksa summary.
8. **Hormati redaksi.** Jika field kembali kosong/`hasValue`, itu bisa berarti
   secret yang sengaja diredaksi, bukan data hilang.
9. **Jangan menulis ulang seluruh workspace.** Gunakan patch kecil dan target
   ID yang spesifik.
10. **Berhenti dan tanya** jika instruksi ambigu, destruktif, atau menyentuh
    secret/kredensial.

## 2. Koneksi MCP

Endpoint HTTP:

```text
http://127.0.0.1:47821/mcp
```

Server hanya hidup selama jendela Relay terbuka. Untuk klien yang hanya
mendukung stdio, gunakan bridge `electron/mcp-stdio.cjs` seperti dijelaskan di
[mcp-server.md](mcp-server.md).

Urutan HTTP:

1. `initialize`
2. simpan `Mcp-Session-Id`
3. `notifications/initialized`
4. `tools/call`

Token dibuat di **Workspace menu -> MCP server**. Token hanya tampil sekali.
Jangan meminta user menempelkan token ke chat; konfigurasikan di klien.

## 3. Istilah dan ID

| Objek | ID | Tool baca |
|---|---|---|
| Workspace | `ws_...` | `relay_workspaces.list/get` |
| Collection | `col_...` atau UUID | `relay_collections.list/get` |
| Folder | `fld_...` | `relay_collections.get` (tree) |
| Request | `req_...` | `relay_requests.list/get` |
| Environment | `env_...` | `relay_environments.list` |
| Client MCP | `mcp_...` | dikelola di UI, bukan tool |
| Mock scenario | `scn_...` | `relay_mock.status` |
| Protocol session | `mcp_...` | `relay_protocol.open` |

`collectionId` biasanya diperlukan untuk request baru dan untuk menghindari
ambiguitas. `workspaceId` opsional; default workspace aktif.

## 4. Alur discovery yang aman

```text
relay_help
  -> relay_app.info
  -> relay_workspaces.list
  -> relay_workspaces.get (jika perlu)
  -> relay_collections.list
  -> relay_collections.get (tree + field/response validation)
  -> relay_requests.get
  -> relay_environments.list
  -> relay_settings.get_network / get_cookies (jika relevan)
  -> aksi yang diminta
  -> baca ulang / verifikasi
```

Contoh panggilan:

```json
{"tool":"relay_help","action":"help","params":{}}
{"tool":"relay_app","action":"info","params":{}}
{"tool":"relay_collections","action":"get","params":{"collectionId":"col_123"}}
{"tool":"relay_requests","action":"get","params":{"requestId":"req_456","collectionId":"col_123"}}
```

Jangan memanggil `relay_help` berulang kali jika katalog sudah ada di konteks.

## 5. Katalog tool

| Tool | Action utama | Scope |
|---|---|---|
| `relay_app` | `info` | read |
| `relay_workspaces` | `list`, `get`, `create`, `rename`, `switch`, `delete` | read/write |
| `relay_collections` | `list`, `get`, `create`, `update`, `delete`, `add_folder`, `rename_node`, `delete_node`, `move_node`, `duplicate_node`, `set_validation`, `import_postman`, `export_postman` | read/write |
| `relay_requests` | `list`, `get`, `create`, `update`, `set_validation`, `delete`, `duplicate` | read/write |
| `relay_environments` | `list`, `create`, `update`, `delete`, `activate`, `set_globals` | read/write |
| `relay_execute` | `send`, `run_collection` | request |
| `relay_protocol` | `open`, `send`, `close`, `events`, `grpc_services`, `grpc_invoke`, `grpc_stream_start`, `grpc_stream_cancel` | request |
| `relay_mock` | `status`, `start`, `stop`, `reload`, `select_scenario` | read/mock |
| `relay_confluence` | `get_config`, `set_config`, `test`, `publish` | read/confluence |
| `relay_cloud` | status/sync/member/device/comment/monitor actions | read/cloud |
| `relay_settings` | network, cookies, history, appearance | read/settings |
| `relay_docs` | `collection_html`, `collection_confluence` | read |
| `relay_backup` | `export_workspace`, `import_workspace` | read/write |

Setiap action punya parameter persis di `relay_help`. Parameter yang tidak
dikenal, field wajib hilang, tipe salah, atau enum salah akan ditolak
`invalid_params`.

## 6. Bentuk request yang dipakai MCP

`relay_requests.create` menerima objek request dengan field yang sama seperti
UI:

```json
{
  "name": "Create merchant",
  "description": "Membuat merchant baru.",
  "method": "POST",
  "url": "{{BASE_URL}}/merchants",
  "params": [],
  "pathVars": [],
  "headers": [
    { "key": "Content-Type", "value": "application/json", "enabled": true }
  ],
  "body": {
    "mode": "json",
    "raw": "{\n  \"name\": \"Toko Contoh\"\n}"
  },
  "auth": { "type": "inherit" },
  "settings": {
    "timeoutMs": 30000,
    "followRedirects": true,
    "verifyTls": true,
    "useCookieJar": true
  },
  "preRequest": "",
  "tests": "",
  "fieldValidations": {
    "body": {
      "name": {
        "rules": ["required", "string"],
        "minLength": 1,
        "description": "Nama merchant"
      }
    }
  },
  "responseValidations": {
    "body": {
      "id": { "rules": ["required", "integer"], "minimum": 1 }
    }
  }
}
```

Gunakan `relay_requests.update` untuk patch kecil, bukan membuat ulang request.
Body/auth/settings/mock/grpc di-merge dalam; `fieldValidations` dan
`responseValidations` diganti wholesale.

## 7. Validasi dan warisan

### 7.1 Dua map

```json
{
  "fieldValidations": {
    "path": {},
    "params": {},
    "headers": {},
    "body": {}
  },
  "responseValidations": {
    "body": {},
    "headers": {}
  }
}
```

### 7.2 Rule

```json
{
  "rules": ["required", "integer"],
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

`min`/`max` adalah legacy yang artinya tergantung tipe. Untuk data baru,
gunakan `minLength`/`maxLength`, `minimum`/`maximum`, atau
`minItems`/`maxItems`.

### 7.3 Prioritas

```text
collection -> folder -> subfolder -> request
```

- Request menang untuk field yang sama.
- Child yang hanya mengisi `description` tetap mewarisi `rules` dan constraint
  parent.
- Aturan collection/folder berlaku ke semua request di bawahnya.
- Untuk menghapus override request, set ulang field ke parent/collection atau
  kosongkan; jangan menghapus aturan parent.

### 7.4 Menulis validasi

Request:

```json
{"tool":"relay_requests","action":"set_validation","params":{
  "requestId":"req_456",
  "fieldValidations":{"body":{"name":{"rules":["required","string"],"minLength":1}}},
  "responseValidations":{"body":{"id":{"rules":["integer"],"minimum":1}}}
}}
```

Collection/folder:

```json
{"tool":"relay_collections","action":"set_validation","params":{
  "collectionId":"col_123",
  "folderId":"fld_789",
  "fieldValidations":{"headers":{"X-Api-Key":{"rules":["required"]}}},
  "responseValidations":{"body":{"id":{"rules":["integer"],"minimum":1}}}
}}
```

Tanpa `folderId` = collection-level.

## 8. Menjalankan request dan collection

### 8.1 Send satu request tersimpan

```json
{"tool":"relay_execute","action":"send","params":{
  "requestId":"req_456",
  "collectionId":"col_123",
  "environmentId":"env_prod",
  "saveHistory":false,
  "persistVariables":false
}}
```

`requestId` diprioritaskan; `request` inline diabaikan jika `requestId` diisi.
`saveHistory` default false agar percobaan AI tidak mengotori history.
`persistVariables` default false agar mutasi script tidak mengubah workspace.

### 8.2 Inline request

```json
{"tool":"relay_execute","action":"send","params":{
  "request":{
    "method":"GET",
    "url":"https://api.example.com/health",
    "headers":[]
  }
}}
```

Inline request tidak disimpan. Gunakan hanya untuk eksplorasi.

### 8.3 Run collection

```json
{"tool":"relay_execute","action":"run_collection","params":{
  "collectionId":"col_123",
  "folderId":"fld_789",
  "iterations":1,
  "delayMs":0,
  "stopOnError":true,
  "retries":1,
  "retryDelayMs":500,
  "saveResponses":true,
  "persistVariables":false
}}
```

`saveResponses` default true untuk run_collection; response dipotong. Periksa
`summary`, `results`, `testsFailed`, dan error per step. Jangan menganggap
run sukses hanya karena HTTP 200; cek test.

## 9. Environment dan variable

```json
{"tool":"relay_environments","action":"list","params":{}}
{"tool":"relay_environments","action":"activate","params":{"environmentId":"env_prod"}}
{"tool":"relay_environments","action":"set_globals","params":{
  "variables":[{"key":"BASE_URL","value":"https://api.example.com","enabled":true,"type":"default"}]
}}
```

Aturan:

- Jangan menulis secret plaintext ke workspace/collection/environment lewat MCP
  jika tidak diminta eksplisit.
- Gunakan `type: "secret"`; nilai akan diredaksi pada hasil MCP.
- Precedence: `local > iterationData > environment > collection > globals`.
- Dynamic variable: `$guid`, `$timestamp`, `$isoTimestamp`, `$randomInt`,
  `$randomFirstName`, `$randomEmail`.

## 10. Mock server

```json
{"tool":"relay_mock","action":"status","params":{}}
{"tool":"relay_mock","action":"start","params":{"collectionId":"col_123","port":0,"delayMs":0}}
{"tool":"relay_mock","action":"select_scenario","params":{"requestId":"req_456","scenarioId":"scn_1"}}
{"tool":"relay_mock","action":"stop","params":{}}
```

`status` mengembalikan mode, URL, route, dan log. Jangan memakai `start` jika
server sudah berjalan tanpa alasan; `reload` untuk menerapkan perubahan scenario
tanpa memutus listener.

## 11. Dokumentasi

```json
{"tool":"relay_docs","action":"collection_html","params":{
  "collectionId":"col_123",
  "includeExamples":true
}}
```

`collection_html` mengembalikan HTML mandiri (secret diredaksi).
`collection_confluence` mengembalikan storage format. Untuk publish ke
Confluence, gunakan `relay_confluence.publish` dengan scope `confluence` dan
approval.

## 12. Protocol sessions

```json
{"tool":"relay_protocol","action":"open","params":{
  "protocol":"ws",
  "config":{"url":"wss://api.example.com/socket","headers":[]}
}}
```

Setelah `open`, simpan `sessionId`; gunakan `send`, `events`, lalu `close`.
Jangan biarkan sesi terbuka tanpa alasan. Untuk gRPC, mulai dengan
`grpc_services`, lalu `grpc_invoke`/`grpc_stream_start`; batalkan stream dengan
`grpc_stream_cancel`.

## 13. Relay Cloud

Cloud hanya tersedia jika user sudah sign in dan workspace di-attach.

- `relay_cloud.status` — status akun.
- `relay_cloud.list_workspaces` — workspace remote.
- `relay_cloud.attach` / `detach` / `sync`.
- `members`, `invite`, `update_member`, `remove_member`, `audit`.
- `devices`, `revoke_device`.
- `comments`, `create_comment`, `update_comment`, `delete_comment`, `mentions`.
- `monitors`, `create_monitor`, `run_monitor`, `monitor_runs`.

Jangan revoke device, remove member, atau delete comment tanpa instruksi
eksplisit. Untuk sync, baca status konflik terlebih dahulu.

## 14. Approval dan error

| Kode | Arti | Tindakan |
|---|---|---|
| `invalid_params` | Parameter salah/hilang | Baca `relay_help`, perbaiki |
| `not_found` | ID tidak ada | Refresh list/get |
| `forbidden_scope` | Scope klien kurang | Minta user menambah scope |
| `approval_timeout` | Modal tidak dijawab 60 detik | Ulangi setelah user siap |
| `denied` | User menolak | Jangan ulangi otomatis |
| `invoke_timeout` | UI tidak menyelesaikan aksi dalam 5 menit | Cek Relay, jangan retry agresif |
| `unauthorized` / 401 | Token salah/revoked | Minta token baru dari UI |
| `not_attached` | Workspace belum cloud-attached | Attach dulu |
| `cloud_unavailable` | Backend/network gagal | Laporkan, jangan retry agresif |

Envelope:

```json
{"ok":true,"data":{...}}
{"ok":false,"error":{"code":"not_found","message":"..."}}
```

Jangan menampilkan token/secret di pesan error atau ringkasan.

## 15. Redaksi dan data sensitif

Default MCP meredaksi:

- variabel `type: "secret"`;
- token/password auth request/collection;
- cookie;
- password proxy dan passphrase client certificate;
- ciphertext (`secretEnc`, `tokenEnc`, dll.);
- header/query/body dengan nama sensitif (`Authorization`, `Cookie`,
  `X-API-Key`, `token`, `password`, `secret`, `session_id`, `csrf`, `jwt`,
  `client_secret`, `private_key`, dll.).

Nilai diganti `""` atau `hasValue`. Jangan menyimpulkan "field kosong" sebagai
"field tidak ada" tanpa membaca tipe/konteks.

Membaca plaintext hanya jika:

1. klien punya scope `secrets`;
2. workspace mengizinkan; dan
3. collection tidak memaksa redaksi.

Jangan meminta user menonaktifkan redaksi untuk sekadar debugging.

## 16. System prompt yang disarankan

```text
You are an API engineering assistant operating Relay through MCP.

Always start by calling relay_help, then inspect the active workspace and the
target collection/request before writing. Use only IDs returned by tools. Prefer
small patches over full rewrites. Do not ask for or print secrets, tokens,
cookies, passwords, or ciphertext. Treat all non-read actions as approval-gated
and never retry a denied action. After every write, read the object back. After
every send/run, report status, test results, and the relevant response excerpt.
Do not delete, move, rename, revoke, or publish without explicit user consent.
If an instruction is ambiguous or destructive, stop and ask.
```

## 17. Checklist sebelum menjawab user

- [ ] Workspace dan collection yang benar sudah dikonfirmasi.
- [ ] Request/ID yang diubah memang yang diminta.
- [ ] Tidak ada secret/token yang tercetak.
- [ ] Write sudah diverifikasi dengan `get`.
- [ ] Send/run sudah dicek status + test, bukan hanya HTTP 200.
- [ ] Mock/protocol session sudah ditutup jika dibuka.
- [ ] Perubahan destruktif punya persetujuan eksplisit.
