"use strict";

const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

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
app.post("/webhook", (req, res) => {
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

rememberProcessedMessage(messageId);
    
console.log("WhatsApp inbound message:", normalizedMessage);

    return res.sendStatus(200);
  } catch (error) {
    console.error("Inbound webhook error:", error);
    return res.sendStatus(200);
  }
});

app.listen(PORT, () => {
  console.log(`PURIMATA Bot V2 running on port ${PORT}`);
});
