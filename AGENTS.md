# Aturan kerja agen di repo ini

Berlaku untuk semua sesi agen (omp) di repo ini. Aturan ini hanya boleh diubah oleh pemilik repo.

## Hard gate — wajib persetujuan eksplisit

Agen **tidak boleh** menjalankan perintah berikut tanpa instruksi eksplisit dari user pada percakapan yang sedang berjalan:

| Perintah | Catatan |
|---|---|
| `git commit` | Termasuk commit lokal, sekecil apa pun |
| `git push`, `git push --force` | Selalu butuh persetujuan terpisah dari persetujuan commit |
| `git tag`, `gh release create/upload` | Termasuk tag yang memicu release CI |
| `git reset --hard`, `git rebase`, `git clean -fdx` | Menghilangkan pekerjaan |
| Menghapus/rename branch, menghapus file di luar perubahan yang diminta | — |
| Mengubah `.github/workflows/` yang memicu deploy/release | — |

Prosedur yang benar:

1. Selesaikan perubahan di working tree.
2. Jalankan verifikasi (test/lint/build yang relevan).
3. Tampilkan `git diff --stat` + ringkasan perubahan dan hasil verifikasi.
4. **Berhenti dan tunggu** persetujuan. Push hanya dilakukan jika user menyebut push/PR secara eksplisit.

Persetujuan sekali pakai: "commit" untuk perubahan itu tidak berarti izin push, dan tidak berlaku untuk perubahan berikutnya.

## Boleh tanpa persetujuan

- Membaca file, `git status/diff/log/show` (read-only).
- Mengedit/menambah file di working tree.
- Membuat branch baru dan berpindah ke branch baru tersebut.
- Menjalankan test, lint, build, dan server lokal.
- Menambah dependency (laporkan perubahan lockfile di ringkasan).
- Menjalankan migration pada database **lokal/dev** yang dibuat agen sendiri.

## Verifikasi

- Klaim "sudah dites" hanya jika perintahnya benar-benar dijalankan pada perubahan itu.
- Sertakan output ringkas (jumlah test lulus/gagal, error utama) di ringkasan.
- Jika test tidak bisa dijalankan (mis. butuh Postgres), katakan apa yang belum diverifikasi.

## Batasan lain

- Jangan pernah menulis secret/token ke repo atau ke log.
- Satu commit = satu perubahan logis.
- Jangan mengubah file milik user yang tidak terkait tugas (termasuk `.env`, data lokal, konfigurasi editor).
- Jika instruksi ambigu atau berisiko, berhenti dan tanya — jangan menebak.

## Fitur baru dan tooltip onboarding

Aturan ini berlaku untuk setiap fitur baru atau perubahan alur kerja yang terlihat oleh pengguna. Refactor internal, perbaikan bug tanpa kontrol baru, dan perubahan styling tidak wajib menambah tooltip.

Setiap fitur baru **wajib** memiliki entri di `src/lib/featureTours/catalog.js` dan anchor `data-tour` yang stabil pada kontrolnya.

Checklist wajib:

1. Tambahkan entri katalog dengan `id` unik berformat `area.feature`.
2. Tambahkan `data-tour="area.feature"` ke elemen target. Jangan memakai selector class CSS, posisi piksel, atau teks tombol sebagai anchor.
3. Isi `title`, `body`, `group`, `surface`, dan `anchor`. Copy singkat, bahasa Inggris mengikuti UI, dan tidak boleh memuat secret/nilai token.
4. Isi `introducedIn` dengan versi rilis fitur.
5. Jika fitur harus muncul sebagai pengumuman setelah update, set `announce: true`.
6. Jika fitur hanya bisa dibuka dari menu/modal, atau tidak boleh muncul otomatis, set `auto: false`; fitur tetap wajib muncul di Feature Guide.
7. Jangan menambahkan mekanisme penyimpanan seen/skipped sendiri. Gunakan `useFeatureTour` dan state `relay-feature-tours-v1` yang sudah ada.
8. Pastikan fitur yang sudah dibaca atau di-skip tidak muncul otomatis lagi, termasuk setelah restart.
9. Jika fitur dihapus atau di-rename, hapus/perbarui entri katalog dan anchor lamanya agar tidak menjadi anchor yatim.
10. Jalankan verifikasi yang relevan: unit test katalog/tour, build, dan E2E untuk fitur baru yang memakai tooltip otomatis.

Jika fitur baru sengaja tidak diberi tooltip, jelaskan alasannya di ringkasan perubahan.

## Riwayat

- 2026-10-29: dibuat atas permintaan pemilik repo; commit/push wajib persetujuan.
- 2026-11-13: ditambahkan aturan wajib tooltip/Feature Guide untuk setiap fitur baru.
