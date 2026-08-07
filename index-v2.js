"use strict";

const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// PURIMATA Bot V2 - Health Check
app.get("/", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "PURIMATA Bot V2",
    version: "2.1A"
  });
});

app.listen(PORT, () => {
  console.log(`PURIMATA Bot V2 running on port ${PORT}`);
});
