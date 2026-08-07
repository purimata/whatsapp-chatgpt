"use strict";

const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

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

    console.log("WhatsApp inbound message:", {
      messageId,
      from,
      type
    });

    return res.sendStatus(200);
  } catch (error) {
    console.error("Inbound webhook error:", error);
    return res.sendStatus(200);
  }
});

app.listen(PORT, () => {
  console.log(`PURIMATA Bot V2 running on port ${PORT}`);
});
