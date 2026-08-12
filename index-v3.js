"use strict";

const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = Number(process.env.PORT || 3000);
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || "v26.0";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5-mini";

function validateStartupConfig() {
  const required = {
    VERIFY_TOKEN,
    WHATSAPP_TOKEN,
    PHONE_NUMBER_ID,
    OPENAI_API_KEY,
  };

  const missing = Object.entries(required)
    .filter(([, value]) => !String(value || "").trim())
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(
      `[STARTUP_CONFIG_ERROR] Missing required environment variables: ${missing.join(", ")}`
    );
  }

  console.log(`[STARTUP_CONFIG_OK] OpenAI model: ${OPENAI_MODEL}`);
}

validateStartupConfig();

const MESSAGE_DEDUP_TTL_MS = 10 * 60 * 1000;
const CONVERSATION_TTL_MS = 2 * 60 * 60 * 1000;
const DIAGNOSTIC_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_DIAGNOSTIC_TURNS = 12;

// -----------------------------------------------------------------------------
// 1. Generic helpers
// -----------------------------------------------------------------------------

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function includesAny(text, patterns) {
  return patterns.some((pattern) => text.includes(pattern));
}

function isExplicitDiagnosticCorrection(text) {
  const t = normalizeText(text);

  return includesAny(t, [
    "tadi saya salah",
    "saya salah tadi",
    "maaf tadi salah",
    "koreksi:",
    "koreksi,",
    "ralat:",
    "ralat,",
    "maksud saya"
  ]);
}

function now() {
  return Date.now();
}

function safeJsonParse(text) {
  if (!text) return null;
  const raw = String(text).trim();
  try {
    return JSON.parse(raw);
  } catch (_) {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch (_) {
      return null;
    }
  }
}

// -----------------------------------------------------------------------------
// 2. Processed-message deduplication
// -----------------------------------------------------------------------------

const processedMessageIds = new Map();

function getMessageProcessingState(messageId) {
  if (!messageId) return null;

  const entry = processedMessageIds.get(messageId);
  if (!entry) return null;

  if (now() - entry.updatedAt > MESSAGE_DEDUP_TTL_MS) {
    processedMessageIds.delete(messageId);
    return null;
  }

  return entry.status;
}

function markMessageInFlight(messageId) {
  if (!messageId) return;
  processedMessageIds.set(messageId, {
    status: "in_flight",
    updatedAt: now(),
  });
}

function markMessageCompleted(messageId) {
  if (!messageId) return;
  processedMessageIds.set(messageId, {
    status: "completed",
    updatedAt: now(),
  });

  setTimeout(
    () => processedMessageIds.delete(messageId),
    MESSAGE_DEDUP_TTL_MS
  ).unref?.();
}

function releaseMessageInFlight(messageId) {
  if (!messageId) return;

  const entry = processedMessageIds.get(messageId);
  if (entry?.status === "in_flight") {
    processedMessageIds.delete(messageId);
  }
}

// -----------------------------------------------------------------------------
// 3. Conversation route memory
// -----------------------------------------------------------------------------

const conversationRouteState = new Map();

function rememberConversationRoute(from, route) {
  if (!from || !route) return;
  conversationRouteState.set(from, { route, updatedAt: now() });
}

function getRememberedConversationRoute(from) {
  const state = conversationRouteState.get(from);
  if (!state) return null;
  if (now() - state.updatedAt > CONVERSATION_TTL_MS) {
    conversationRouteState.delete(from);
    return null;
  }
  return state.route;
}

function clearRememberedConversationRoute(from) {
  if (from) conversationRouteState.delete(from);
}

// -----------------------------------------------------------------------------
// 4. Diagnostic session / evidence ledger
// -----------------------------------------------------------------------------

const diagnosticState = new Map();

function makeDiagnosticSession() {
  return {
    issueType: null,
    evidence: {},
    askedTargets: [],
    escalatedTargets: [],
    turnCount: 0,
    updatedAt: now()
  };
}

function getDiagnosticSession(from) {
  if (!from) return makeDiagnosticSession();
  let state = diagnosticState.get(from);
  if (!state) {
    state = makeDiagnosticSession();
    diagnosticState.set(from, state);
    return state;
  }
  if (now() - state.updatedAt > DIAGNOSTIC_TTL_MS) {
    state = makeDiagnosticSession();
    diagnosticState.set(from, state);
  }
  return state;
}

function touchDiagnosticSession(from) {
  const state = getDiagnosticSession(from);
  state.updatedAt = now();
  diagnosticState.set(from, state);
  return state;
}

function rememberDiagnosticEvidence(from, key, value) {
  if (!from || !key) return;

  const state = touchDiagnosticSession(from);
  const existingValue = state.evidence[key];

  if (
    existingValue !== undefined &&
    existingValue !== value
  ) {
    console.warn("Diagnostic evidence conflict ignored:", {
      from,
      key,
      existingValue,
      incomingValue: value
    });
    return;
  }

  state.evidence[key] = value;
  state.updatedAt = now();
}

function rememberIssueType(from, issueType) {
  if (!from || !issueType) return;
  const state = touchDiagnosticSession(from);
  if (!state.issueType) state.issueType = issueType;
}

function rememberAskedTarget(from, target) {
  if (!from || !target) return;
  const state = touchDiagnosticSession(from);
  if (!state.askedTargets.includes(target)) {
  state.askedTargets.push(target);
  state.turnCount += 1;
}
}

function rememberEscalatedTarget(from, target) {
  if (!from || !target) return;

  const state = touchDiagnosticSession(from);

  if (!Array.isArray(state.escalatedTargets)) {
    state.escalatedTargets = [];
  }

  if (!state.escalatedTargets.includes(target)) {
    state.escalatedTargets.push(target);
  }

  state.updatedAt = now();
}

function wasTargetEscalated(session, target) {
  return Array.isArray(session?.escalatedTargets) &&
    session.escalatedTargets.includes(target);
}

function clearDiagnosticSession(from) {
  if (from) diagnosticState.delete(from);
}

// -----------------------------------------------------------------------------
// 5. Intent classifier
// -----------------------------------------------------------------------------

function classifyConversationIntent(text) {
  const input = normalizeText(text);
  if (!input) return "general";

  const handoffPatterns = [
    "hubungi admin", "bicara dengan admin", "sambungkan ke admin",
    "minta admin", "hubungi teknisi", "bicara dengan teknisi",
    "sambungkan ke teknisi", "minta teknisi"
  ];

  const diagnosticPatterns = [
    "mati sendiri", "shutdown", "fault", "error", "alarm",
    "tidak bisa starter", "tidak bisa start", "gagal start", "tidak mau hidup",
    "tidak keluar tegangan", "tidak ada tegangan", "overheat",
    "low oil pressure", "under voltage", "over voltage",
    "trip", "tidak menyala", "mesin tidak hidup"
  ];

  const salesPatterns = [
    "harga", "beli", "pesan", "order", "penawaran", "quotation",
    "berapa kva", "stok", "ready", "mau beli", "minta harga"
  ];

  const technicalPatterns = [
    "cara setting", "cara pasang", "wiring", "instalasi",
    "setting controller", "dse", "deep sea", "star delta",
    "ats", "amf", "panel listrik", "cara merakit"
  ];

  const greetingPatterns = [
    "halo", "hai", "hi", "hello", "pagi", "siang", "sore", "malam",
    "assalamualaikum", "selamat pagi", "selamat siang", "selamat sore", "selamat malam"
  ];

  if (includesAny(input, handoffPatterns)) return "handoff";
if (includesAny(input, salesPatterns)) return "sales";
if (includesAny(input, diagnosticPatterns)) return "diagnostic";
if (includesAny(input, technicalPatterns)) return "technical";
if (includesAny(input, greetingPatterns)) return "greeting";
  return "general";
}

function routeForIntent(intent) {
  return {
    greeting: "greeting_flow",
    general: "general_ai",
    sales: "sales_flow",
    technical: "technical_flow",
    diagnostic: "diagnostic_flow",
    handoff: "human_handoff"
  }[intent] || "general_ai";
}

// -----------------------------------------------------------------------------
// 6. Diagnostic issue classification
// -----------------------------------------------------------------------------

function classifyDiagnosticIssue(text, existingIssueType = null) {
  if (existingIssueType) return existingIssueType;
  const t = normalizeText(text);

  if (includesAny(t, [
    "tidak bisa starter", "tidak bisa start", "gagal start", "tidak mau hidup",
    "mesin tidak hidup", "mesin tidak menyala"
  ])) return "no_start";

  if (includesAny(t, ["shutdown", "mati sendiri", "trip sendiri"])) return "shutdown";

  if (includesAny(t, [
    "tidak keluar tegangan", "tidak ada tegangan", "genset hidup tapi tidak keluar tegangan",
    "no voltage", "under voltage", "over voltage"
  ])) return "no_output_voltage";

  if (includesAny(t, ["overheat", "temperatur tinggi", "suhu tinggi"])) return "overheat";

  return "generic_diagnostic";
}

function detectDeclaredDiagnosticIssue(text) {
  const t = normalizeText(text);

  const noStartDeclaration =
    /^(?:(?:genset|mesin)(?: saya)?\s+)?(?:tidak bisa starter|tidak bisa start|gagal start|tidak mau hidup|tidak hidup|tidak menyala)$/;

  const shutdownDeclaration =
    /^(?:(?:genset|mesin)(?: saya)?\s+)?(?:shutdown|mati sendiri|trip sendiri)$/;

  const noOutputVoltageDeclaration =
    /^(?:(?:genset|mesin)(?: saya)?\s+)?(?:tidak keluar tegangan|tidak ada tegangan|no voltage|under voltage|over voltage)$/;

  const overheatDeclaration =
    /^(?:(?:genset|mesin)(?: saya)?\s+)?(?:overheat|temperatur tinggi|suhu tinggi)$/;

  if (noStartDeclaration.test(t)) return "no_start";
  if (shutdownDeclaration.test(t)) return "shutdown";
  if (noOutputVoltageDeclaration.test(t)) return "no_output_voltage";
  if (overheatDeclaration.test(t)) return "overheat";

  return null;
}

// -----------------------------------------------------------------------------
// 7. Strict confirmed-evidence ingestion
// -----------------------------------------------------------------------------

function ingestDiagnosticTextEvidence(from, text) {
  const t = normalizeText(text);
  if (!t) return;

  const explicitCorrection = isExplicitDiagnosticCorrection(t);

const previousIssueType = explicitCorrection
  ? getDiagnosticSession(from).issueType
  : null;

if (explicitCorrection) {
  clearDiagnosticSession(from);
}

const session = touchDiagnosticSession(from);

const correctedIssueType = explicitCorrection
  ? classifyDiagnosticIssue(t, null)
  : null;

const issueType =
  explicitCorrection &&
  correctedIssueType === "generic_diagnostic" &&
  previousIssueType
    ? previousIssueType
    : classifyDiagnosticIssue(t, session.issueType);

if (!session.issueType) session.issueType = issueType;

  // Explicit engine-start state.
  if (includesAny(t, [
    "mesin tidak hidup", "tidak berhasil hidup", "gagal hidup",
    "mesin tidak menyala", "starter berputar tapi mesin tidak hidup"
  ])) {
    rememberDiagnosticEvidence(from, "engineStarted", false);

// Deterministic transition:
// generator cannot have a no-output-voltage case before the engine is running.
if (
  session.issueType === "no_output_voltage" &&
  session.evidence.engineStarted === false
) {
  session.issueType = "no_start";
  session.updatedAt = now();
}
  }
  
  if (includesAny(t, [
    "mesin sudah hidup", "mesin berhasil hidup", "genset sudah hidup",
    "genset hidup", "mesin menyala"
  ]) && !includesAny(t, ["tidak hidup", "tidak menyala"])) {
    rememberDiagnosticEvidence(from, "engineStarted", true);
  }

  // Starter/cranking: only explicit statements are accepted.
  if (includesAny(t, [
    "starter berputar", "starter muter", "starter cranking",
    "mesin berputar saat starter", "cranking berputar"
  ])) {
    rememberDiagnosticEvidence(from, "starterCranking", true);
  }

  if (includesAny(t, [
    "starter tidak berputar", "starter tidak muter", "tidak cranking",
    "tidak ada cranking", "starter diam", "starter tidak jalan"
  ])) {
    rememberDiagnosticEvidence(from, "starterCranking", false);
  }

  // Exhaust smoke during cranking.
  if (includesAny(t, [
    "tidak ada asap", "tidak keluar asap", "tanpa asap", "tidak terlihat asap"
  ])) {
    rememberDiagnosticEvidence(from, "exhaustSmokePresent", false);
  }

  if (
    includesAny(t, ["ada asap", "keluar asap", "terlihat asap"]) &&
    !includesAny(t, ["tidak ada asap", "tidak keluar asap", "tidak terlihat asap"])
  ) {
    rememberDiagnosticEvidence(from, "exhaustSmokePresent", true);
  }

  // Alarm/fault.
  if (includesAny(t, [
    "tidak ada alarm", "tidak ada kode fault", "tidak ada fault", "tanpa alarm"
  ])) {
    rememberDiagnosticEvidence(from, "alarmOrFaultPresent", false);
  }

  if (
    includesAny(t, ["ada alarm", "muncul alarm", "ada fault", "kode fault", "fault muncul"]) &&
    !includesAny(t, ["tidak ada alarm", "tidak ada fault", "tidak ada kode fault"])
  ) {
    rememberDiagnosticEvidence(from, "alarmOrFaultPresent", true);
    const faultMatch = t.match(/(?:alarm|fault|kode fault)\s*[:\-]?\s*([a-z0-9 _./-]{2,40})/i);
    if (faultMatch?.[1]) rememberDiagnosticEvidence(from, "faultText", faultMatch[1].trim());
  }

  // Engine speed / RPM during cranking.
  if (/(rpm|engine speed)/.test(t) && /(cranking|starter|start)/.test(t)) {
    if (/(tetap|masih|terbaca)?\s*0\s*(rpm)?/.test(t) || t.includes("rpm 0")) {
      rememberDiagnosticEvidence(from, "rpmDuringCranking", 0);
    } else {
      const rpmMatch = t.match(/(?:rpm|engine speed)[^0-9]{0,12}(\d{2,4})|(?:terbaca|naik|sekitar)\s*(\d{2,4})\s*rpm/);
      const rpmValue = Number(rpmMatch?.[1] || rpmMatch?.[2]);
      if (Number.isFinite(rpmValue) && rpmValue > 0) {
        rememberDiagnosticEvidence(from, "rpmDuringCranking", rpmValue);
      }
    }
  }

  // Battery voltage while cranking.
  if (/(baterai|aki|battery)/.test(t) && /(cranking|starter|start)/.test(t)) {
    const voltageMatch = t.match(/(\d{1,2}(?:[.,]\d+)?)\s*(?:v|volt)/);
    if (voltageMatch) {
      const value = Number(voltageMatch[1].replace(",", "."));
      if (Number.isFinite(value)) rememberDiagnosticEvidence(from, "batteryVoltageCranking", value);
    } else if (includesAny(t, ["di atas 12 volt", "lebih dari 12 volt", "tetap di atas 12 volt"])) {
      rememberDiagnosticEvidence(from, "batteryVoltageCranking", ">12");
    }
  }

  // Oil pressure during cranking - retain numeric OR explicit qualitative evidence.
if (/(tekanan oli|oil pressure)/.test(t) && /(cranking|crank|starter)/.test(t)) {
  const oilMatch = t.match(/(?:tekanan oli|oil pressure)[^0-9]{0,20}(\d+(?:[.,]\d+)?)/);

  if (oilMatch) {
    const value = Number(oilMatch[1].replace(",", "."));
    if (Number.isFinite(value)) {
      rememberDiagnosticEvidence(from, "oilPressureDuringCranking", value);
    }
  } else if (includesAny(t, [
    "tekanan oli naik",
    "tekanan oli terbaca naik",
    "oil pressure naik",
    "oil pressure rises"
  ])) {
    rememberDiagnosticEvidence(from, "oilPressureDuringCranking", ">0");
  } else if (includesAny(t, [
    "tekanan oli tidak naik",
    "tekanan oli tetap 0",
    "menunjukkan 0",
    "nilai 0",
    "tetap 0"
  ])) {
    rememberDiagnosticEvidence(from, "oilPressureDuringCranking", 0);
  }
}

  // Generator output voltage - do not confuse with battery/cranking voltage.
if (
  /(tegangan|voltage)/.test(t) &&
  !/(baterai|aki|battery)/.test(t) &&
  !/(cranking|crank|starter)/.test(t)
) {
  const voltageMatch = t.match(/(\d{2,4}(?:[.,]\d+)?)\s*(?:v|volt)/);

  if (voltageMatch) {
    const value = Number(voltageMatch[1].replace(",", "."));

    if (Number.isFinite(value)) {
      rememberDiagnosticEvidence(from, "outputVoltage", value);
    }
  }
}

  session.updatedAt = now();
}

// -----------------------------------------------------------------------------
// 8. Deterministic diagnostic target selector
// -----------------------------------------------------------------------------

function selectDiagnosticTarget(session) {
  const issue = session.issueType || "generic_diagnostic";
  const e = session.evidence || {};

  if (issue === "no_start" && e.engineStarted === true) {
  return "no_start_resolved";
}
  
  if (session.turnCount >= MAX_DIAGNOSTIC_TURNS) return "human_handoff";

  if (issue === "no_start") {
    if (typeof e.starterCranking !== "boolean") return "starter_cranking";

    if (e.starterCranking === false) {
      if (e.batteryVoltageCranking === undefined) return "battery_voltage_cranking";
      if (typeof e.alarmOrFaultPresent !== "boolean") return "alarm_fault";
      return "starter_control_evidence";
    }

    if (typeof e.alarmOrFaultPresent !== "boolean") return "alarm_fault";
    if (e.alarmOrFaultPresent === true && !e.faultText) {
  return "alarm_fault";
}
if (typeof e.exhaustSmokePresent !== "boolean") return "exhaust_smoke";
    if (e.rpmDuringCranking === undefined) return "rpm_during_cranking";
    if (e.batteryVoltageCranking === undefined) return "battery_voltage_cranking";
    return "fuel_control_evidence";
  }

  if (issue === "shutdown") {
  if (typeof e.alarmOrFaultPresent !== "boolean") return "alarm_fault";

  if (e.alarmOrFaultPresent === true && !e.faultText) {
    return "shutdown_fault_detail";
  }

  return "shutdown_operating_data";
}

  if (issue === "no_output_voltage") {
  if (typeof e.engineStarted !== "boolean") {
    return "engine_running_confirmation";
  }

  if (e.engineStarted === false) {
    return "starter_cranking";
  }

  if (e.outputVoltage === undefined) {
    return "output_voltage_measurement";
  }

  return "alternator_controller_evidence";
}

  if (issue === "overheat") {
    if (typeof e.alarmOrFaultPresent !== "boolean") return "alarm_fault";
    return "temperature_measurement";
  }

  if (typeof e.alarmOrFaultPresent !== "boolean") return "alarm_fault";
  return "objective_evidence";
}

function targetAlreadyAskedWithoutEvidence(session, target) {
  if (!session.askedTargets.includes(target)) return false;

  const e = session.evidence || {};

  switch (target) {
    case "starter_cranking":
      return typeof e.starterCranking !== "boolean";

    case "exhaust_smoke":
      return typeof e.exhaustSmokePresent !== "boolean";

    case "alarm_fault":
  return (
    typeof e.alarmOrFaultPresent !== "boolean" ||
    (e.alarmOrFaultPresent === true && !e.faultText)
  );

    case "rpm_during_cranking":
      return e.rpmDuringCranking === undefined;

    case "battery_voltage_cranking":
      return e.batteryVoltageCranking === undefined;

    case "engine_running_confirmation":
      return typeof e.engineStarted !== "boolean";

    case "starter_control_evidence":
    case "fuel_control_evidence":
    case "shutdown_operating_data":
    case "alternator_controller_evidence":
    case "temperature_measurement":
    case "objective_evidence":
      return true;

    default:
      return true;
  }
}

// -----------------------------------------------------------------------------
// 9. Diagnostic target prompts
// -----------------------------------------------------------------------------

const DIAGNOSTIC_TARGET_INSTRUCTIONS = {
  starter_cranking: `
TARGET: STARTER_CRANKING
Ajukan SATU pertanyaan untuk memastikan apakah starter/cranking benar-benar berputar saat tombol START ditekan.
Jangan bertanya tentang asap, oli, bahan bakar, RPM, atau tegangan sebelum kondisi cranking diketahui.`,

  exhaust_smoke: `
TARGET: EXHAUST_SMOKE
Starter/cranking sudah dikonfirmasi berputar. Ajukan SATU pertanyaan untuk memastikan ada atau tidaknya asap dari knalpot saat cranking.
Jangan menanyakan starter/cranking lagi.`,

  alarm_fault: `
TARGET: ALARM_FAULT
Ajukan SATU pertanyaan untuk memastikan apakah ada alarm/kode fault di controller pada saat gangguan terjadi.
Jika ada, minta satu kode/alarm yang tampil.`,

  rpm_during_cranking: `
TARGET: RPM_DURING_CRANKING
Ajukan SATU pertanyaan untuk mengetahui apakah RPM/engine speed di controller terbaca naik saat cranking atau tetap 0.
Jangan mengulang bukti starter, asap, atau alarm yang sudah diketahui.`,

  battery_voltage_cranking: `
TARGET: BATTERY_VOLTAGE_CRANKING
Ajukan SATU pertanyaan untuk meminta tegangan baterai/aki yang TERUKUR saat cranking.
Jangan memberikan angka diagnosis final sebelum customer memberikan hasil ukur.`,

  starter_control_evidence: `
TARGET: STARTER_CONTROL_EVIDENCE
Mesin tidak cranking dan bukti dasar sudah dikumpulkan. Minta SATU bukti objektif berikutnya yang paling aman: foto controller/panel saat START atau hasil ukur tegangan pada rangkaian starter.
Jangan memberi daftar pemeriksaan panjang.`,

  fuel_control_evidence: `
TARGET: FUEL_CONTROL_EVIDENCE
Mesin cranking tetapi belum hidup dan bukti dasar sudah dikumpulkan. Minta SATU bukti objektif baru yang paling menentukan terkait perintah/fuel saat cranking, misalnya foto controller atau status fuel solenoid.
Jangan menebak kerusakan komponen.`,

  shutdown_fault_detail: `
TARGET: SHUTDOWN_FAULT_DETAIL
Ada indikasi fault/alarm. Ajukan SATU pertanyaan untuk memperoleh teks/kode fault persis yang tampil ketika shutdown.`,

  shutdown_operating_data: `
TARGET: SHUTDOWN_OPERATING_DATA
Minta SATU data objektif paling bernilai tepat sebelum shutdown, misalnya temperatur coolant atau tekanan oli yang terbaca controller.
Jangan meminta dua data sekaligus.`,

  engine_running_confirmation: `
TARGET: ENGINE_RUNNING_CONFIRMATION
Ajukan SATU pertanyaan untuk memastikan mesin genset benar-benar hidup/stabil sebelum membahas keluaran tegangan.`,

  output_voltage_measurement: `
TARGET: OUTPUT_VOLTAGE_MEASUREMENT
Ajukan SATU pertanyaan untuk meminta hasil pengukuran tegangan keluaran genset yang objektif pada terminal/output atau nilai yang terbaca controller.`,

  alternator_controller_evidence: `
TARGET: ALTERNATOR_CONTROLLER_EVIDENCE
Minta SATU bukti objektif berikutnya yang paling menentukan dari sisi alternator/controller, tanpa langsung menyimpulkan AVR atau alternator rusak.`,

  temperature_measurement: `
TARGET: TEMPERATURE_MEASUREMENT
Ajukan SATU pertanyaan untuk meminta temperatur coolant/engine yang terbaca controller saat alarm overheat terjadi.`,

  objective_evidence: `
TARGET: OBJECTIVE_EVIDENCE
Minta SATU bukti objektif baru yang paling relevan dengan gangguan: kode alarm, satu hasil ukur, atau satu foto controller.`,

  no_start_resolved: `
TARGET: NO_START_RESOLVED
Customer sudah menyatakan mesin berhasil hidup. Jangan lanjutkan alur no-start. Tanyakan singkat apakah masih ada gangguan lain yang ingin diperiksa.`
};

function buildEvidenceContext(session) {
  const e = session.evidence;
  const yesNoUnknown = (value) => value === true ? "YA" : value === false ? "TIDAK" : "BELUM DIKETAHUI";

  return `
KASUS DIAGNOSTIK: ${session.issueType || "BELUM DIKLASIFIKASI"}

BUKTI YANG SUDAH DIKONFIRMASI CUSTOMER:
- Starter/cranking berputar: ${yesNoUnknown(e.starterCranking)}
- Mesin berhasil hidup: ${yesNoUnknown(e.engineStarted)}
- Asap knalpot saat cranking: ${yesNoUnknown(e.exhaustSmokePresent)}
- Alarm/kode fault muncul: ${yesNoUnknown(e.alarmOrFaultPresent)}
- Teks fault: ${e.faultText || "BELUM DIKETAHUI"}
- RPM saat cranking: ${e.rpmDuringCranking ?? "BELUM DIKETAHUI"}
- Tegangan baterai saat cranking: ${e.batteryVoltageCranking ?? "BELUM DIKETAHUI"}
- Tekanan oli saat cranking: ${e.oilPressureDuringCranking ?? "BELUM DIKETAHUI"}
- Tegangan output: ${e.outputVoltage ?? "BELUM DIKETAHUI"}

ATURAN LEDGER:
1. Semua bukti di atas adalah fakta yang sudah dikonfirmasi.
2. Jangan menanyakan kembali fakta yang sudah diketahui.
3. Jangan membuat parafrase dari pertanyaan yang sudah terjawab.
4. Jangan menyimpulkan kerusakan final tanpa bukti yang cukup.`;
}

// -----------------------------------------------------------------------------
// 10. OpenAI Responses API helpers
// -----------------------------------------------------------------------------

async function askOpenAI(input, maxOutputTokens = 350) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");

  try {
    const response = await axios.post(
      "https://api.openai.com/v1/responses",
      {
        model: OPENAI_MODEL,
        input,
        max_output_tokens: maxOutputTokens
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
      ?.flatMap((item) => item?.content || [])
      ?.filter((item) => item?.type === "output_text")
      ?.map((item) => item?.text || "")
      ?.join("")
      ?.trim();

    if (!outputText) {
      throw new Error("OpenAI returned no text output");
    }

    return outputText;
  } catch (err) {
    const status = err?.response?.status || null;
    const apiError = err?.response?.data?.error || null;

    console.error("[OPENAI_REQUEST_ERROR]", {
      status,
      type: apiError?.type || null,
      code: apiError?.code || null,
      message: apiError?.message || err?.message || "Unknown OpenAI error"
    });

    throw err;
  }
}

async function buildDiagnosticQuestion(session, customerText, target) {
  const targetInstruction = DIAGNOSTIC_TARGET_INSTRUCTIONS[target];
  if (!targetInstruction) return null;

  const prompt = `
Anda adalah Admin Purimata, asisten troubleshooting genset dan panel.

${buildEvidenceContext(session)}

${targetInstruction}

ATURAN WAJIB:
1. Jawab hanya dengan SATU pertanyaan atau SATU permintaan bukti sesuai TARGET.
2. Maksimal 2 kalimat pendek.
3. Jangan memberi checklist.
4. Jangan memberi beberapa kemungkinan penyebab sekaligus.
5. Jangan melakukan diagnosis prematur.
6. Jangan mengulang informasi yang sudah dikonfirmasi.
7. Gunakan bahasa Indonesia yang sederhana dan natural.
8. Jangan menyebut nama internal TARGET, ledger, gate, atau aturan sistem.

Pesan customer terbaru:
${customerText}
`;

  return askOpenAI(prompt, 180);
}

// -----------------------------------------------------------------------------
// 11. WhatsApp send / media download
// -----------------------------------------------------------------------------

async function sendWhatsAppText(recipient, text) {
  if (!WHATSAPP_TOKEN) throw new Error("WHATSAPP_TOKEN is not configured");
  if (!PHONE_NUMBER_ID) throw new Error("PHONE_NUMBER_ID is not configured");
  if (!recipient) throw new Error("WhatsApp recipient is required");
  if (!String(text || "").trim()) throw new Error("WhatsApp text message is empty");

  try {
  await axios.post(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: recipient,
      type: "text",
      text: { preview_url: false, body: String(text).trim() }
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      },
      timeout: 30000
    }
  );
} catch (err) {
  const status = err?.response?.status || null;
  const metaError = err?.response?.data?.error || null;

  console.error("[WHATSAPP_SEND_ERROR]", {
    status,
    type: metaError?.type || null,
    code: metaError?.code || null,
    subcode: metaError?.error_subcode || null,
    message: metaError?.message || err?.message || "Unknown WhatsApp API error"
  });

  throw err;
}
}

async function downloadWhatsAppImageAsDataUrl(mediaId) {
  if (!mediaId) throw new Error("Missing WhatsApp media ID");
  if (!WHATSAPP_TOKEN) throw new Error("WHATSAPP_TOKEN is not configured");

  const meta = await axios.get(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${mediaId}`,
    {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
      timeout: 30000
    }
  );

  const mediaUrl = meta.data?.url;
  if (!mediaUrl) throw new Error("WhatsApp media URL not returned");

  const binary = await axios.get(mediaUrl, {
    responseType: "arraybuffer",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    timeout: 30000,
    maxContentLength: 12 * 1024 * 1024
  });

  const mimeType = binary.headers?.["content-type"] || meta.data?.mime_type || "image/jpeg";
  return `data:${mimeType};base64,${Buffer.from(binary.data).toString("base64")}`;
}

async function analyzeDiagnosticImage(from, mediaId, caption = "") {
  const session = getDiagnosticSession(from);
  const target = selectDiagnosticTarget(session);
  const dataUrl = await downloadWhatsAppImageAsDataUrl(mediaId);

  const prompt = `
Analisis foto ini hanya sebagai bukti visual untuk troubleshooting genset/panel PURIMATA.
Jangan membuat diagnosis final.
Kembalikan JSON saja dengan bentuk:
{
  "confidence": 0.0,
  "controllerVisible": true|false|null,
  "alarmOrFaultPresent": true|false|null,
  "faultText": "teks fault jika terbaca, selain itu null",
  "rpmVisible": true|false|null,
  "rpmValue": number|null,
  "voltageVisible": true|false|null,
  "voltageValue": number|null,
  "notes": "ringkas"
}
Hanya isi nilai yang benar-benar terlihat. Jika ragu gunakan null. Confidence 0 sampai 1.
Caption customer: ${caption || "(tidak ada)"}
Kasus saat ini: ${session.issueType || "belum diketahui"}
`;

  const input = [
    {
      role: "user",
      content: [
        { type: "input_text", text: prompt },
        { type: "input_image", image_url: dataUrl }
      ]
    }
  ];

  const resultText = await askOpenAI(input, 250);
  const result = safeJsonParse(resultText);
  if (!result || Number(result.confidence || 0) < 0.7) return null;

  if (typeof result.alarmOrFaultPresent === "boolean") {
  rememberDiagnosticEvidence(
    from,
    "alarmOrFaultPresent",
    result.alarmOrFaultPresent
  );
}

if (
  result.alarmOrFaultPresent === true &&
  result.faultText
) {
  rememberDiagnosticEvidence(
    from,
    "faultText",
    String(result.faultText).slice(0, 80)
  );
}

// Contextual RPM typing:
// only accept RPM as cranking RPM when that target is active.
if (
  target === "rpm_during_cranking" &&
  Number.isFinite(Number(result.rpmValue))
) {
  rememberDiagnosticEvidence(
    from,
    "rpmDuringCranking",
    Number(result.rpmValue)
  );
}

// Contextual voltage typing:
// do not treat every visible voltage as generator output voltage.
if (
  target === "battery_voltage_cranking" &&
  Number.isFinite(Number(result.voltageValue))
) {
  rememberDiagnosticEvidence(
    from,
    "batteryVoltageCranking",
    Number(result.voltageValue)
  );
}

if (
  target === "output_voltage_measurement" &&
  session.evidence?.engineStarted === true &&
  Number.isFinite(Number(result.voltageValue))
) {
  rememberDiagnosticEvidence(
    from,
    "outputVoltage",
    Number(result.voltageValue)
  );
}

  return result;
}

// -----------------------------------------------------------------------------
// 12. Route handlers
// -----------------------------------------------------------------------------

async function handleGreeting() {
  return "Halo, saya Admin Purimata. Ada yang bisa saya bantu mengenai genset, panel ATS/AMF, instalasi, atau troubleshooting?";
}

async function handleSales() {
  return "Untuk harga panel, genset, atau pekerjaan custom, Admin Purimata tidak memberikan perkiraan harga otomatis. Sebutkan kebutuhan utama Anda agar saya arahkan ke Admin/teknisi untuk penawaran sesuai spesifikasi.";
}

async function handleHumanHandoff(from) {
  clearRememberedConversationRoute(from);
  clearDiagnosticSession(from);
  return "Baik, saya akan arahkan percakapan ini ke Admin/teknisi Purimata untuk tindak lanjut.";
}

async function handleTechnical(text) {
  const prompt = `
Anda adalah Admin Purimata yang menangani pertanyaan teknis genset dan panel.
ATURAN WAJIB:
1. Pahami topik teknis dari pesan customer saat ini.
2. Jawab hanya dengan SATU pertanyaan klarifikasi ATAU SATU langkah teknis berikutnya.
3. Jangan memberi checklist panjang.
4. Jangan memberi beberapa kemungkinan penyebab sekaligus.
5. Jangan meminta lebih dari SATU informasi dalam satu balasan.
6. Jangan melakukan diagnosis kerusakan prematur.
7. Jika prosedur tergantung tipe/model perangkat, tanyakan tipe/model terlebih dahulu.
8. Jika informasi sudah cukup untuk satu langkah aman, berikan hanya SATU langkah itu.
9. Maksimal 2 kalimat pendek.
10. Jangan mengalihkan topik ke troubleshooting lain kecuali customer memang membahasnya.

Pesan customer:
${text}
`;
  return askOpenAI(prompt, 220);
}

async function handleGeneral(text) {
  const prompt = `
Anda adalah Admin Purimata di Surabaya. PURIMATA melayani panel ATS/AMF custom, genset Perkins/Cummins/Isuzu/Emerald, controller Deep Sea, konsultasi, instalasi, troubleshooting, dan survey kebutuhan di Indonesia.
Jawab ringkas dan relevan. Jangan mengarang harga. Jika pertanyaan memerlukan pemeriksaan teknis, arahkan percakapan secara bertahap tanpa diagnosis prematur.

Pesan customer:
${text}
`;
  return askOpenAI(prompt, 260);
}

async function handleDiagnostic(from, text) {
  const session = touchDiagnosticSession(from);
  if (!session.issueType) session.issueType = classifyDiagnosticIssue(text, null);

  const target = selectDiagnosticTarget(session);
  console.log("Diagnostic target:", { from, issueType: session.issueType, target, evidence: session.evidence });

  if (target === "human_handoff") {
    clearRememberedConversationRoute(from);
    clearDiagnosticSession(from);
    return "Pemeriksaan lewat chat sudah mencapai batas aman. Saya akan arahkan kasus ini ke Admin/teknisi Purimata untuk pemeriksaan lanjutan.";
  }

 if (target === "no_start_resolved") {
  clearRememberedConversationRoute(from);
  clearDiagnosticSession(from);
  return "Baik, mesin sudah berhasil hidup. Apakah masih ada gangguan lain yang ingin diperiksa?";
}
  
  // Semantic repetition guard: do not ask the same diagnostic target again if the
  // customer already received it but gave no machine-readable evidence.
  if (targetAlreadyAskedWithoutEvidence(session, target)) {
   if (wasTargetEscalated(session, target)) {
  clearRememberedConversationRoute(from);
  clearDiagnosticSession(from);
  return "Bukti yang dibutuhkan belum cukup untuk melanjutkan diagnosis dengan aman. Saya akan arahkan kasus ini ke Admin/teknisi Purimata untuk pemeriksaan lebih lanjut.";
} 
    if (target === "starter_cranking") {
      rememberEscalatedTarget(from, target);
      return "Agar tidak mengulang pertanyaan, kirim video singkat saat tombol START ditekan atau jelaskan satu hal saja: starter berputar atau tidak berputar.";
    }
    if (target === "exhaust_smoke") {
      rememberEscalatedTarget(from, target);
      return "Agar tidak mengulang pertanyaan, kirim video singkat knalpot saat cranking atau jawab satu hal saja: ada asap atau tidak ada asap.";
    }
    if (target === "alarm_fault") {
      rememberEscalatedTarget(from, target);
      return "Agar tidak mengulang pertanyaan, kirim foto controller saat gangguan terjadi agar alarm/kode fault dapat diperiksa.";
    }
   rememberEscalatedTarget(from, target); 
    return "Agar diagnosis tidak berputar, kirim satu bukti objektif baru seperti foto controller atau satu hasil pengukuran yang relevan.";
  }

  const question = await buildDiagnosticQuestion(session, text, target);
  rememberAskedTarget(from, target);
  return question || "Kirim satu bukti objektif terbaru dari controller atau hasil pengukuran agar diagnosis bisa dilanjutkan.";
}

// -----------------------------------------------------------------------------
// 13. Inbound message normalization
// -----------------------------------------------------------------------------

function normalizeWhatsAppMessage(message) {
  const type = message?.type;
  return {
    messageId: message?.id || null,
    from: message?.from || null,
    type: type || null,
    text:
      type === "text" ? message.text?.body?.trim() || "" :
      type === "image" ? message.image?.caption?.trim() || "" :
      type === "document" ? message.document?.caption?.trim() || "" :
      type === "video" ? message.video?.caption?.trim() || "" : "",
    mediaId:
      type === "image" ? message.image?.id || null :
      type === "audio" ? message.audio?.id || null :
      type === "document" ? message.document?.id || null :
      type === "video" ? message.video?.id || null : null,
    timestamp: message?.timestamp || null
  };
}

// -----------------------------------------------------------------------------
// 14. Message processing pipeline
// -----------------------------------------------------------------------------

async function processInboundMessage(normalizedMessage) {
  const { messageId, from, type, text, mediaId } = normalizedMessage;

  if (!messageId || !from || !type) {
    console.warn("Invalid WhatsApp message: missing required fields");
    return;
  }

  const supportedTypes = new Set(["text", "image"]);
  if (!supportedTypes.has(type)) {
    console.log(`Unsupported WhatsApp message type ignored: ${type}`);
    return;
  }

  const processingState = getMessageProcessingState(messageId);

if (processingState === "completed" || processingState === "in_flight") {
  console.log(`Duplicate WhatsApp message ignored: ${messageId} (${processingState})`);
  return;
}

markMessageInFlight(messageId);

  let processingFailed = false;

try {
  
  console.log("WhatsApp inbound message:", { messageId, from, type, text, mediaId, timestamp: normalizedMessage.timestamp });

  // Images inside an active diagnostic session are treated as objective evidence.
  const rememberedRoute = getRememberedConversationRoute(from);
  if (type === "image" && rememberedRoute === "diagnostic_flow") {
    rememberConversationRoute(from, rememberedRoute);
    
    try {
      const visual = await analyzeDiagnosticImage(from, mediaId, text);
      console.log("Diagnostic visual evidence:", { from, visual });
      const reply = await handleDiagnostic(from, text || "Customer mengirim foto bukti diagnostik.");
      await sendWhatsAppText(from, reply);
      return;
    } catch (error) {
      console.error("Image diagnostic analysis failed:", error.message);
      await sendWhatsAppText(from, "Foto sudah diterima, tetapi bukti visual belum dapat dibaca dengan cukup yakin. Kirim foto controller yang lebih dekat dan jelas atau tuliskan kode/alarm yang terlihat.");
      return;
    }
  }

  // For other non-text media, avoid pretending the bot analyzed content it cannot reliably use.
  if (type !== "text") {
    await sendWhatsAppText(from, "Media sudah diterima. Untuk diagnosis saat ini, kirim satu foto controller yang jelas atau tuliskan satu data yang terlihat, misalnya kode alarm, RPM, atau tegangan.");
    return;
  }

  if (!text) return;

 let intent = classifyConversationIntent(text);
const existingRoute = getRememberedConversationRoute(from);

const explicitDiagnosticCorrection =
  isExplicitDiagnosticCorrection(text);

const declaredDiagnosticIssue =
  detectDeclaredDiagnosticIssue(text);

const startsNewDiagnosticCase =
  existingRoute === "diagnostic_flow" &&
  intent === "diagnostic" &&
  !explicitDiagnosticCorrection &&
  declaredDiagnosticIssue !== null;

if (startsNewDiagnosticCase) {
  clearDiagnosticSession(from);
  intent = "diagnostic";
} else if (
  existingRoute === "diagnostic_flow" &&
  (explicitDiagnosticCorrection ||
    (intent !== "handoff" && intent !== "sales"))
) {
  intent = "diagnostic";
}
  
  const route = routeForIntent(intent);

  if (route === "diagnostic_flow") {
  rememberConversationRoute(from, route);
  ingestDiagnosticTextEvidence(from, text);
} else if (route === "human_handoff" || route === "sales_flow") {
  clearRememberedConversationRoute(from);
    clearDiagnosticSession(from);
}

  console.log("Conversation route:", { from, intent, route });

  let replyText;
  switch (route) {
    case "greeting_flow":
      replyText = await handleGreeting();
      break;
    case "sales_flow":
      replyText = await handleSales();
      break;
    case "human_handoff":
      replyText = await handleHumanHandoff(from);
      break;
    case "technical_flow":
      replyText = await handleTechnical(text);
      break;
    case "diagnostic_flow":
      replyText = await handleDiagnostic(from, text);
      break;
    case "general_ai":
    default:
      replyText = await handleGeneral(text);
      break;
  }

  if (replyText) await sendWhatsAppText(from, replyText);
} catch (error) {
  processingFailed = true;
  throw error;
} finally {
  if (processingFailed) {
    releaseMessageInFlight(messageId);
  } else {
    markMessageCompleted(messageId);
  }
}
}

// -----------------------------------------------------------------------------
// 15. HTTP endpoints
// -----------------------------------------------------------------------------

app.get("/", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "PURIMATA Bot V3",
version: "3.0-audit"
  });
});

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

app.post("/webhook", (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    // Acknowledge Meta immediately. Non-message events are valid webhook traffic.
    res.sendStatus(200);
    if (!message) return;

    const normalizedMessage = normalizeWhatsAppMessage(message);

    processInboundMessage(normalizedMessage).catch((error) => {
      console.error("Inbound processing error:", {
        message: error.message,
        status: error.response?.status || null,
        metaError: error.response?.data?.error || null
      });
    });
  } catch (error) {
    console.error("Webhook envelope error:", error.message);
    if (!res.headersSent) res.sendStatus(200);
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`PURIMATA Bot V3 running on 0.0.0.0:${PORT}`);
});
