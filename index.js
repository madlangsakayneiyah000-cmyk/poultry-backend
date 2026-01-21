const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

// Health check
app.get("/", (req, res) => {
  res.json({
    status: "Backend is running",
    time: new Date(),
  });
});

// Example control endpoint
app.post("/api/control", (req, res) => {
  const { device, state } = req.body;

  console.log("Control command:", device, state);

  res.json({
    success: true,
    message: `${device} set to ${state}`,
  });
});

// Example sensor data endpoint
app.post("/api/sensor", (req, res) => {
  console.log("Sensor data received:", req.body);

  res.json({
    success: true,
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
