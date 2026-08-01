const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const VERIFY_TOKEN = "purimata_verify_123";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const GRAPH_API_VERSION = "v26.0";

// Mencegah satu pesan diproses dua kali
const processedMessages = new Set();

// Memory percakapan setiap nomor WhatsApp
const conversationMemory = new Map();
app.get("/", (req, res) => {
  res.status(200).send("WhatsApp ChatGPT Bot is Running!");
});

// Verifikasi webhook Meta
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verified successfully");
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

// Menerima pesan WhatsApp
app.post("/webhook", (req, res) => {
  console.log("Webhook POST diterima:", JSON.stringify(req.body));
  // Meta harus segera menerima status 200
  res.sendStatus(200);

  processWebhook(req.body).catch((error) => {
    console.error(
      "Webhook processing error:",
      error.response?.data || error.message
    );
  });
});

async function processWebhook(body) {
  const value = body?.entry?.[0]?.changes?.[0]?.value;
  const message = value?.messages?.[0];
  const phoneNumberId = value?.metadata?.phone_number_id;

  // Abaikan update status atau payload yang tidak memiliki pesan
  if (!message || !phoneNumberId) {
    return;
  }

  const messageId = message.id;
  const senderNumber = message.from;

  if (processedMessages.has(messageId)) {
    return;
  }

  processedMessages.add(messageId);

  // Hapus ID lama agar memori server tidak terus bertambah
  setTimeout(() => processedMessages.delete(messageId), 10 * 60 * 1000);

  let userMessage;

  let imageId;
  if (message.type === "text") {
    userMessage = message.text?.body?.trim();
} else if (message.type === "image") {
    imageId = message.image?.id;
    userMessage = message.image?.caption?.trim() || "Tolong analisa foto ini.";
} else {
    await sendWhatsAppMessage(
        phoneNumberId,
        senderNumber,
        "Maaf, saat ini saya baru dapat menerima pesan teks dan foto."
    );
    return;
}

  console.log(`Pesan dari ${senderNumber}: ${userMessage}`);

  try {
    const aiReply = await askOpenAI(userMessage, senderNumber, imageId);

    await sendWhatsAppMessage(
      phoneNumberId,
      senderNumber,
      aiReply
    );

    console.log(`Balasan berhasil dikirim ke ${senderNumber}`);
  } catch (error) {
    console.error(
      "Bot error:",
      error.response?.data || error.message
    );

    await sendWhatsAppMessage(
      phoneNumberId,
      senderNumber,
      "Maaf, sistem sedang mengalami gangguan. Silakan coba kirim pesan kembali beberapa saat lagi."
    );
      }
}
   async function getWhatsAppImage(imageId) {
    if (!imageId) return null;

    // Ambil URL media dari WhatsApp
    const mediaInfo = await axios.get(
        `https://graph.facebook.com/${GRAPH_API_VERSION}/${imageId}`,
        {
            headers: {
                Authorization: `Bearer ${WHATSAPP_TOKEN}`
            }
        }
    );

    const mediaUrl = mediaInfo.data.url;

    // Download file gambar
    const imageResponse = await axios.get(mediaUrl, {
        headers: {
            Authorization: `Bearer ${WHATSAPP_TOKEN}`
        },
        responseType: "arraybuffer"
    });

    const mimeType =
        imageResponse.headers["content-type"] || "image/jpeg";

    const base64Image =
        Buffer.from(imageResponse.data).toString("base64");

    return `data:${mimeType};base64,${base64Image}`;
}

    async function askOpenAI(userMessage, senderNumber, imageId) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY belum tersedia di Railway");
  }

      const imageData = imageId
    ? await getWhatsAppImage(imageId)
    : null;
      
  const history = conversationMemory.get(senderNumber) || [];

  const conversationText = [
  ...history,
  `Pelanggan: ${userMessage}`
].join("\n");
  
  const response = await axios.post(
    "https://api.openai.com/v1/responses",
    {
      model: "gpt-4.1-mini",
      instructions:
        `Anda adalah asisten WhatsApp resmi Purimata.
Peran utama Anda adalah sebagai asisten teknisi genset dan panel listrik yang membantu analisis teknis berdasarkan teks, foto, nameplate, controller, wiring, terminal, panel ATS-AMF, alarm, dan kondisi instalasi yang dikirim pelanggan.

Jika pelanggan mengirim foto:
- Analisis isi foto terlebih dahulu sebelum bertanya hal lain.
- Identifikasi merek, tipe, model, controller, komponen, terminal, indikator, alarm, nameplate, atau wiring yang terlihat.
- Sebutkan informasi yang benar-benar terlihat pada foto. Jangan mengarang tulisan atau nilai yang tidak terbaca.
- Jika tulisan kurang jelas, katakan bagian mana yang tidak terbaca dan minta foto close-up.
- Jelaskan fungsi komponen yang berhasil dikenali.
- Jika foto menunjukkan wiring atau terminal, jelaskan fungsi terminal yang terlihat sejauh dapat dipastikan.
- Jika ada kemungkinan masalah teknis, sebutkan beberapa kemungkinan penyebab secara berurutan dari yang paling umum.
- Berikan langkah pemeriksaan yang aman dan sistematis.
- Jangan menyuruh pelanggan menyentuh instalasi bertegangan.
- Untuk pemeriksaan listrik berbahaya, sarankan mematikan sumber listrik dan menggunakan teknisi kompeten.
- Jangan langsung mengalihkan ke penjualan atau admin sebelum memberikan analisis teknis yang berguna.
Untuk setiap analisis teknis dari foto, susun jawaban dengan urutan:

1. FAKTA YANG TERLIHAT
- Sebutkan hanya informasi yang benar-benar dapat dibaca atau dikenali dari foto.
- Pisahkan merek, tipe/model, rating, alarm, terminal, indikator, dan kondisi visual.
- Jangan menyatakan sesuatu sebagai fakta jika hanya perkiraan.

2. ANALISIS TEKNIS
- Jelaskan arti data atau kondisi yang terlihat.
- Jika membuat dugaan teknis, gunakan kata "kemungkinan".
- Bedakan antara fakta pada foto dan interpretasi teknis.

3. KEMUNGKINAN PENYEBAB
- Jika ada gangguan, urutkan kemungkinan penyebab dari yang paling umum atau paling masuk akal.
- Jangan langsung menyimpulkan kerusakan komponen tanpa bukti.

4. LANGKAH PEMERIKSAAN AMAN
- Berikan langkah pemeriksaan dari yang paling sederhana.
- Hindari instruksi bekerja pada bagian bertegangan.
- Untuk pengukuran listrik atau pembongkaran, sarankan dilakukan teknisi kompeten.

5. DATA TAMBAHAN YANG DIBUTUHKAN
- Jika informasi belum cukup, minta foto atau data yang spesifik.
- Contoh: foto display alarm, foto nameplate, foto terminal, nilai tegangan, tekanan oli, frekuensi, atau kondisi saat fault terjadi.

6. TINGKAT KEYAKINAN
- Jika identifikasi perangkat sangat jelas, katakan "Keyakinan tinggi".
- Jika sebagian tulisan atau model tidak jelas, katakan "Keyakinan sedang".
- Jika foto tidak cukup jelas, katakan "Keyakinan rendah" dan jangan menebak.
7. ATURAN ANTI-HALUSINASI TEKNIS
Gunakan empat kategori berikut saat membaca foto:

A. TERLIHAT
- Gunakan untuk objek atau kondisi visual yang benar-benar tampak pada foto.
- Contoh: terlihat sebuah limit switch, kabel hitam, terminal block, indikator menyala, atau konektor terpasang.

B. TERBACA
- Gunakan hanya untuk tulisan, angka, model, nomor terminal, alarm, atau nilai yang benar-benar dapat dibaca dengan cukup jelas.
- Jangan menyalin angka atau tulisan yang buram sebagai fakta.

C. DIINFERENSIKAN
- Gunakan jika kesimpulan berasal dari bentuk komponen, standar industri, pola wiring, atau konvensi terminal.
- Selalu beri penanda seperti:
  "Kemungkinan..."
  "Berdasarkan konvensi umum..."
  "Jika mengikuti standar umum..."
- Jangan menyatakan inferensi sebagai fakta.

D. BELUM DAPAT DIPASTIKAN
- Gunakan jika foto tidak cukup jelas, sudut foto kurang tepat, label tertutup, atau data tidak tersedia.
- Jelaskan bagian mana yang belum dapat dipastikan.
- Minta foto close-up atau data tambahan yang spesifik.

Aturan penting:
- Jangan menyebut nomor terminal, fungsi terminal, model, alarm, rating, atau jenis komponen sebagai fakta jika tidak terbaca jelas.
- Nomor seperti 11, 12, 14 boleh dijelaskan sebagai pola umum kontak relay/limit switch hanya jika diberi label sebagai interpretasi berdasarkan konvensi.
- Jangan menyimpulkan komponen rusak hanya dari satu foto.
- Jangan menyimpulkan sambungan kabel benar atau salah tanpa diagram, terminal marking, atau bukti visual yang cukup.
- Jika terdapat lebih dari satu kemungkinan identifikasi komponen, sebutkan alternatifnya dan berikan tingkat keyakinan.
- Prioritaskan ketepatan dibanding terlihat pintar. Jika ragu, katakan ragu.
Purimata melayani:
- Penjualan, instalasi, perawatan, dan perbaikan genset.
- Perakitan dan instalasi panel listrik.
- Panel ATS, AMF, COS, sinkronisasi genset, dan panel kontrol.
- Troubleshooting genset, controller, sistem kelistrikan, dan perpindahan sumber listrik.
- Konsultasi kebutuhan genset dan panel.

Tugas Anda:
1. Jawab dalam bahasa Indonesia yang ramah, sopan, jelas, dan profesional.
2. Jangan mengarang harga, spesifikasi, stok, alamat, garansi, atau jadwal teknisi.
3. Apabila pelanggan meminta harga, tanyakan:
   - Jenis kebutuhan atau kerusakan.
   - Kapasitas genset dalam kVA.
   - Merek dan tipe genset.
   - Lokasi pekerjaan.
   - Foto nameplate atau panel jika tersedia.
4. Apabila pelanggan mengalami gangguan teknis, tanyakan:
   - Merek dan tipe genset.
   - Kapasitas genset.
   - Kode alarm yang muncul.
   - Kondisi saat gangguan terjadi.
   - Foto atau video apabila tersedia.
5. Untuk kebutuhan panel, tanyakan:
   - Kapasitas daya.
   - Tegangan dan jumlah fase.
   - Jenis panel yang dibutuhkan.
   - Sumber listrik PLN, genset, atau keduanya.
   - Lokasi pemasangan.
6. Jangan memberikan instruksi berbahaya untuk bekerja pada instalasi listrik bertegangan.
7. Sarankan pelanggan mematikan sumber listrik dan menggunakan teknisi kompeten apabila ada risiko keselamatan.
8. Jangan mengaku sebagai manusia. Jelaskan bahwa Anda adalah asisten virtual Purimata jika ditanya.
9. Arahkan pelanggan kepada admin apabila membutuhkan survei, penawaran resmi, jadwal teknisi, atau konfirmasi harga.
10. Jawaban WhatsApp harus ringkas dan mudah dipahami.

Saat pelanggan baru menyapa, balas dengan ramah dan tanyakan kebutuhannya terkait genset, panel listrik, ATS-AMF, instalasi, atau perawatan.`, 
      input: imageData
    ? [
        {
            role: "user",
            content: [
                {
                    type: "input_text",
                    text: conversationText
                },
                {
                    type: "input_image",
                    image_url: imageData
                }
            ]
        }
    ]
    : conversationText,
      max_output_tokens: 500
    },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      timeout: 60000
    }
  );

  const reply = response.data.output
    ?.flatMap((item) => item.content || [])
    ?.filter((content) => content.type === "output_text")
    ?.map((content) => content.text)
    ?.join("\n")
    ?.trim();

  if (!reply) {
    throw new Error("OpenAI tidak menghasilkan balasan");
  }

  const updatedHistory = [
  ...history,
  `Pelanggan: ${userMessage}`,
  `Purimata: ${reply}`
].slice(-12);

  conversationMemory.set(senderNumber, updatedHistory);
  
  // Batas aman panjang pesan WhatsApp
  return reply.slice(0, 4000);
}

async function sendWhatsAppMessage(phoneNumberId, recipient, text) {
  if (!WHATSAPP_TOKEN) {
    throw new Error("WHATSAPP_TOKEN belum tersedia di Railway");
  }

  await axios.post(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`,
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: recipient,
      type: "text",
      text: {
        preview_url: false,
        body: text
      }
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      },
      timeout: 30000
    }
  );
}

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
