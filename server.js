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

// ===== ANOMALY RULES (UPDATED: ML-derived thresholds + fan rules) =====
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
    mode,
    createdAt,
  } = reading;

  const readingTime = createdAt || new Date();
  const hid = houseId || "house-1";
  const modeStr = (mode || "AUTO").toString().trim().toUpperCase();

  // ----------------- ENVIRONMENTAL RULES -----------------


function generateAlertsFromReading(reading) {
  const alerts = [];
  const {
    temperature,
    humidity,
    ammonia,
    methane,
    fanIntakeRpm,
    fanExhaustRpm,
    fanIntakeDuty,
    fanExhaustDuty,
    mode,
    houseId,
    createdAt,
  } = reading;

  const readingTime = createdAt || new Date();
  const hid = houseId || "house-1";
  const modeStr = (mode || "AUTO").toString().trim().toUpperCase();
  const isForceOff = modeStr === "FORCE_OFF";

  // Data Normalization (Numbers)
  const t = Number(temperature);
  const h = Number(humidity);
  const a = Number(ammonia);
  const m = Number(methane);
  const fiDuty = Number(fanIntakeDuty) || 0;
  const fiRpm = Number(fanIntakeRpm) || 0;
  const feDuty = Number(fanExhaustDuty) || 0;
  const feRpm = Number(fanExhaustRpm) || 0;

  // ============================================================
  // 1. FAULT DETECTION (Priority 1 - Class 3)
  // ============================================================
  const intakeStall = !isForceOff && fiDuty > 0 && fiRpm <= 0;
  const exhaustStall = !isForceOff && feDuty > 0 && feRpm <= 0;
  const tempSensorFault = (t === 0); // Imposibleng 0°C sa PH farm, likely sira ang DHT22

  if (intakeStall || exhaustStall || tempSensorFault) {
    let faultMsg = "Hardware Fault: ";
    if (intakeStall) faultMsg += "Intake Fan Stall. ";
    if (exhaustStall) faultMsg += "Exhaust Fan Stall. ";
    if (tempSensorFault) faultMsg += "Temp Sensor Error (0°C). ";

    alerts.push({
      houseId: hid,
      type: "fault", // Class 3
      category: "mechanical",
      severity: "high",
      message: faultMsg.trim(),
      source: "ml-derived-rules",
      createdAt: readingTime,
    });
  }

  // ============================================================
  // 2. CRITICAL CONDITIONS (Priority 2 - Class 2)
  // ============================================================
  // Note: t > 0 para hindi mag-overlap sa Fault logic
  const tempCritical = (t > 0 && t < 30) || t > 37;
  const humCritical = h < 55 || h > 80;
  const nh3Critical = a > 20;
  const ch4Critical = m > 8;

  if (tempCritical || humCritical || nh3Critical || ch4Critical) {
    let critMsg = "Critical Condition: ";
    if (tempCritical) critMsg += `Extreme Temp (${t.toFixed(1)}°C). `;
    if (humCritical) critMsg += `Extreme Hum (${h.toFixed(1)}%). `;
    if (nh3Critical) critMsg += `High Ammonia (${a.toFixed(1)}ppm). `;
    if (ch4Critical) critMsg += `High Methane (${m.toFixed(1)}ppm). `;

    alerts.push({
      houseId: hid,
      type: "critical", // Class 2
      category: "environment",
      severity: "high",
      message: critMsg.trim(),
      source: "ml-derived-rules",
      createdAt: readingTime,
    });
  }

  // ============================================================
  // 3. WARNING CONDITIONS (Priority 3 - Class 1)
  // ============================================================
  const tempWarning = !tempCritical && t !== 0 && ((t >= 30 && t < 32) || (t > 35 && t <= 37));
  const humWarning = !humCritical && ((h >= 55 && h < 60) || (h > 70 && h <= 80));
  const nh3Warning = !nh3Critical && (a > 10 && a <= 20);
  const ch4Warning = !ch4Critical && (m > 4 && m <= 8);
  const fanDegraded = !isForceOff && ((fiDuty >= 30 && fiRpm > 0 && fiRpm < 1500) || (feDuty >= 30 && feRpm > 0 && feRpm < 1500));

  if (tempWarning || humWarning || nh3Warning || ch4Warning || fanDegraded) {
    let warnMsg = "Warning: ";
    if (tempWarning) warnMsg += "Temp unstable. ";
    if (humWarning) warnMsg += "Hum unstable. ";
    if (nh3Warning || ch4Warning) warnMsg += "Gas levels rising. ";
    if (fanDegraded) warnMsg += "Low fan RPM. ";

    alerts.push({
      houseId: hid,
      type: "warning", // Class 1
      category: fanDegraded ? "mechanical" : "environment",
      severity: "medium",
      message: warnMsg.trim(),
      source: "ml-derived-rules",
      createdAt: readingTime,
    });
  }

  // NOTE: Walang alert record para sa Normal (Class 0) para tipid sa database.
  return alerts;
}

// ===== API ENDPOINTS =====

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "Backend is running",
    timestamp: new Date().toISOString(),
    version: "2.5.0-ml-threshold-rules",
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

// 7️⃣ POST /api/light-status — Light MCU sends ONLY light/washer status
app.post("/api/light-status", async (req, res) => {
  try {
    const { light, lightStatus, pressureWasherStatus } = req.body;

    const latestSensor = await SensorData.findOne().sort({ createdAt: -1 });

    if (latestSensor) {
      if (light != null && light >= 0) latestSensor.light = light;
      if (lightStatus) latestSensor.lightStatus = lightStatus;
      if (pressureWasherStatus)
        latestSensor.pressureWasherStatus = pressureWasherStatus;
      await latestSensor.save();
    } else {
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
  console.log(`🔒 Rate limiting: 100 requests/minute`);
});
