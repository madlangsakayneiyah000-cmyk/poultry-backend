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

// ===== Sensor & Control API (final basic version) =====

// Temporary storage ng latest sensor reading
let latestSensorData = null;

// Temporary control state for actuators
const controlState = {
  fanIntake: "OFF",
  fanExhaust: "OFF",
  light: "OFF",
  pressureWasher: "OFF",
  mode: "AUTO", // or "MANUAL"
};

// Save sensor data (POST)
// Body JSON format (final basic fields):
// {
//   "houseId": "house-1",
//   "temperature": 29.5,
//   "humidity": 65.0,
//   "ammonia": 3.2,
//   "methane": 1.1,
//   "light": 250.0,
//   "fanIntakeRpm": 1200,
//   "fanExhaustRpm": 1300,
//   "fanIntakeDuty": 60,
//   "fanExhaustDuty": 55,
//   "lightStatus": "ON",
//   "pressureWasherStatus": "OFF",
//   "mode": "AUTO"
// }
app.post("/api/sensors", (req, res) => {
  const {
    houseId,
    temperature,
    humidity,
    ammonia,
    methane,
    light,
    fanIntakeRpm,
    fanExhaustRpm,
    fanIntakeDuty,
    fanExhaustDuty,
    lightStatus,
    pressureWasherStatus,
    mode,
  } = req.body;

  latestSensorData = {
    houseId,
    temperature,
    humidity,
    ammonia,
    methane,
    light,
    fanIntakeRpm,
    fanExhaustRpm,
    fanIntakeDuty,
    fanExhaustDuty,
    lightStatus,
    pressureWasherStatus,
    mode,
    createdAt: new Date().toISOString(),
  };

  return res.status(201).json({
    message: "Sensor data saved (in memory)",
    data: latestSensorData,
  });
});

// Get latest sensor data (GET)
app.get("/api/sensors/latest", (req, res) => {
  if (!latestSensorData) {
    return res.status(404).json({ message: "No sensor data yet" });
  }

  return res.json(latestSensorData);
});

// Get current control state (para sa frontend + ESP32)
app.get("/api/control/state", (req, res) => {
  return res.json(controlState);
});

// Update control state (fan/light/pressure washer/mode)
app.post("/api/control", (req, res) => {
  const { target, state } = req.body;
  // target: "fanIntake" | "fanExhaust" | "light" | "pressureWasher" | "mode"
  // state: "ON" | "OFF" | "AUTO" | "MANUAL"

  if (
    !["fanIntake", "fanExhaust", "light", "pressureWasher", "mode"].includes(
      target
    )
  ) {
    return res.status(400).json({ error: "Invalid target" });
  }

  if (target === "mode") {
    if (!["AUTO", "MANUAL"].includes(state)) {
      return res.status(400).json({ error: "Invalid mode" });
    }
    controlState.mode = state;
  } else {
    if (!["ON", "OFF"].includes(state)) {
      return res.status(400).json({ error: "Invalid state" });
    }
    controlState[target] = state;
  }

  return res.json({
    message: `Set ${target} to ${state}`,
    controlState,
  });
});


app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});
