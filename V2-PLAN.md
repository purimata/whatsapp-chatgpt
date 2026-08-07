# PURIMATA Bot V2

Versi baru WhatsApp AI Assistant PURIMATA.

## Target

- Percakapan customer natural, ramah, ringkas, dan relevan.
- Greeting dan percakapan umum tidak dipaksa masuk troubleshooting.
- Memahami intent customer sebelum menentukan alur.
- Mendukung konsultasi genset, panel ATS/AMF, produk, jasa, dan troubleshooting.
- Troubleshooting menggunakan diagnostic case yang sederhana.
- Menyimpan evidence yang sudah dikonfirmasi.
- Tidak mengulang pertanyaan yang sama atau hanya diparafrase.
- Satu pertanyaan diagnostik utama per langkah.
- Meminta foto, video, pembacaan controller, atau pengukuran bila diperlukan.
- Tidak membuat diagnosis prematur tanpa evidence yang cukup.
- Mengarahkan customer ke Admin/teknisi bila diagnosis jarak jauh tidak cukup.
- Satu inbound message menghasilkan maksimal satu outbound response.
- Setiap tahap pengembangan diuji dan di-commit sebelum tahap berikutnya.

## Architecture

Inbound WhatsApp
-> Message Validation
-> Intent Router
-> Conversation / Sales / Technical / Diagnostic / Handoff
-> State & Evidence
-> OpenAI
-> Response Validation
-> WhatsApp Reply

## Development Rule

EDIT -> REVIEW -> COMMIT -> TEST -> NEXT STEP
