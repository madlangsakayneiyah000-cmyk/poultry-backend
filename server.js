const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const NodeCache = require("node-cache");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

const app = express();

// ===== CACHING SETUP =====
const cache = new NodeCache({
  stdTTL: 5,
  checkperiod: 10,
  useClones: false,
});

// ===== MIDDLEWARE =====
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "*",
    methods: ["GET", "POST"],
    credentials: true,
  })
);

app.use(express.json({ limit: "10kb" }));

// ===== REQUEST RATE LIMITING =====
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 100,
  message: "Too many requests, please try again later",
});
app.use("/api", limiter);

// ===== MONGODB CONNECTION =====
mongoose
  .connect(process.env.MONGODB_URI, {
    maxPoolSize: 10,
    minPoolSize: 2,
    socketTimeoutMS: 45000,
    serverSelectionTimeoutMS: 10000,
  })
  .then(() => {
    console.log("✅ MongoDB Connected with connection pooling");
    createIndexes();
  })
  .catch((err) => {
    console.error("❌ MongoDB Error:", err);
    process.exit(1);
  });

// ===== MONGODB SCHEMAS =====

// Sensor Data Schema (historical storage)
const sensorSchema = new mongoose.Schema({
  houseId: { type: String, default: "house-1", index: true },
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
  createdAt: { type: Date, default: Date.now, index: true },
});

sensorSchema.index({ houseId: 1, createdAt: -1 });

const SensorData = mongoose.model("SensorData", sensorSchema);

// ==== CONTROL SCHEMA (TWO-WAY) ====
const controlSchema = new mongoose.Schema({
  light: {
    mode: {
      type: String,
      default: "AUTO",
      enum: ["AUTO", "FORCE_ON", "FORCE_OFF"],
    },
    state: {
      type: String,
      default: "OFF",
      enum: ["ON", "OFF"],
    },
  },
  fan_positive: {
    mode: {
      type: String,
      default: "AUTO",
      enum: ["AUTO", "FORCE_ON", "FORCE_OFF"],
    },
    state: {
      type: String,
      default: "OFF",
      enum: ["ON", "OFF"],
    },
  },
  fan_negative: {
    mode: {
      type: String,
      default: "AUTO",
      enum: ["AUTO", "FORCE_ON", "FORCE_OFF"],
    },
    state: {
      type: String,
      default: "OFF",
      enum: ["ON", "OFF"],
    },
  },
  pressure_washer: {
    mode: {
      type: String,
      default: "FORCE_OFF",
      enum: ["FORCE_ON", "FORCE_OFF"],
    },
    state: {
      type: String,
      default: "OFF",
      enum: ["ON", "OFF"],
    },
    timerDuration: { type: Number, default: 0 },
    timerStartedAt: { type: Date, default: null },
    timerExpiresAt: { type: Date, default: null },
  },
  fanIntake: { type: String, default: "OFF" },
  fanExhaust: { type: String, default: "OFF" },
  mode: { type: String, default: "AUTO" },
  updatedAt: { type: Date, default: Date.now },
});

const ControlState = mongoose.model("ControlState", controlSchema);

// ===== CREATE INDEXES FUNCTION =====
async function createIndexes() {
  try {
    await SensorData.collection.createIndex({ houseId: 1, createdAt: -1 });
    await SensorData.collection.createIndex({ createdAt: -1 });
    console.log("✅ MongoDB indexes created successfully");
  } catch (err) {
    console.error("⚠️ Index creation warning:", err.message);
  }
}

// ===== HELPER: Get or Create Control State =====
async function getControlState() {
  const cacheKey = "control_state";
  let control = await ControlState.findOne();

  if (!control) {
    control = await ControlState.create({
      light: { mode: "AUTO", state: "OFF" },
      fan_positive: { mode: "AUTO", state: "OFF" },
      fan_negative: { mode: "AUTO", state: "OFF" },
      pressure_washer: {
        mode: "FORCE_OFF",
        state: "OFF",
        timerDuration: 0,
        timerStartedAt: null,
        timerExpiresAt: null,
      },
      fanIntake: "OFF",
      fanExhaust: "OFF",
      mode: "AUTO",
    });
  } else {
    if (typeof control.light === "string") {
      console.log("🔧 Found legacy control doc, resetting it...");
      await ControlState.deleteMany({});

      control = await ControlState.create({
        light: { mode: "AUTO", state: "OFF" },
        fan_positive: { mode: "AUTO", state: "OFF" },
        fan_negative: { mode: "AUTO", state: "OFF" },
        pressure_washer: {
          mode: "FORCE_OFF",
          state: "OFF",
          timerDuration: 0,
          timerStartedAt: null,
          timerExpiresAt: null,
        },
        fanIntake: "OFF",
        fanExhaust: "OFF",
        mode: "AUTO",
      });

      console.log("🔧 Control state reset to new schema");
    }
  }

  cache.set(cacheKey, control);
  return control;
}

// ===== API ENDPOINTS =====

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "Backend is running",
    timestamp: new Date().toISOString(),
    version: "2.3.0-with-restore",
    cache: {
      keys: cache.keys().length,
      stats: cache.getStats(),
    },
  });
});

// 1️⃣ POST /api/sensors - ESP32 sends sensor data
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

    if (
      temperature === undefined ||
      humidity === undefined ||
      ammonia === undefined ||
      methane === undefined
    ) {
      return res.status(400).json({
        error:
          "Missing required fields: temperature, humidity, ammonia, methane",
      });
    }

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

    cache.del("latest_sensor");
    cache.del("sensor_history");

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

// 2️⃣ GET /api/sensors/latest
app.get("/api/sensors/latest", async (req, res) => {
  try {
    const cacheKey = "latest_sensor";
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const latestSensor = await SensorData.findOne()
      .sort({ createdAt: -1 })
      .select("-__v")
      .lean();

    if (!latestSensor) {
      return res.status(404).json({ message: "No sensor data yet" });
    }

    cache.set(cacheKey, latestSensor);
    return res.json(latestSensor);
  } catch (err) {
    console.error("Error fetching latest sensor:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// 3️⃣ GET /api/sensors/history
app.get("/api/sensors/history", async (req, res) => {
  try {
    const { limit = 24, houseId = "house-1" } = req.query;
    const parsedLimit = Math.min(parseInt(limit), 100);

    const cacheKey = `sensor_history_${houseId}_${parsedLimit}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const history = await SensorData.find({ houseId })
      .sort({ createdAt: -1 })
      .limit(parsedLimit)
      .select("temperature humidity ammonia methane light createdAt -_id")
      .lean();

    const reversed = history.reverse();
    cache.set(cacheKey, reversed);

    return res.json(reversed);
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

// 5️⃣ POST /api/control - Dashboard sends TWO-WAY control commands
app.post("/api/control", async (req, res) => {
  try {
    const { device, mode, timerDuration } = req.body;

    let targetDevices = [];

    if (device === "fan") {
      targetDevices = ["fan_positive", "fan_negative"];
    } else if (
      device === "light" ||
      device === "fan_positive" ||
      device === "fan_negative" ||
      device === "pressure_washer"
    ) {
      targetDevices = [device];
    } else {
      return res.status(400).json({
        error:
          'Invalid device. Must be one of: "light", "fan", "fan_positive", "fan_negative", "pressure_washer"',
      });
    }

    const validModes = ["AUTO", "FORCE_ON", "FORCE_OFF"];
    if (!validModes.includes(mode)) {
      return res.status(400).json({
        error: `Invalid mode. Must be one of: ${validModes.join(", ")}`,
      });
    }

    if (targetDevices.includes("pressure_washer") && mode === "AUTO") {
      return res.status(400).json({
        error:
          "Pressure washer does not support AUTO mode. Use FORCE_ON or FORCE_OFF.",
      });
    }

    const control = await getControlState();

    for (const dev of targetDevices) {
      control[dev].mode = mode;

      if (mode === "FORCE_ON") {
        control[dev].state = "ON";
      } else if (mode === "FORCE_OFF") {
        control[dev].state = "OFF";
      }
    }

    if (targetDevices.includes("pressure_washer")) {
      if (mode === "FORCE_ON") {
        const duration = parseInt(timerDuration, 10) || 300;
        const now = new Date();
        const expires = new Date(now.getTime() + duration * 1000);

        control.pressure_washer.timerDuration = duration;
        control.pressure_washer.timerStartedAt = now;
        control.pressure_washer.timerExpiresAt = expires;

        console.log(
          `🚿 Pressure washer ON — auto-OFF in ${duration}s at ${expires.toISOString()}`
        );
      } else if (mode === "FORCE_OFF") {
        control.pressure_washer.timerDuration = 0;
        control.pressure_washer.timerStartedAt = null;
        control.pressure_washer.timerExpiresAt = null;
        console.log("🚿 Pressure washer manually turned OFF");
      }
    }

    control.updatedAt = new Date();
    await control.save();

    cache.del("control_state");

    return res.json({
      success: true,
      message: `${device} set to ${mode}`,
      controlState: control,
    });
  } catch (err) {
    console.error("Error updating control state:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// 🔄 NEW: POST /api/control/restore - Manual restore from DB to ESP32
app.post("/api/control/restore", async (req, res) => {
  try {
    const control = await getControlState();

    const commands = [];

    // Light
    if (control.light) {
      commands.push({
        device: "light",
        mode: control.light.mode,
        state: control.light.state,
      });
    }

    // Unified Fan (both positive + negative)
    if (control.fan_positive) {
      commands.push({
        device: "fan",
        mode: control.fan_positive.mode,
        state: control.fan_positive.state,
      });
    }

    // Pressure Washer
    if (control.pressure_washer) {
      commands.push({
        device: "pressure_washer",
        mode: control.pressure_washer.mode,
        state: control.pressure_washer.state,
      });
    }

    // TODO: Publish via MQTT
    // Example: mqttClient.publish('poultry/control', JSON.stringify(cmd))
    // You need to add MQTT client setup (see installation instructions below)

    console.log("🔄 Restore commands prepared:", commands);

    return res.json({
      success: true,
      message: "Control state restored (commands prepared for ESP32)",
      restored: {
        light: control.light,
        fan: control.fan_positive,
        washer: control.pressure_washer,
      },
      commands,
    });
  } catch (err) {
    console.error("Restore error:", err);
    return res.status(500).json({ error: "Failed to restore state" });
  }
});

// ===== PRESSURE WASHER SAFETY TIMER (background) =====
setInterval(async () => {
  try {
    const control = await ControlState.findOne();
    if (!control) return;

    const pw = control.pressure_washer;
    if (pw.state === "ON" && pw.timerExpiresAt) {
      const now = new Date();
      if (now >= pw.timerExpiresAt) {
        pw.state = "OFF";
        pw.mode = "FORCE_OFF";
        pw.timerDuration = 0;
        pw.timerStartedAt = null;
        pw.timerExpiresAt = null;

        control.updatedAt = new Date();
        await control.save();

        cache.del("control_state");
        console.log("🚿⏱️ Pressure washer AUTO-OFF: timer expired!");
      }
    }
  } catch (err) {
    console.error("⚠️ Pressure washer timer check error:", err.message);
  }
}, 10000);

// ===== TEMP: RESET CONTROL STATE (MIGRATION) =====
app.post("/admin/reset-control", async (req, res) => {
  try {
    await ControlState.deleteMany({});

    const control = await ControlState.create({
      light: { mode: "AUTO", state: "OFF" },
      fan_positive: { mode: "AUTO", state: "OFF" },
      fan_negative: { mode: "AUTO", state: "OFF" },
      pressure_washer: {
        mode: "FORCE_OFF",
        state: "OFF",
        timerDuration: 0,
        timerStartedAt: null,
        timerExpiresAt: null,
      },
      fanIntake: "OFF",
      fanExhaust: "OFF",
      mode: "AUTO",
    });

    cache.del("control_state");

    return res.json({
      success: true,
      message: "Control state reset",
      control,
    });
  } catch (err) {
    console.error("Reset control error:", err);
    return res.status(500).json({ error: "Reset failed" });
  }
});

// ===== GRACEFUL SHUTDOWN =====
process.on("SIGINT", async () => {
  console.log("\n⚠️ Shutting down gracefully...");
  await mongoose.connection.close();
  cache.flushAll();
  console.log("✅ MongoDB connection closed");
  process.exit(0);
});

// ===== START SERVER =====
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
  console.log(`📊 Caching enabled with 5-second TTL`);
  console.log(`🔒 Rate limiting: 100 requests/minute`);
});
