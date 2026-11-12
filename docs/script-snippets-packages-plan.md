# Snippets & Packages untuk Pre-request / Tests — Rencana Implementasi

Status: **diimplementasikan (fase 1)**  
Tanggal: 2026-11-12  
Cakupan: tombol **Snippets** dan **Packages** di tab Pre-request dan Tests, mirip Postman.

---

## 1. Tujuan

- Mempercepat penulisan script dengan snippet siap pakai.
- Menyediakan paket JavaScript yang aman dan sudah dibundel untuk `require(...)`.
- Menjaga model keamanan script yang ada: eksekusi di main process, sandbox `vm`, hanya collection trusted.

## 2. Non-goals

- Install npm/JSR arbitrer saat runtime.
- Registry package publik, versi dinamis, atau dependency resolution.
- Menjalankan paket yang membutuhkan `fs`, `path`, `crypto`, `Buffer`, atau akses jaringan host.
- Menyamakan 100% katalog snippet Postman.

---

## 3. Temuan arsitektur

| Area | Lokasi | Catatan |
|---|---|---|
| UI script | `src/components/RequestPanel.jsx` (`PreRequestEditor`, `TestsEditor`) | Monaco lewat `CodeEditor`; belum ada toolbar snippet/package |
| Editor | `src/components/CodeEditor.jsx` | Belum mengekspos instance editor untuk insert text |
| Eksekusi | `packages/core/src/script-runner.js` | Script berjalan di main process, bukan renderer |
| Sandbox | `packages/core/src/sandbox/index.js` | `vm` realm, code generation dimatikan, tanpa host globals |
| `require()` | `createSandboxRequire({...})` | Saat ini hanya `crypto-js`, `moment`, `uuid` |
| API `pm` | `packages/core/src/pm/**` | Variables, request/response, cookies, tests, sendRequest, execution, visualizer |
| Trust | collection `scriptsTrusted` | Collection untrusted tidak menjalankan script |

Keterbatasan keamanan yang sudah diketahui: modul yang di-allowlist adalah host object; karena itu daftar paket harus curated.

---

## 4. Snippets

### 4.1 UI

- Tombol **Snippets** di bagian bawah editor Pre-request/Tests.
- Popover dengan:
  - input search,
  - daftar per kategori,
  - item aktif via keyboard,
  - klik/Enter menyisipkan kode di posisi kursor.
- Setelah insert: editor fokus kembali.
- Jika ada teks terpilih, snippet menggantikan selection.

### 4.2 Mekanisme insert

- `CodeEditor` menerima callback `onEditorReady(editor)` atau ref.
- Helper `insertSnippet(editor, text)` memakai `editor.executeEdits` + `editor.getSelection`.
- Tidak memakai `eval`; hanya manipulasi teks.

### 4.3 Katalog awal (±30)

**Workflows**

- Send an HTTP request
- Send an HTTP request with JSON body

**Variables**

- Get a global variable
- Get a collection variable
- Get an environment variable
- Get a variable
- Set a global variable
- Set a collection variable
- Set an environment variable
- Set a variable
- Clear a global variable
- Clear a collection variable
- Clear an environment variable
- Clear a local variable

**Assertions**

- Status code is 200
- Status code: successful POST request
- Status code name contains string
- Response time is below 200 ms
- Response header exists
- JSON body field equals value
- Response body contains string

**Response body**

- Parse JSON body
- Convert XML body to JSON object
- Validate JSON with Ajv

**Cookies**

- Get a cookie
- List cookies

`pm.cookies` saat ini read-only, jadi snippet “Set a cookie” ditunda sampai API cookie jar punya operasi tulis.

**Utilities**

- Base64 encode / decode
- Current timestamp
- `require` a package

### 4.4 Snippet yang ditunda

| Snippet | Alasan |
|---|---|
| Send an HTTP request from a Collection | `pm` belum punya lookup item collection |
| Tiny Validator (tv4) | Diganti Ajv agar tidak menambah paket lama |
| Snippet yang butuh `pm.visualizer` UI khusus | Perlu panel visualizer terpisah |

---

## 5. Packages (Opsi A — curated bundled)

### 5.1 Paket fase 1

| Package | Status | Kegunaan |
|---|---|---|
| `crypto-js` | sudah | hash/HMAC/AES |
| `moment` | sudah | tanggal/waktu |
| `uuid` | sudah | UUID |
| `lodash` | tambah direct dependency | utility object/array |
| `dayjs` | tambah | tanggal ringan |
| `ajv` | tambah direct dependency | validasi JSON Schema |
| `fast-xml-parser` | tambah | XML → JSON |
| `qs` | tambah | query string |

### 5.2 Paket fase 2

`zod`, `graphql`, `mustache`, `csv-parse`, `jmespath`, `jsonpath-plus`.

### 5.3 Dilarang

| Kategori | Contoh | Alasan |
|---|---|---|
| Node builtins | `fs`, `path`, `crypto`, `child_process` | akses host |
| Network client | `axios`, `node-fetch` | gunakan `pm.sendRequest` |
| Paket bergantung Buffer/crypto host | `jsonwebtoken` | bridge host |
| DOM/HTML berat | `cheerio` | ukuran dan permukaan besar |
| npm/JSR arbitrer | semua | butuh utility process + registry |

### 5.4 UI

- Tombol **Packages** di samping Snippets.
- Popover search + daftar paket.
- Klik paket menyisipkan contoh:
  ```js
  const _ = require('lodash');
  ```
- Menampilkan catatan bahwa hanya paket bundled yang tersedia.
- “Open package library” dapat berupa modal daftar lengkap (fase berikutnya).

### 5.5 Runtime

- `script-runner.js` mengimpor paket secara statis dan menambahkannya ke `createSandboxRequire`.
- Metadata UI disimpan di `src/lib/scriptPackages.js` (tanpa import runtime).
- Test unit memastikan setiap id di metadata punya entri runtime dan sebaliknya.

---

## 6. Perubahan file yang direncanakan

| File | Perubahan |
|---|---|
| `src/lib/scriptSnippets.js` | katalog snippet + kategori |
| `src/lib/scriptPackages.js` | metadata paket curated |
| `src/components/ScriptToolsPopover.jsx` | popover Snippets/Packages |
| `src/components/RequestPanel.jsx` | tombol + wiring insert |
| `src/components/CodeEditor.jsx` | expose editor / insert helper |
| `packages/core/src/script-runner.js` | tambah paket ke allowlist |
| `package.json` / lockfile | dependency fase 1 |
| `test/unit/scriptSnippets.test.js` | validasi katalog |
| `test/unit/scriptPackages.test.js` | sinkron metadata ↔ runtime |
| `e2e/scriptTools.spec.js` | insert snippet/package + jalankan script |

---

## 7. Acceptance criteria

- Klik snippet menyisipkan kode di posisi kursor, bukan menimpa seluruh editor.
- Search snippet/package berfungsi dan case-insensitive.
- Semua snippet memakai API `pm` yang benar-benar ada.
- `require('lodash')`, `require('dayjs')`, `require('ajv')`, `require('fast-xml-parser')`, `require('qs')` berhasil di script.
- Paket di luar allowlist menghasilkan error yang jelas.
- Tidak ada akses `process`, `Buffer`, `fs`, atau `require` host.
- Collection untrusted tetap tidak menjalankan script.

---

## 8. Risiko

| Risiko | Mitigasi |
|---|---|
| Paket host-object memperbesar bridge sandbox | curated allowlist, hanya pure-JS |
| Bundle main membesar | mulai dari 5 paket, ukur sebelum menambah |
| Snippet memakai API yang tidak ada | unit test mengeksekusi snippet representatif |
| Duplikasi metadata UI vs runtime | test sinkronisasi daftar |
| `require` dinamis dari user | tidak didukung; error eksplisit |

---

## 9. Keputusan yang masih terbuka

1. Set paket fase 1 disetujui? (`lodash`, `dayjs`, `ajv`, `fast-xml-parser`, `qs`)
2. Apakah `zod` dan `graphql` langsung masuk fase 1 karena sudah dependency?
3. Perlu “package library” modal penuh, atau cukup popover search?
4. Perlu snippet “Send HTTP request from a Collection” dengan menambah API lookup collection?

---

## 10. Catatan implementasi

- Fase 1 memakai 8 paket: 3 existing + `lodash`, `dayjs`, `ajv`, `fast-xml-parser`, `qs`.
- `zod` dan `graphql` tetap fase 2.
- `pm.cookies` belum punya `set`, jadi snippet cookie hanya get/list.
- Sandbox sekarang membungkus body script dalam fungsi dalam, sehingga script boleh mendeklarasikan nama yang sama dengan global injeksi, misalnya `const CryptoJS = require('crypto-js')`.
- Snippet dan package picker memakai satu katalog bersama di `packages/core/src/script-packages.js`; test mengeksekusi setiap paket agar metadata dan runtime tidak drift.
- Toolbar Snippets/Packages ditempel di dalam editor (overlay kiri bawah), bukan di bawah editor, supaya tetap terlihat saat panel request hanya setengah tinggi. Popover dirender lewat portal dengan posisi fixed agar tidak terpotong split pane.
- Test e2e: `e2e/scriptTools.spec.js` juga memastikan toolbar berada di dalam pane tanpa scroll.
