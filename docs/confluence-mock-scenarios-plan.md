# Rencana: Confluence export + mock server dengan skenario

Status: rencana, belum diimplementasikan. Dua fitur independen; bisa dikerjakan
sebagai dua PR terpisah. Baseline: Relay local-first (Electron main + React,
satu workspace JSON), sudah punya mock server berbasis saved example dan
export docs HTML statis.

## 1. Keputusan arsitektur

| Area | Keputusan | Alasan |
|---|---|---|
| Confluence | Renderer membuat **Confluence storage-format XHTML**; main process yang bicara ke REST Confluence | CSP renderer memblokir network eksternal; kredensial tidak boleh masuk renderer |
| Kredensial Confluence | Main-owned, per workspace, dienkripsi `safeStorage`; renderer hanya melihat `hasToken` | Workspace JSON ikut cloud/backup/Git; token tidak boleh ikut |
| Halaman | Update by `pageId`; **create** jika `pageId` kosong (butuh space key) | Wapify hanya update dan memaksa user mencari page ID manual |
| Konflik versi | GET versi → PUT `versi+1`; 409 dikembalikan ke UI, user memilih overwrite | Tidak menimpa edit orang lain secara diam-diam |
| Mock | Perluas mock server yang ada; skenario disimpan **per request** (`request.mock`) | Route sudah berasal dari request; tidak perlu entitas endpoint kedua |
| Evaluasi mock | Auto (kondisi) / manual (skenario terpilih); deterministic route precedence | Wapify punya urutan tidak deterministik dan bug manual lintas endpoint |
| Template mock | Hanya `{{request.query/header/body/path...}}`; **tidak** meresolve secret/workspace variable | Mock bisa diakses proses lain; jangan bocorkan secret |
| Transport mock | Tetap `127.0.0.1`, tanpa auth, CORS `*` | Sama seperti perilaku sekarang; aman untuk alat lokal |

Yang **tidak** diport dari Wapify:

- Mock server Go/Fiber, tabel `mock_endpoints/mock_scenarios`, auth JWT.
- Bug: delete standalone rusak, tanpa ownership check, skenario tanpa kondisi
  tidak pernah match di auto, precedence route tidak jelas, `active_scenario_id`
  bisa menunjuk skenario endpoint lain, 404 tidak tercatat.
- Attachment Confluence (tidak ada gambar di docs Relay) dan 4 mode
  OpenAPI/Swagger — di luar lingkup awal.
- Chaos mode/error injection, binary mock response, regex condition (ReDoS)
  untuk v1.

## 2. Alur target

```mermaid
flowchart LR
  subgraph Renderer
    A[Collection kebab: Sync to Confluence] --> B[ConfluenceSyncModal]
    B --> C[confluenceDocs.js<br/>storage XHTML]
    C --> D[window.api.confluencePublish]
    E[Request tab: Mock] --> F[request.mock scenarios]
    G[MockServerModal] --> H[window.api.mockReload/select]
  end
  subgraph Main
    D --> I[confluence-ipc.js]
    I --> J[confluence-client.js]
    J --> K[(Confluence REST)]
    L[(safeStorage<br/>token per workspace)] --> I
    H --> M[mock-ipc.js]
    F --> N[(workspace JSON)]
    M --> O[mock-server.js]
    O --> P[(log ring buffer)]
  end
```

## 3. Confluence

### 3.1 UX

1. **Workspace → Confluence settings** (dari `WorkspaceSwitcher`):
   base URL, auth method (`Cloud` = email + API token, `Data Center` = PAT),
   email, token (write-only), space key, parent page opsional, allow
   self-signed TLS (default off, warning), tombol **Test connection**.
2. **Collection kebab → Sync to Confluence**:
   - belum dikonfigurasi → arahkan ke settings;
   - sudah punya `confluencePageId` → tampilkan link dan status sync, opsi
     include examples, tombol **Update page**;
   - belum punya page ID → field space key + parent page (opsional), tombol
     **Create page**;
   - hasil sukses menulis `confluencePageId`, `confluencePageUrl`,
     `confluenceSyncedAt` ke collection (non-secret) dan menampilkan link.
3. **Conflict 409**: dialog “Page changed since last sync” dengan pilihan
   Cancel / Overwrite (retry dengan versi terbaru). Tidak retry otomatis.
4. Tidak ada sync otomatis/background di v1; hanya aksi eksplisit.

### 3.2 Data dan keamanan

Main-owned store (`electron/store.js`):

```js
confluenceByWorkspace: {
  [workspaceId]: {
    baseUrl: 'https://org.atlassian.net/wiki',
    authMethod: 'cloud',        // 'cloud' | 'pat'
    email: 'dev@org.com',
    spaceKey: 'DOCS',
    parentPageId: '',
    allowInsecureTls: false,
    tokenEnc: '<safeStorage base64>',
    updatedAt: '...'
  }
}
```

- `getAll()` tidak boleh mengembalikan `tokenEnc` ke renderer. Handler
  `confluence:get-config` mengembalikan `hasToken` saja.
- `setAll()` mempertahankan `confluenceByWorkspace` seperti `cookieJar`/`network`.
- `safeStorage` tidak tersedia → tolak simpan token, jangan plaintext.
- Collection (workspace JSON, boleh ikut cloud/Git):

```js
confluencePageId: '',
confluencePageUrl: '',
confluenceSyncedAt: null
```

Normalisasi yang **wajib** disentuh agar field tidak hilang:
`newCollection` (`src/lib/factory.js`), `normalizeCollection`
(`src/lib/collectionTree.js`), `collectionFile` (`src/lib/gitWorkspace.js`),
backup metadata (`src/lib/postmanFormat.js`), dan test cloud payload.
`SCHEMA_VERSION` naik ke 3 (main otomatis membuat backup sebelum migrasi).

### 3.3 Base URL, auth, transport

- Normalisasi: trim, buang trailing `/`, tolak scheme selain `http/https`.
- API root:
  - path sudah berakhir `/rest/api` → pakai;
  - berakhir `/wiki` → tambah `/rest/api`;
  - host `*.atlassian.net` tanpa `/wiki` → tambah `/wiki/rest/api`;
  - lainnya → tambah `/rest/api`.
- Auth:
  - `cloud`: `Basic base64(email + ':' + apiToken)`;
  - `pat`: `Bearer <pat>`;
  - token kosong → error sebelum request.
- Transport memakai `sendRequest` + `createSendContext`
  (`packages/core/src/network-runtime.js`) agar proxy/TLS settings app
  dihormati, dengan `useCookieJar: false`, `followRedirects: false`,
  timeout 15 dtk. **Redirect 3xx = error** (“SSO/URL salah”) supaya
  `Authorization` tidak ikut ke host lain.
- `allowInsecureTls` hanya mengubah `settings.verifyTls` untuk request
  Confluence, bukan global.
- Tidak ada log token/body halaman; error hanya status + pesan Confluence.

### 3.4 Storage-format generator

Modul baru `src/lib/confluenceDocs.js` (pure, unit-testable):

```js
collectionToConfluenceStorage(collection, {
  includeExamples = true,
  generatedAt = null,
}): string
```

- Escape XML untuk text/attribute: `& < > " '`; buang karakter kontrol XML.
- Code macro memakai CDATA; `]]>` dipecah menjadi `]]]]><![CDATA[>`.
- Struktur: `h1` + deskripsi; TOC macro (`maxLevel=3`); folder `h2`;
  request `h2` (method berwarna + nama); URL `code`; deskripsi; tabel
  params/headers; body (`code` macro, mode raw/json/form/graphql); tabel
  collection variables dengan `type:'secret'` → `(secret)`; examples
  (status + body code) bila `includeExamples`.
- Auth hanya scheme (`Auth: bearer`), tidak pernah nilai token.
- Tidak ada resolusi variable; placeholder `{{...}}` dibiarkan apa adanya.
- Tidak ada attachment/gambar; footer “Generated by Relay” opsional.

### 3.5 Publish: kontrak dan algoritma

IPC (payload tidak pernah berisi token):

```js
window.api.confluenceGetConfig(workspaceId)
window.api.confluenceSetConfig({ workspaceId, baseUrl, authMethod, email,
  spaceKey, parentPageId, allowInsecureTls, token?, clearToken? })
window.api.confluenceTest(workspaceId)
window.api.confluencePublish({
  workspaceId, pageId: string | '', title, content,
})
```

`confluencePublish` di main:

1. Baca config + decrypt token; validasi base URL/space key bila create.
2. `pageId` ada:
   - `GET /rest/api/content/{id}?expand=version,space`; 200 → versi `n`;
   - `PUT /rest/api/content/{id}` body
     `{id,type:'page',title,body:{storage:{value,representation:'storage'}},version:{number:n+1}}`;
   - 409 → `{ok:false, code:'conflict', currentVersion}` (UI tanya overwrite);
   - 404 → `{ok:false, code:'page_not_found'}`.
3. `pageId` kosong:
   - `POST /rest/api/content` body
     `{type:'page',title,space:{key:spaceKey},ancestors:[{id:parentPageId}]?,body:{storage:...}}`;
   - 400 duplicate title → `code:'title_exists'` + saran isi page ID.
4. Sukses → `{ok:true, pageId, version, url, created}`.
   URL dari `_links.base + _links.webui`; fallback
   `<base>/pages/viewpage.action?pageId=<id>`.
5. `confluenceTest` → `GET /rest/api/user/current`, kembalikan display name;
   HTML response (SSO) dideteksi dan dilaporkan sebagai error.

### 3.6 File yang disentuh

| File | Perubahan |
|---|---|
| `src/lib/confluenceDocs.js` (baru) | storage XHTML + escaping/CDATA |
| `electron/confluence-client.js` (baru) | API root, auth, GET/POST/PUT, test, error mapping |
| `electron/confluence-ipc.js` (baru) | config (encrypt/sanitize), test, publish + conflict |
| `electron/main.js` | daftarkan IPC, `shell.openExternal`, sanitasi `store:get` agar `confluenceByWorkspace.tokenEnc` tidak pernah ke renderer |
| `electron/preload.cjs` | 4 method bridge |
| `electron/store.js` | `confluenceByWorkspace` di EMPTY, getter/setter, preserve |
| `shared/schema.js` | `SCHEMA_VERSION = 3` |
| `src/lib/factory.js` | default field collection |
| `src/lib/collectionTree.js` | `normalizeCollection` mempertahankan page metadata |
| `src/lib/gitWorkspace.js` | `collectionFile` memuat metadata Confluence |
| `src/lib/postmanFormat.js` | backup menyimpan `_relayConfluence`; export biasa tidak |
| `src/components/ConfluenceSettingsModal.jsx` (baru) | config + test |
| `src/components/ConfluenceSyncModal.jsx` (baru) | create/update/conflict/link |
| `src/components/WorkspaceSwitcher.jsx` | menu settings |
| `src/components/Sidebar.jsx` | kebab “Sync to Confluence” |
| `src/components/App.jsx` | state modal + patch collection |
| `src/styles.css` | style modal/section (additive) |

### 3.7 Test dan acceptance

Unit:
- `confluenceDocs`: escaping `<>&"'`, CDATA `]]>`, nested folder, semua body
  mode, examples on/off, secret tidak pernah muncul, collection kosong.
- `confluenceClient`: API root derivation (Cloud/DC/`/wiki`), auth header,
  timeout, redirect ditolak, HTML SSO, 409/404/400 mapping, create body,
  update version+1, URL extraction.
- normalisasi: page metadata bertahan lewat
  `normalizeCollection` → Git export → backup round-trip; cloud payload
  memuatnya; token tidak ada di workspace JSON.

E2E opt-in `RELAY_CONFLUENCE_E2E=1` dengan fake Confluence HTTP server:
- isi settings via UI, test connection;
- sync pertama → POST create, page ID tersimpan, body storage benar;
- sync kedua → PUT versi 2;
- fake server balas 409 → dialog conflict muncul, overwrite mengirim versi
  terbaru;
- data file tidak memuat token plaintext.

Acceptance:
- user bisa create/update page dari collection tanpa membuka browser;
- konflik tidak pernah ditimpa diam-diam;
- token tidak pernah dikirim ke renderer atau tersimpan plaintext;
- `npm test`, lint, build, e2e Confluence hijau.

## 4. Mock server: skenario

### 4.1 Model data (per request)

`newRequest()` mendapat default:

```js
mock: {
  enabled: true,                 // ikut diekspos di mock server
  mode: 'auto',                  // 'auto' | 'manual'
  activeScenarioId: null,
  scenarios: [],                 // urutan array = prioritas
}
```

Skenario:

```js
{
  id: 'scn_...',
  name: 'Success',
  enabled: true,
  status: 200,
  statusText: 'OK',
  headers: [{ key, value, enabled }],
  contentType: 'application/json',
  body: '{"ok":true}',
  delayMs: 0,
  isDefault: false,
  conditions: [
    { source: 'query', key: 'state', operator: 'equals', value: 'ok' }
  ]
}
```

`normalizeRequest` memanggil `normalizeMockConfig` dari modul shared baru
`shared/mockScenarios.js`, sehingga data lama (tanpa `mock`) tetap berjalan
dan field baru selalu ada. Array scenarios dipertahankan urutannya; UI
menyediakan naik/turun (tanpa dependency dnd baru).

### 4.2 Semantik

| Aspek | Aturan |
|---|---|
| Route | method exact + path; `:param` dan `{param}` sama-sama didukung |
| Precedence | path tanpa param > literal lebih banyak > segmen lebih banyak > urutan request |
| Duplikat | method+path identik: route pertama menang; UI memberi warning |
| Auto | skenario enabled pertama yang **semua** kondisinya match |
| Kondisi kosong | tidak pernah match di auto; hanya bisa default/manual |
| Default | skenario enabled pertama `isDefault` |
| Manual | `activeScenarioId` harus milik route; jika tidak valid → default → example |
| Fallback | skenario terpilih → default → example terbaru → 501 |
| Conditions | AND; source `query/header/body/path`; key body = dot path |
| Operator v1 | `equals`, `not_equals`, `contains`, `not_contains`, `exists`, `not_exists`, `gt`, `lt` (numerik bila kedua sisi angka, selain itu string) |
| Regex | ditunda (risiko ReDoS); tidak diekspos di v1 |
| Template | `{{request.query.x}}`, `{{request.header.x}}`, `{{request.body.a.b}}`, `{{request.path.id}}`; missing → `''` |
| Delay | `scenario.delayMs` > 0 menggantikan delay server; clamp 0–10.000 ms |
| Headers | scenario headers, buang `content-length`, lalu CORS permissive |
| Status | clamp 100–599; body UTF-8; cap 5 MB |
| Log | semua respons (termasuk 404), ring 200, tambah `scenarioId`, `scenarioName`, `matched` |

Catatan keamanan:
- Body request dibaca maksimal 1 MB dan hanya jika ada kondisi body/template
  body; JSON parse dibungkus try/catch; body non-JSON tidak match.
- Tidak ada resolusi variable/secret workspace di body mock.
- Bind tetap `127.0.0.1`; tidak ada opsi LAN di v1.

### 4.3 Runtime dan IPC

`electron/mock-server.js`:

- `startMockServer({ collections, port, delayMs })` membangun state mutable:
  `{ routes, logs, setRoutes(collections), selectScenario(requestId, id), status() }`.
- Route menyimpan `{ requestId, method, path, paramNames, matcher, mock }`;
  evaluasi memakai fungsi murni dari `shared/mockScenarios.js`.
- `setRoutes` menukar konfigurasi tanpa menutup listener/port; log tetap.
- `selectScenario` hanya override runtime (untuk demo); konfigurasi manual
  yang persisten tetap di `request.mock`.

`electron/mock-ipc.js`:

- `mock:start` seperti sekarang, route metadata diperkaya.
- `mock:reload({ collections })` — renderer mengirim snapshot workspace aktif
  (menghindari race debounce save), server tetap hidup.
- `mock:select({ requestId, scenarioId | null })` — override runtime; request id
  menghindari ambiguitas route duplikat.
- `mock:status` mengembalikan route + scenario + log; `mock:stop` tetap.

UI memanggil `mock:reload` setelah tombol **Reload routes** di modal, bukan
setiap keystroke. Dropdown skenario memanggil `mock:select` untuk pergantian
instan; mengubah mode/active scenario yang persisten dilakukan di tab Mock
lalu Reload.

### 4.4 UI

- `RequestPanel` dapat tab baru **Mock** (`MockScenariosPanel.jsx`):
  toggle “Expose in mock server”, mode Auto/Manual, daftar skenario
  (tambah/hapus/naik/turun/default), editor respons (status, headers via
  `KeyValueEditor`, body `CodeEditor`, content type, delay), dan builder
  kondisi (source/operator/key/value). Validasi inline; tidak ada regex.
- `MockServerModal`:
  - route list menampilkan `METHOD path`, jumlah skenario, mode + skenario
    aktif;
  - tombol **Reload routes**;
  - log table menambah kolom Scenario dan menandai 404/unmatched;
  - tetap polling 1 dtk (pola sekarang).
- Tidak perlu modal editor terpisah; tab Mock adalah sumber kebenaran.

### 4.5 File yang disentuh

| File | Perubahan |
|---|---|
| `shared/mockScenarios.js` (baru) | normalisasi, compile/match route + param, conditions, selection, template |
| `src/lib/factory.js` | `newRequest().mock` default |
| `src/lib/factory.js` / `normalizeRequest` | panggil `normalizeMockConfig` |
| `electron/mock-server.js` | route precedence, param capture, body read, scenario selection, template, log metadata, mutable state |
| `electron/mock-ipc.js` | reload/select, status metadata |
| `electron/preload.cjs` | `mockReload`, `mockSelect` |
| `src/components/RequestPanel.jsx` | tab Mock + badge |
| `src/components/MockScenariosPanel.jsx` (baru) | editor skenario |
| `src/components/MockServerModal.jsx` | route/scenario/log/reload |
| `src/styles.css` | style skenario/kondisi (additive) |
| `src/lib/postmanFormat.js` | backup menyimpan `_relayMock`; export Postman biasa tidak |
| `src/lib/gitWorkspace.js` | request sudah diexport utuh; tambah test |
| `src/lib/cloudSync.js` | payload request sudah utuh; tambah test |

### 4.6 Test dan acceptance

Unit (`test/unit/mockScenarios.test.js`, extend `mockServer.test.js`):
- normalisasi data lama/baru; scenario id unik; urutan stabil.
- route precedence (`/users/me` vs `/users/:id`), param capture, trailing
  slash, `{param}` dan `:param`.
- kondisi: tiap operator, header case-insensitive, body dot path, query,
  path param, AND, invalid JSON, body > 1 MB.
- selection: auto match, kondisi kosong, default, manual valid/invalid,
  fallback example, route tanpa example → 501.
- template substitution dan missing values.
- runtime: reload tanpa ganti port, select scenario, log metadata, delay clamp.
- persistence: `mock` bertahan `normalizeCollection`/`normalizeRequest`, Git
  export/import, backup round-trip; cloud flatten payload.

E2E `e2e/mockScenarios.spec.js`:
- seed workspace dengan request `/orders/:id` dan 3 skenario
  (success query `state=ok`, 404 header `x-fail`, default);
- buka Mock modal, start; fetch dari test process:
  `GET /orders/42?state=ok` → success + template `42`;
  `GET /orders/42` tanpa kondisi → default;
  manual select 404 → status/body berubah;
  reload setelah edit default → respons baru;
- log memuat scenario name; stop menutup port.

Acceptance:
- perilaku lama (tanpa `mock.scenarios`) tetap persis: example terbaru;
- skenario auto/manual deterministik dan bisa diganti tanpa restart;
- tidak ada secret workspace di respons mock;
- data bertahan reload, Git, backup, cloud;
- test/lint/build/e2e hijau.

## 5. Tahapan

| Milestone | Isi | Estimasi |
|---|---|---|
| M1 | Shared schema + normalisasi (`SCHEMA_VERSION=3`), `confluenceDocs` + test | 1–2 hari |
| M2 | Confluence client/IPC/store + settings modal + test connection | 2 hari |
| M3 | Sync modal update + create + conflict + link + e2e fake server | 2–3 hari |
| M4 | `shared/mockScenarios` + engine + IPC + unit test | 3 hari |
| M5 | Tab Mock + MockServerModal + e2e + Git/backup/cloud round-trip | 3–4 hari |

Total ±11–14 hari kerja; M1–M3 dan M4–M5 tidak saling bergantung sehingga bisa
diparalelkan setelah kesepakatan model data.

## 6. Risiko

| Risiko | Mitigasi |
|---|---|
| Token Confluence bocor lewat renderer/redirect | token hanya di main; sanitized config; redirect 3xx ditolak |
| Cloud vs Data Center beda base URL | derivasi `/wiki` + test connection; fake server untuk kedua bentuk |
| Konflik halaman menimpa edit orang | 409 → dialog overwrite eksplisit; tidak auto-retry |
| Field baru hilang saat normalisasi/export | update factory + normalizer + Git/backup + test round-trip |
| Route mock bertabrakan | precedence tetap + warning duplikat di UI |
| Body mock besar/ReDoS | cap 1 MB; regex tidak ada di v1 |
| Mock membocorkan secret | template hanya request data; tidak resolve variable |
| Perubahan skema merusak data lama | default `enabled:true`, fallback example; backup otomatis |

## 7. Non-goals v1

- Confluence: attachment/gambar, OpenAPI/Swagger mode, sync otomatis,
  multi-page per folder.
- Mock: binary/file response, chaos/error-rate injection, regex condition,
  SSE/streaming/WebSocket, bind ke LAN, proxy upstream.
- Perubahan pada export docs HTML yang sudah ada (kecuali bug yang ditemukan).

## 8. Keputusan yang perlu dikonfirmasi

1. Confluence: create page otomatis (butuh space key) atau update-only seperti
   Wapify? Rekomendasi: create + update.
2. Kredensial Confluence per workspace atau satu koneksi global? Rekomendasi:
   per workspace (main-owned, encrypted).
3. Mock skenario: per request (rekomendasi) atau entitas endpoint terpisah?
4. Regex condition: tunda (rekomendasi) atau perlu di v1?
5. Mock response binary/file: tunda (rekomendasi) atau perlu?
