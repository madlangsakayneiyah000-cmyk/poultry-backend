const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const NodeCache = require("node-cache");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

const app = express();
app.set("trust proxy", 1); // IMPORTANT for Render/proxy + express-rate-limit

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
  windowMs: 60 * 1000, // 1 minute
  max: 300, // mas mataas para kayanin 2 MCU + dashboard
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

// Control schema (two-way)
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

// Alert Schema (for early warning / ML-derived anomalies)
const alertSchema = new mongoose.Schema(
  {
    houseId: { type: String, default: "house-1", index: true },
    type: {
      type: String,
      enum: ["info", "warning", "critical"],
      required: true,
    },
    category: {
      type: String,
      enum: ["environment", "mechanical"],
      required: true,
    },
    message: { type: String, required: true },
    severity: {
      type: String,
      enum: ["low", "medium", "high"],
      required: true,
    },
    source: {
      type: String,
      default: "ml-derived-rules",
    },
  },
  { timestamps: true }
);
const Alert = mongoose.model("Alert", alertSchema);

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

// ===== HELPER: Get or Create Control State (write version) =====
async function getControlState() {
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
  } else if (typeof control.light === "string") {
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

  cache.set("control_state", control);
  return control;
}

// Read-only version for ESP32 polling (lean + cache)
async function getControlStateForRead() {
  const cacheKey = "control_state_read";
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const control = await ControlState.findOne().lean();
  if (control) cache.set(cacheKey, control);
  return control;
}

// ===== ANOMALY RULES (rule-based, from offline ML thresholds) =====
function generateAlertsFromReading(reading) {
  const alerts = [];

  const {
    houseId,
    temperature,
    humidity,
    ammonia,
    methane,
    fanIntakeRpm,
    fanExhaustRpm,
    fanIntakeDuty,
    fanExhaustDuty,
    createdAt,
  } = reading;

  const readingTime = createdAt || new Date();
  const hid = houseId || "house-1";

  // Temperature (you can tweak these using your offline ML results)
  if (temperature < 27 || temperature > 36) {
    alerts.push({
      houseId: hid,
      type: "critical",
      category: "environment",
      severity: "high",
      message: `Critical temperature condition detected (${temperature.toFixed(
        1
      )} °C).`,
      source: "ml-derived-rules",
      createdAt: readingTime,
    });
  } else if (temperature < 29 || temperature > 34) {
    alerts.push({
      houseId: hid,
      type: "warning",
      category: "environment",
      severity: "medium",
      message: `Temperature approaching unsafe range (${temperature.toFixed(
        1
      )} °C).`,
      source: "ml-derived-rules",
      createdAt: readingTime,
    });
  }

  // Humidity
  if (humidity < 40 || humidity > 80) {
    alerts.push({
      houseId: hid,
      type: "critical",
      category: "environment",
      severity: "high",
      message: `Critical humidity condition detected (${humidity.toFixed(
        1
      )} %).`,
      source: "ml-derived-rules",
      createdAt: readingTime,
    });
  } else if (humidity < 45 || humidity > 75) {
    alerts.push({
      houseId: hid,
      type: "warning",
      category: "environment",
      severity: "medium",
      message: `Humidity approaching unsafe range (${humidity.toFixed(
        1
      )} %).`,
      source: "ml-derived-rules",
      createdAt: readingTime,
    });
  }

  // Ammonia
  if (ammonia >= 25) {
    alerts.push({
      houseId: hid,
      type: "critical",
      category: "environment",
      severity: "high",
      message: `Ammonia levels in dangerous range (${ammonia.toFixed(
        1
      )} ppm).`,
      source: "ml-derived-rules",
      createdAt: readingTime,
    });
  } else if (ammonia >= 15) {
    alerts.push({
      houseId: hid,
      type: "warning",
      category: "environment",
      severity: "medium",
      message: `Ammonia levels approaching unsafe range (${ammonia.toFixed(
        1
      )} ppm).`,
      source: "ml-derived-rules",
      createdAt: readingTime,
    });
  }

  // Methane
  if (methane > 10) {
    alerts.push({
      houseId: hid,
      type: "critical",
      category: "environment",
      severity: "high",
      message: `Methane levels detected above safe range (${methane.toFixed(
        1
      )} ppm).`,
      source: "ml-derived-rules",
      createdAt: readingTime,
    });
  } else if (methane > 5) {
    alerts.push({
      houseId: hid,
      type: "warning",
      category: "environment",
      severity: "medium",
      message: `Methane levels rising above normal (${methane.toFixed(
        1
      )} ppm).`,
      source: "ml-derived-rules",
      createdAt: readingTime,
    });
  }

  // Fan mechanical faults (ONLY if duty > 0)
  const fanIntakeDutyOn = fanIntakeDuty && fanIntakeDuty > 0;
  const fanExhaustDutyOn = fanExhaustDuty && fanExhaustDuty > 0;

  if (fanIntakeDutyOn && (!fanIntakeRpm || fanIntakeRpm < 100)) {
    alerts.push({
      houseId: hid,
      type: "critical",
      category: "mechanical",
      severity: "high",
      message: `Possible intake fan fault: duty ${fanIntakeDuty}% but RPM ${fanIntakeRpm}.`,
      source: "ml-derived-rules",
      createdAt: readingTime,
    });
  }

  if (fanExhaustDutyOn && (!fanExhaustRpm || fanExhaustRpm < 100)) {
    alerts.push({
      houseId: hid,
      type: "critical",
      category: "mechanical",
      severity: "high",
      message: `Possible exhaust fan fault: duty ${fanExhaustDuty}% but RPM ${fanExhaustRpm}.`,
      source: "ml-derived-rules",
      createdAt: readingTime,
    });
  }

  return alerts;
}

// ===== API ENDPOINTS =====

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "Backend is running",
    timestamp: new Date().toISOString(),
    version: "2.6.0-concurrency-safe",
    cache: {
      keys: cache.keys().length,
      stats: cache.getStats(),
    },
  });
});

// 1️⃣ POST /api/sensors - ESP32 Fan MCU sends full sensor data
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

    const alertsToCreate = generateAlertsFromReading(sensorData);
    if (alertsToCreate.length > 0) {
      await Alert.insertMany(alertsToCreate);
    }

    cache.del("latest_sensor");
    cache.del("sensor_history");

    return res.status(201).json({
      success: true,
      message: "Sensor data saved",
      data: sensorData,
      alertsCreated: alertsToCreate.length,
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
    const control = await getControlStateForRead();
    return res.json(control);
  } catch (err) {
    console.error("Error fetching control state:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// 5️⃣ POST /api/control - Dashboard sends TWO-WAY control commands (atomic)
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

    const updateObj = {};

    // Per-device fields to update
    for (const dev of targetDevices) {
      updateObj[`${dev}.mode`] = mode;

      if (mode === "FORCE_ON") {
        updateObj[`${dev}.state`] = "ON";
      } else if (mode === "FORCE_OFF") {
        updateObj[`${dev}.state`] = "OFF";
      }
    }

    // Pressure washer timer handling
    if (targetDevices.includes("pressure_washer")) {
      if (mode === "FORCE_ON") {
        const duration = parseInt(timerDuration, 10) || 300;
        const now = new Date();
        const expires = new Date(now.getTime() + duration * 1000);

        updateObj["pressure_washer.timerDuration"] = duration;
        updateObj["pressure_washer.timerStartedAt"] = now;
        updateObj["pressure_washer.timerExpiresAt"] = expires;

        console.log(
          `🚿 Pressure washer ON — auto-OFF in ${duration}s at ${expires.toISOString()}`
        );
      } else if (mode === "FORCE_OFF") {
        updateObj["pressure_washer.timerDuration"] = 0;
        updateObj["pressure_washer.timerStartedAt"] = null;
        updateObj["pressure_washer.timerExpiresAt"] = null;
        console.log("🚿 Pressure washer manually turned OFF");
      }
    }

    updateObj.updatedAt = new Date();

    const control = await ControlState.findOneAndUpdate(
      {},
      { $set: updateObj },
      { new: true, upsert: true }
    );

    cache.del("control_state");
    cache.del("control_state_read");

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

// 6️⃣ GET /api/alerts - Dashboard early warning alerts
app.get("/api/alerts", async (req, res) => {
  try {
    const { limit = 20 } = req.query;

    const alerts = await Alert.find({})
      .sort({ createdAt: -1 })
      .limit(Number(limit))
      .lean();

    return res.json({ success: true, alerts });
  } catch (err) {
    console.error("Error fetching alerts:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// 7️⃣ POST /api/light-status — Light MCU sends ONLY light/washer status (atomic)
app.post("/api/light-status", async (req, res) => {
  try {
    const { light, lightStatus, pressureWasherStatus } = req.body;

    const updateFields = {};
    if (light != null && light >= 0) updateFields.light = light;
    if (lightStatus) updateFields.lightStatus = lightStatus;
    if (pressureWasherStatus) updateFields.pressureWasherStatus =
      pressureWasherStatus;

    const latestUpdated = await SensorData.findOneAndUpdate(
      {},
      { $set: updateFields },
      {
        sort: { createdAt: -1 },
        new: true,
      }
    );

    if (!latestUpdated) {
      await SensorData.create({
        houseId: "house-1",
        temperature: 0,
        humidity: 0,
        ammonia: 0,
        methane: 0,
        light: light || 0,
        lightStatus: lightStatus || "OFF",
        pressureWasherStatus: pressureWasherStatus || "OFF",
        fanIntakeRpm: 0,
        fanExhaustRpm: 0,
        fanIntakeDuty: 0,
        fanExhaustDuty: 0,
        mode: "AUTO",
      });
    }

    cache.del("latest_sensor");
    cache.del("sensor_history");

    return res.json({
      success: true,
      message: "Light/washer status updated from Light MCU",
    });
  } catch (err) {
    console.error("Error in /api/light-status:", err);
    return res.status(500).json({ error: "Server error" });
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
        cache.del("control_state_read");
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
    cache.del("control_state_read");

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
  console.log(`🔒 Rate limiting: 300 requests/minute`);
});
