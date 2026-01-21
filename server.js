const express = require("express");
const mongoose = require("mongoose");
require("dotenv").config();

const app = express();

// Middleware kung meron ka (JSON body, CORS, etc.)
app.use(express.json());

// Connect to MongoDB
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    console.log("✅ MongoDB Connected");
  })
  .catch((err) => {
    console.error("❌ MongoDB Error:", err);
  });

// Health endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "Backend is running",
    timestamp: new Date().toISOString(),
    version: "1.0.0",
  });
});

// Port for Render + local
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});
