# Rencana: relay-api menjalankan mock (app hanya setup)

Status: **usulan yang disepakati arahnya**, belum diimplementasikan. App sisi
lokal/LAN sudah jalan; `relay-api` belum punya kode mock sama sekali.

## Keputusan

Mock **dijalankan `relay-api`**, bukan diteruskan ke app. Setup (route, scenario,
publish, rotate token) tetap di app Relay. Konsekuensinya: mock tetap hidup saat
app ditutup, dan pemanggil tidak pernah menyentuh mesin pengguna.

```
User ──setup/publish──▶ App ──PUT bundle──▶ relay-api (menyimpan + menjalankan)
                                              ▲
Client ──────────── HTTP (public URL + token)─┘
```

## Konsekuensi yang harus diterima

1. **Engine kedua.** Matching route + pemilihan scenario harus ada di Go.
   Mitigasi wajib: `version` pada bundle, dan **satu korpus fixture JSON** yang
   dijalankan oleh `vitest` (app) *dan* `go test` (relay-api). Fixture adalah
   kontrak; kalau keduanya lulus korpus yang sama, drift ketahuan lebih awal.
2. **State pindah ke server saat mode cloud.** Override scenario runtime dan log
   request hidup di relay-api; app menampilkannya lewat API. Mode local/LAN
   tetap seperti sekarang (state di app).
3. **Publish eksplisit** (disarankan), bukan auto-push tiap edit: tombol
   **Publish** + indikator `stale` (hash bundle lokal ≠ hash terpublish).
4. **Tidak ada secrets di bundle.** Engine mock tidak pernah me-resolve variabel
   atau secret (hanya `{{request.*}}`), jadi bundle aman dikirim apa adanya.

## Kontrak bundle (versi 1)

Bentuknya mengikuti `shared/mockScenarios.js` supaya tidak ada pemetaan baru:

```json
{
  "version": 1,
  "workspaceId": "ws_…",
  "generatedAt": "2026-11-03T00:00:00.000Z",
  "routes": [
    {
      "id": "req_…",
      "name": "Order",
      "method": "GET",
      "path": "/orders/:id",
      "order": 3,
      "mock": {
        "mode": "auto",
        "activeScenarioId": null,
        "scenarios": [
          {
            "id": "ok",
            "name": "OK",
            "enabled": true,
            "status": 200,
            "statusText": "OK",
            "headers": [{ "key": "X-Scenario", "value": "ok", "enabled": true }],
            "contentType": "application/json",
            "body": "{\"id\":\"{{request.path.id}}\"}",
            "delayMs": 0,
            "isDefault": false,
            "conditions": [
              { "source": "query", "key": "state", "operator": "equals", "value": "ok", "enabled": true }
            ]
          }
        ]
      },
      "fallback": {
        "status": 200,
        "contentType": "application/json",
        "headers": [],
        "body": "{}"
      }
    }
  ]
}
```

`fallback` = example terakhir (perilaku lama), atau `null` kalau tidak ada.

### Aturan yang wajib sama persis di Go

| Aturan | Detail |
|---|---|
| Path | `:id` dan `{id}` = satu segmen wildcard; trailing `/` opsional; query/fragment dibuang |
| Urutan route | path tanpa param menang; lalu literal segmen terbanyak; lalu path terdalam; lalu `order` asli |
| Tidak ada route | `404` `{error:"No mock route matched", method, path, routes:[{method,path}]}` |
| Route tanpa scenario & fallback | `501` `{error:"No saved example for this route", method, path}` |
| Pilih scenario | `manual` → id aktif bila valid, kalau tidak default; `auto` → scenario enabled pertama yang **semua** condition-nya cocok, kalau tidak default; scenario tanpa condition tidak pernah menang otomatis |
| Condition | source `query`/`header`/`body`/`path`; header case-insensitive; body mendukung key bertitik (`user.email`); operator `equals`, `not_equals`, `contains`, `not_contains`, `exists`, `not_exists`, `gt`, `lt`; `gt`/`lt` numerik bila kedua sisi angka, kalau tidak string |
| Template | `{{request.query.<k>}}`, `{{request.header.<k>}}`, `{{request.body.<k>}}`, `{{request.path.<k>}}`; object → JSON; kosong → `""` |
| Override | `?__scenario=<id>` hanya bila id itu `enabled` pada route tsb, menang atas state manual |
| Batas | body request 1 MiB, response 5 MiB, delay 0–10 s |
| CORS | `Access-Control-Allow-Origin: *`, preflight `OPTIONS` → `204`, tanpa token |
| Token | `Authorization: Bearer`, `x-relay-mock-token`, atau `?__token=`; selain preflight wajib valid |

## Endpoint di relay-api

Semua route produk memakai prefix `/api/v1` (sesuai `route.Setup`).

| Method | Path | Akses | Fungsi |
|---|---|---|---|
| `PUT` | `/api/v1/workspaces/:id/mock` | Bearer, editor+ | Simpan bundle + hash token; balas `{slug, url, bundleHash, publishedAt}` |
| `GET` | `/api/v1/workspaces/:id/mock` | Bearer, viewer+ | Status untuk UI app: slug, url, bundleHash, publishedAt, request count |
| `DELETE` | `/api/v1/workspaces/:id/mock` | Bearer, editor+ | Unpublish (URL langsung 404) |
| `ANY` | `/m/:slug/*` | publik + token mock | Ingress: validasi token, jalankan engine, kembalikan respons |

Catatan:

- `slug` acak (bukan id workspace) supaya tidak bisa dienumerasi.
- Token mock dibuat di app (`relay_mock_…`); app mengirim **hash SHA-256**-nya
  saat publish. relay-api menyimpan hash, membandingkan dengan `subtle`/
  `crypto/subtle.ConstantTimeCompare`, dan **tidak** meneruskan token ke mana pun.
- `?__scenario=` diteruskan ke engine (bukan diartikan di handler).
- Rate limit memakai middleware `limiter` yang sudah ada, dengan key `slug + IP`.
- Audit: publish/unpublish + jumlah request; jangan catat body/token.

## File yang perlu ditambah di relay-api

Mengikuti struktur repo (usecase → repository → handler → route):

| File | Isi |
|---|---|
| `internal/mock/engine.go` | Pure: compile path, urutkan route, pilih scenario, evaluasi condition, render template |
| `internal/mock/engine_test.go` | Tabel test dari korpus fixture bersama |
| `internal/domain/entity/mock_site.go` | GORM: `ID, WorkspaceID, Slug, TokenHash, Bundle (JSONB), BundleHash, Enabled, PublishedBy, CreatedAt, UpdatedAt` |
| `internal/domain/repository/mock_repository.go` | Interface `FindByWorkspace`, `FindBySlug`, `Upsert`, `Delete` |
| `internal/repository/db/mock_repository.go` | Implementasi GORM |
| `internal/usecase/mock_usecase.go` | Publish/unpublish/status + `Serve(slug, token, request)`; cek membership & role |
| `internal/delivery/http/handler/mock_handler.go` | Handler admin + handler publik |
| `internal/delivery/http/route/mock_route.go` | `RegisterMockRoutes(v1, h, authCfg)` + `RegisterMockPublicRoutes(app, h)` |
| `migrations/0000XX_mock_sites.up.sql` / `.down.sql` | Tabel `mock_sites` + unique index `slug` |
| `cmd/api/main.go`, `route.Setup` | Wiring repo → usecase → handler; tambah parameter |

## Perubahan di app (repo ini)

| File | Isi |
|---|---|
| `shared/mockBundle.js` | `MOCK_BUNDLE_VERSION`, `toMockBundle({workspaceId, collections})`, `bundleHash` |
| `shared/mockFixtures.json` | Korpus kasus (route, condition, template) dipakai `vitest` + `go test` |
| `electron/cloud/client.js` | `putMock`, `getMock`, `deleteMock` |
| `electron/mock-ipc.js` | `mock:cloud-publish`, `mock:cloud-status`, `mock:cloud-unpublish` |
| `src/components/MockServerModal.jsx` | Mode ketiga **Cloud**: Publish/Unpublish, URL + token (sekali), indikator stale, status request |
| `test/unit/mockBundle.test.js` | Bundle mencakup semua route/condition/fallback; tidak ada secret |

## Urutan kerja

1. **Kontrak + fixture** (bisa dikerjakan sekarang, tanpa backend): tulis
   `shared/mockBundle.js` + `shared/mockFixtures.json` + test app.
2. **relay-api**: engine + tabel + 3 endpoint admin + ingress publik, dengan
   test tabel dari fixture yang sama.
3. **App**: client cloud + IPC + mode Cloud di modal.
4. **E2E nyata**: publish dari app, panggil URL publik tanpa/dengan token,
   `?__scenario=`, unpublish → 404. Pola mengikuti `e2e/cloud.spec.js`.

## Pertanyaan yang perlu diputuskan

- Domain ingress: `api.relay.app/m/<slug>/…` atau subdomain per sesi?
- Siapa yang boleh publish: semua member atau `editor+` saja?
- Apakah publish menyertakan seluruh workspace atau per collection?
- Log request cloud disimpan berapa lama (dan apakah ditampilkan di app)?
