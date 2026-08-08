"use strict";

const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || "v26.0";
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// V2.1F.1 - Processed Message Registry
const processedMessageIds = new Map();

const MESSAGE_DEDUP_TTL_MS = 10 * 60 * 1000;

function rememberProcessedMessage(messageId) {
  processedMessageIds.set(messageId, Date.now());

  setTimeout(() => {
    processedMessageIds.delete(messageId);
  }, MESSAGE_DEDUP_TTL_MS);
}

function wasMessageProcessed(messageId) {
  return processedMessageIds.has(messageId);
}

// V2.2C.3D.1 - Conversation Route State Registry
const conversationRouteState = new Map();

const CONVERSATION_ROUTE_TTL_MS = 2 * 60 * 60 * 1000;

function rememberConversationRoute(from, route) {
  if (!from || !route) return;

  conversationRouteState.set(from, {
    route,
    updatedAt: Date.now()
  });
}

function getRememberedConversationRoute(from) {
  if (!from) return null;

  const state = conversationRouteState.get(from);
  if (!state) return null;

  if (Date.now() - state.updatedAt > CONVERSATION_ROUTE_TTL_MS) {
    conversationRouteState.delete(from);
    return null;
  }

  return state.route;
}

function clearRememberedConversationRoute(from) {
  if (!from) return;
  conversationRouteState.delete(from);
}

// V2.2C.3E.1 - Diagnostic Evidence State Registry
const diagnosticEvidenceState = new Map();

const DIAGNOSTIC_EVIDENCE_TTL_MS = 2 * 60 * 60 * 1000;

function rememberDiagnosticEvidence(from, key, value) {
  if (!from || !key) return;

  const existing = diagnosticEvidenceState.get(from) || {
    evidence: {},
    updatedAt: Date.now()
  };

  existing.evidence[key] = value;
  existing.updatedAt = Date.now();

  diagnosticEvidenceState.set(from, existing);
}

function getDiagnosticEvidence(from) {
  if (!from) return {};

  const state = diagnosticEvidenceState.get(from);

  if (!state) return {};

  if (Date.now() - state.updatedAt > DIAGNOSTIC_EVIDENCE_TTL_MS) {
    diagnosticEvidenceState.delete(from);
    return {};
  }

  return { ...state.evidence };
}

function clearDiagnosticEvidence(from) {
  if (!from) return;
  diagnosticEvidenceState.delete(from);
}

// V2.1G.2 - WhatsApp Text Sender
async function sendWhatsAppText(recipient, text) {
  if (!WHATSAPP_TOKEN) {
    throw new Error("WHATSAPP_TOKEN is not configured");
  }

  if (!PHONE_NUMBER_ID) {
    throw new Error("PHONE_NUMBER_ID is not configured");
  }

  if (!recipient) {
    throw new Error("WhatsApp recipient is required");
  }

  if (!text || !String(text).trim()) {
    throw new Error("WhatsApp text message is empty");
  }

  await axios.post(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: recipient,
      type: "text",
      text: {
        preview_url: false,
        body: String(text).trim()
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

// V2.1H.2 - OpenAI Text Request Foundation
async function askOpenAI(userText) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

  if (!userText || !String(userText).trim()) {
    throw new Error("OpenAI input text is empty");
  }

  const response = await axios.post(
    "https://api.openai.com/v1/responses",
    {
      model: "gpt-5.4-mini",
      input: String(userText).trim(),
      max_output_tokens: 500
    },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      timeout: 45000
    }
  );

  const outputText = response.data?.output
    ?.flatMap(item => item?.content || [])
    ?.filter(item => item?.type === "output_text")
    ?.map(item => item?.text || "")
    ?.join("")
    ?.trim();

  if (!outputText) {
    throw new Error("OpenAI returned no text output");
  }

  return outputText;
}

// V2.2A - Conversation Intent Router Foundation
function classifyConversationIntent(text) {
  const input = String(text || "").trim().toLowerCase();

  if (!input) {
    return "general";
  }

  const greetingPatterns = [
    "halo",
    "hai",
    "hi",
    "hello",
    "pagi",
    "siang",
    "sore",
    "malam",
    "assalamualaikum"
  ];

  const handoffPatterns = [
    "admin",
    "teknisi",
    "hubungi teknisi",
    "bicara dengan admin",
    "sambungkan ke admin",
    "minta teknisi"
  ];

  const salesPatterns = [
    "harga",
    "beli",
    "pesan",
    "order",
    "penawaran",
    "quotation",
    "genset berapa kva",
    "panel ats",
    "panel amf",
    "stok",
    "ready"
  ];

  const diagnosticPatterns = [
    "mati sendiri",
    "shutdown",
    "alarm",
    "fault",
    "error",
    "tidak bisa start",
    "gagal start",
    "tidak keluar tegangan",
    "overheat",
    "low oil pressure",
    "under voltage",
    "over voltage"
  ];

  const technicalPatterns = [
    "cara setting",
    "cara pasang",
    "wiring",
    "instalasi",
    "setting controller",
    "dse",
    "deep sea",
    "star delta",
    "ats",
    "amf",
    "panel listrik"
  ];

  if (handoffPatterns.some((pattern) => input.includes(pattern))) {
    return "handoff";
  }

  if (diagnosticPatterns.some((pattern) => input.includes(pattern))) {
    return "diagnostic";
  }

  if (salesPatterns.some((pattern) => input.includes(pattern))) {
    return "sales";
  }

  if (technicalPatterns.some((pattern) => input.includes(pattern))) {
    return "technical";
  }

  if (greetingPatterns.some((pattern) => input.includes(pattern))) {
    return "greeting";
  }

  return "general";
}

app.use(express.json());

// PURIMATA Bot V2 - Health Check
app.get("/", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "PURIMATA Bot V2",
    version: "2.1A"
  });
});

// WhatsApp Webhook Verification
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("WhatsApp webhook verified");
    return res.status(200).send(challenge);
  }

  console.warn("WhatsApp webhook verification failed");
  return res.sendStatus(403);
});

// WhatsApp Inbound Message Receiver
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    // Webhook WhatsApp juga mengirim event selain pesan customer.
    if (!message) {
      return res.sendStatus(200);
    }

    const messageId = message.id;
    const from = message.from;
    const type = message.type;
    
    // Normalisasi pesan WhatsApp ke format internal V2
const normalizedMessage = {
  messageId,
  from,
  type,
  text:
    type === "text"
      ? message.text?.body?.trim() || ""
      : type === "image"
        ? message.image?.caption?.trim() || ""
        : type === "document"
          ? message.document?.caption?.trim() || ""
          : type === "video"
            ? message.video?.caption?.trim() || ""
            : "",
  mediaId:
    type === "image"
      ? message.image?.id || null
      : type === "audio"
        ? message.audio?.id || null
        : type === "document"
          ? message.document?.id || null
          : type === "video"
            ? message.video?.id || null
            : null,
  timestamp: message.timestamp || null
};

    // V2.1E - Inbound Message Validation
const supportedTypes = new Set([
  "text",
  "image",
  "audio",
  "document",
  "video"
]);

if (!messageId || !from || !type) {
  console.warn("Invalid WhatsApp message: missing required fields");
  return res.sendStatus(200);
}

if (!supportedTypes.has(type)) {
  console.log(`Unsupported WhatsApp message type ignored: ${type}`);
  return res.sendStatus(200);
}

if (type === "text" && !normalizedMessage.text) {
  console.log("Empty WhatsApp text message ignored");
  return res.sendStatus(200);
}

if (type !== "text" && !normalizedMessage.mediaId) {
  console.log(`WhatsApp ${type} message without media ID ignored`);
  return res.sendStatus(200);
}

    // V2.1F.2 - Duplicate Message Guard
if (wasMessageProcessed(messageId)) {
  console.log(`Duplicate WhatsApp message ignored: ${messageId}`);
  return res.sendStatus(200);
}
   
console.log("WhatsApp inbound message:", normalizedMessage);

    // V2.2B - Attach Conversation Intent To Inbound Flow
let conversationIntent = "general";

if (
  normalizedMessage.type === "text" &&
  normalizedMessage.text
) {
  conversationIntent = classifyConversationIntent(
    normalizedMessage.text
  );
}

    // V2.2C.3D.2A - Diagnostic Continuity Intent Override
const rememberedConversationRoute =
  getRememberedConversationRoute(normalizedMessage.from);

if (
  rememberedConversationRoute === "diagnostic_flow" &&
  (conversationIntent === "general" || conversationIntent === "greeting")
) {
  conversationIntent = "diagnostic";
}
    
normalizedMessage.intent = conversationIntent;

console.log("Conversation intent:", {
  from: normalizedMessage.from,
  intent: conversationIntent
});

    // V2.2C.1 - Conversation Route Decision
const conversationRouteMap = {
  greeting: "general_ai",
  general: "general_ai",
  sales: "sales_flow",
  technical: "technical_flow",
  diagnostic: "diagnostic_flow",
  handoff: "human_handoff"
};

const conversationRoute =
  conversationRouteMap[conversationIntent] || "general_ai";

normalizedMessage.route = conversationRoute;

    // V2.2C.3D.2B - Route State Update
if (conversationRoute === "diagnostic_flow") {
  rememberConversationRoute(
    normalizedMessage.from,
    conversationRoute
  );
}

if (conversationRoute === "human_handoff") {
  clearRememberedConversationRoute(
    normalizedMessage.from
  );
}

        // V2.2C.3E.2 - Confirmed Diagnostic Evidence Ingestion
    if (
      conversationRoute === "diagnostic_flow" &&
      normalizedMessage.type === "text" &&
      normalizedMessage.text
    ) {
      const diagnosticText = normalizedMessage.text
        .trim()
        .toLowerCase();

      if (
        diagnosticText.includes("starter berputar") ||
        diagnosticText.includes("starter muter") ||
        diagnosticText.includes("cranking") ||
        diagnosticText.includes("mesin berputar")
      ) {
        rememberDiagnosticEvidence(
          normalizedMessage.from,
          "starterCranking",
          true
        );
      }

      if (
        diagnosticText.includes("tidak ada alarm") ||
        diagnosticText.includes("tidak ada kode fault") ||
        diagnosticText.includes("tidak ada fault") ||
        diagnosticText.includes("tanpa alarm")
      ) {
        rememberDiagnosticEvidence(
          normalizedMessage.from,
          "alarmOrFaultPresent",
          false
        );
      }

          // V2.2C.3E.5 - Exhaust Smoke Evidence
    if (
      diagnosticText.includes("tidak ada asap") ||
      diagnosticText.includes("tidak keluar asap") ||
      diagnosticText.includes("tidak terlihat asap") ||
      diagnosticText.includes("tanpa asap")
    ) {
      rememberDiagnosticEvidence(
        normalizedMessage.from,
        "exhaustSmokePresent",
        false
      );
    }

      // V2.2C.3E.6 - Oil Pressure During Cranking Evidence
if (
  (
    diagnosticText.includes("tekanan oli") ||
    diagnosticText.includes("oil pressure")
  ) &&
  diagnosticText.includes("cranking") &&
  (
    diagnosticText.includes("menunjukkan 0") ||
    diagnosticText.includes("nilai 0") ||
    diagnosticText.includes("tetap 0")
  )
) {
  rememberDiagnosticEvidence(
    normalizedMessage.from,
    "oilPressureDuringCranking",
    0
  );
}
      
    }
    
console.log("Conversation route:", {
  from: normalizedMessage.from,
  intent: conversationIntent,
  route: conversationRoute
});
    
   // V2.2C.2 - Route Execution Gate
if (normalizedMessage.type === "text") {
  let replyText = null;

  switch (conversationRoute) {
    case "sales_flow":
      replyText =
        "Untuk informasi harga panel, genset, atau pekerjaan custom, Admin Purimata tidak memberikan perkiraan harga otomatis. Saya akan arahkan kebutuhan Anda ke Admin/teknisi agar mendapat harga yang sesuai spesifikasi.";
      break;

    case "human_handoff":
      replyText =
        "Baik, saya akan arahkan percakapan ini ke Admin/teknisi Purimata.";
      break;

    // V2.2C.3A - Separate Route Execution Branches
    // V2.2C.3B - Technical Route Behavior Guard
case "technical_flow": {
  const technicalPrompt = `
Anda adalah Admin Purimata yang menangani pertanyaan teknis genset dan panel.

ATURAN WAJIB:
1. Pahami dulu topik teknis dari pesan customer saat ini.
2. Jawab hanya dengan SATU pertanyaan klarifikasi ATAU SATU langkah teknis berikutnya.
3. Jangan memberi checklist panjang.
4. Jangan memberi beberapa kemungkinan penyebab sekaligus.
5. Jangan meminta lebih dari SATU informasi dalam satu balasan.
6. Jangan melakukan diagnosis kerusakan prematur.
7. Pertanyaan harus relevan langsung dengan pesan customer saat ini.
8. Jika prosedur bergantung pada tipe/model perangkat, tanyakan tipe/model terlebih dahulu.
9. Jika informasi customer sudah cukup untuk satu langkah aman, berikan hanya SATU langkah tersebut.
10. Jawaban maksimal 2 kalimat pendek.
11. Jangan mengalihkan topik ke starter, alarm, bahan bakar, atau troubleshooting lain kecuali customer memang sedang membahas hal tersebut.

CONTOH PERILAKU:
- Customer: "Cara setting controller DSE?"
  Jawab: "Tipe controller DSE yang digunakan apa?"

- Customer: "Cara setting DSE3110?"
  Pilih SATU informasi berikutnya yang paling diperlukan sebelum memberi langkah setting.

- Customer: "Cara pasang controller genset?"
  Tanyakan SATU informasi paling menentukan, misalnya tipe controllernya.

Jangan menyalin contoh secara otomatis.
Gunakan isi pesan customer untuk menentukan respons.

Pesan customer:
${normalizedMessage.text}
`;

  replyText = await askOpenAI(technicalPrompt);
  break;
}

    case "diagnostic_flow": {

      // V2.2C.3E.3 - Diagnostic Evidence Context Injection
const diagnosticEvidence = getDiagnosticEvidence(
  normalizedMessage.from
);

const diagnosticEvidenceContext = `
BUKTI DIAGNOSTIK YANG SUDAH DIKONFIRMASI CUSTOMER:
- Starter/cranking sudah berputar: ${
  diagnosticEvidence.starterCranking === true ? "YA" :
  diagnosticEvidence.starterCranking === false ? "TIDAK" :
  "BELUM DIKETAHUI"
}
- Alarm/kode fault muncul: ${
  diagnosticEvidence.alarmOrFaultPresent === true ? "YA" :
  diagnosticEvidence.alarmOrFaultPresent === false ? "TIDAK" :
  "BELUM DIKETAHUI"
}

- Asap dari knalpot saat cranking: ${
  diagnosticEvidence.exhaustSmokePresent === true ? "YA" :
  diagnosticEvidence.exhaustSmokePresent === false ? "TIDAK" :
  "BELUM DIKETAHUI"
}

- Tekanan oli saat cranking: ${
  diagnosticEvidence.oilPressureDuringCranking ?? "BELUM DIKETAHUI"
}

ATURAN EVIDENCE:
1. Perlakukan bukti di atas sebagai fakta yang sudah dikonfirmasi.
2. JANGAN menanyakan kembali fakta yang sudah bernilai YA atau TIDAK.
3. JANGAN mengulang pertanyaan yang maknanya sama dengan fakta tersebut.
4. Pilih pertanyaan diagnostik berikutnya yang memberikan informasi BARU.
`;
      
  const diagnosticPrompt = `
Anda adalah Admin Purimata yang menangani troubleshooting genset dan panel secara bertahap.

${diagnosticEvidenceContext}

ATURAN WAJIB:
1. Jawab hanya dengan SATU pertanyaan diagnostik paling bernilai.
2. Jangan memberikan checklist panjang.
3. Jangan memberikan banyak kemungkinan penyebab sekaligus.
4. Jangan memberi diagnosis final sebelum ada bukti yang cukup.
5. Jangan meminta lebih dari SATU informasi dalam satu balasan.
6. Prioritaskan bukti objektif seperti alarm, kode fault, gejala saat start, tegangan, indikator controller, atau hasil pengukuran.
7. Pilih pertanyaan yang paling cepat mempersempit penyebab masalah.
8. Jangan mengulang pertanyaan yang sama dalam bentuk parafrase dalam balasan yang sama.
9. Jangan langsung memberi langkah perbaikan kecuali informasi customer sudah cukup untuk satu langkah aman.
10. Jawaban maksimal 2 kalimat pendek.

CONTOH PERILAKU:
- Customer: "Genset saya tidak bisa starter"
  Jawab dengan SATU pertanyaan untuk membedakan kondisi starter/cranking terlebih dahulu.

- Customer: "Genset shutdown sendiri"
  Tanyakan SATU bukti paling bernilai, misalnya alarm atau kode fault yang muncul saat shutdown.

- Customer: "Genset hidup tapi tidak keluar tegangan"
  Tanyakan SATU data objektif yang paling relevan sebelum menyimpulkan penyebab.

Jangan menyalin contoh secara otomatis.
Gunakan kondisi yang disampaikan customer untuk memilih SATU pertanyaan berikutnya.

Pesan customer:
${normalizedMessage.text}
`;

  replyText = await askOpenAI(diagnosticPrompt);
  break;
}

case "general_ai":
  replyText = await askOpenAI(normalizedMessage.text);
  break;

default:
  console.warn("Unknown conversation route:", conversationRoute);
  replyText = await askOpenAI(normalizedMessage.text);
  break;
  }
  
  if (replyText) {
    await sendWhatsAppText(
      normalizedMessage.from,
      replyText
    );
  }
}

rememberProcessedMessage(messageId);
    
    return res.sendStatus(200);
  } catch (error) {
  console.error("Inbound webhook error:", {
    message: error.message,
    status: error.response?.status || null,
    metaError: error.response?.data?.error || null
  });

  return res.sendStatus(200);
}
});

app.listen(PORT, () => {
  console.log(`PURIMATA Bot V2 running on port ${PORT}`);
});
