const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
require("dotenv").config();

const app = express();

// ===== MIDDLEWARE =====
app.use(cors()); // Allow frontend to connect
app.use(express.json()); // Parse JSON body

// ===== MONGODB CONNECTION =====
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    console.log("✅ MongoDB Connected");
  })
  .catch((err) => {
    console.error("❌ MongoDB Error:", err);
  });

// ===== MONGODB SCHEMAS =====

// Sensor Data Schema (historical storage)
const sensorSchema = new mongoose.Schema({
  houseId: { type: String, default: "house-1" },
  temperature: { type: Number, required: true },
  humidity: { type: Number, required: true },
  ammonia: { type: Number, required: true },
  methane: { type: Number, required: true },
  light: { type: Number, default: 0 },
  fanIntakeRpm: { type: Number, default: 0 },
  fanExhaustRpm: { type: Number, default: 0 },
  fanIntakeDuty: { type: Number, default: 0 },
  fanExhaustDuty: { type: Number, default: 0 },
  lightStatus: { type: String, default: "OFF" },
  pressureWasherStatus: { type: String, default: "OFF" },
  mode: { type: String, default: "AUTO" },
  createdAt: { type: Date, default: Date.now },
});

const SensorData = mongoose.model("SensorData", sensorSchema);

// Control State Schema (latest actuator states)
const controlSchema = new mongoose.Schema({
  fanIntake: { type: String, default: "OFF" },
  fanExhaust: { type: String, default: "OFF" },
  light: { type: String, default: "OFF" },
  pressureWasher: { type: String, default: "OFF" },
  mode: { type: String, default: "AUTO" },
  updatedAt: { type: Date, default: Date.now },
});

const ControlState = mongoose.model("ControlState", controlSchema);

// ===== HELPER: Get or Create Control State =====
async function getControlState() {
  let control = await ControlState.findOne();
  if (!control) {
    control = await ControlState.create({
      fanIntake: "OFF",
      fanExhaust: "OFF",
      light: "OFF",
      pressureWasher: "OFF",
      mode: "AUTO",
    });
  }
  return control;
}

// ===== API ENDPOINTS =====

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "Backend is running",
    timestamp: new Date().toISOString(),
    version: "2.0.0",
  });
});

// 1️⃣ POST /api/sensors - ESP32 sends sensor data here
app.post("/api/sensors", async (req, res) => {
  try {
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

    // Validate required fields
    if (
      temperature === undefined ||
      humidity === undefined ||
      ammonia === undefined ||
      methane === undefined
    ) {
      return res.status(400).json({
        error: "Missing required fields: temperature, humidity, ammonia, methane",
      });
    }

    // Save to MongoDB
    const sensorData = await SensorData.create({
      houseId: houseId || "house-1",
      temperature,
      humidity,
      ammonia,
      methane,
      light: light || 0,
      fanIntakeRpm: fanIntakeRpm || 0,
      fanExhaustRpm: fanExhaustRpm || 0,
      fanIntakeDuty: fanIntakeDuty || 0,
      fanExhaustDuty: fanExhaustDuty || 0,
      lightStatus: lightStatus || "OFF",
      pressureWasherStatus: pressureWasherStatus || "OFF",
      mode: mode || "AUTO",
    });

    return res.status(201).json({
      success: true,
      message: "Sensor data saved",
      data: sensorData,
    });
  } catch (err) {
    console.error("Error saving sensor data:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// 2️⃣ GET /api/sensors/latest - Frontend gets latest sensor reading
app.get("/api/sensors/latest", async (req, res) => {
  try {
    const latestSensor = await SensorData.findOne().sort({ createdAt: -1 });

    if (!latestSensor) {
      return res.status(404).json({ message: "No sensor data yet" });
    }

    return res.json(latestSensor);
  } catch (err) {
    console.error("Error fetching latest sensor:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// 3️⃣ GET /api/sensors/history - Frontend gets data for charts
app.get("/api/sensors/history", async (req, res) => {
  try {
    const { limit = 24 } = req.query;

    const history = await SensorData.find()
      .sort({ createdAt: -1 })
      .limit(parseInt(limit));

    return res.json(history.reverse()); // Oldest to newest for chart
  } catch (err) {
    console.error("Error fetching sensor history:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// 4️⃣ GET /api/control/state - ESP32 & Frontend get current control state
app.get("/api/control/state", async (req, res) => {
  try {
    const control = await getControlState();
    return res.json(control);
  } catch (err) {
    console.error("Error fetching control state:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// 5️⃣ POST /api/control - Frontend sends control commands
app.post("/api/control", async (req, res) => {
  try {
    const { target, state } = req.body;

    // Validate target
    const validTargets = ["fanIntake", "fanExhaust", "light", "pressureWasher", "mode"];
    if (!validTargets.includes(target)) {
      return res.status(400).json({ error: "Invalid target" });
    }

    // Validate state
    if (target === "mode") {
      if (!["AUTO", "MANUAL"].includes(state)) {
        return res.status(400).json({ error: "Invalid mode (must be AUTO or MANUAL)" });
      }
    } else {
      if (!["ON", "OFF"].includes(state)) {
        return res.status(400).json({ error: "Invalid state (must be ON or OFF)" });
      }
    }

    // Update control state in MongoDB
    const control = await getControlState();
    control[target] = state;
    control.updatedAt = new Date();
    await control.save();

    return res.json({
      success: true,
      message: `Set ${target} to ${state}`,
      controlState: control,
    });
  } catch (err) {
    console.error("Error updating control state:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ===== START SERVER =====
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});
