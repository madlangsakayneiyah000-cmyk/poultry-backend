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

const controlSchema = new mongoose.Schema({
  light: {
    mode: { type: String, default: "AUTO", enum: ["AUTO", "FORCE_ON", "FORCE_OFF"] },
    state: { type: String, default: "OFF", enum: ["ON", "OFF"] },
  },
  fan_positive: {
    mode: { type: String, default: "AUTO", enum: ["AUTO", "FORCE_ON", "FORCE_OFF"] },
    state: { type: String, default: "OFF", enum: ["ON", "OFF"] },
  },
  fan_negative: {
    mode: { type: String, default: "AUTO", enum: ["AUTO", "FORCE_ON", "FORCE_OFF"] },
    state: { type: String, default: "OFF", enum: ["ON", "OFF"] },
  },
  pressure_washer: {
    mode: { type: String, default: "FORCE_OFF", enum: ["FORCE_ON", "FORCE_OFF"] },
    state: { type: String, default: "OFF", enum: ["ON", "OFF"] },
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

const alertSchema = new mongoose.Schema(
  {
    houseId: { type: String, default: "house-1", index: true },
    type: { type: String, enum: ["info", "warning", "critical"], required: true },
    category: { type: String, enum: ["environment", "mechanical"], required: true },
    message: { type: String, required: true },
    severity: { type: String, enum: ["low", "medium", "high"], required: true },
    source: { type: String, default: "ml-derived-rules" },
  },
  { timestamps: true }
);

const Alert = mongoose.model("Alert", alertSchema);

// ===== CREATE INDEXES =====
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
      pressure_washer: { mode: "FORCE_OFF", state: "OFF", timerDuration: 0, timerStartedAt: null, timerExpiresAt: null },
      fanIntake: "OFF", fanExhaust: "OFF", mode: "AUTO",
    });
  } else {
    if (typeof control.light === "string") {
      console.log("🔧 Found legacy control doc, resetting...");
      await ControlState.deleteMany({});
      control = await ControlState.create({
        light: { mode: "AUTO", state: "OFF" },
        fan_positive: { mode: "AUTO", state: "OFF" },
        fan_negative: { mode: "AUTO", state: "OFF" },
        pressure_washer: { mode: "FORCE_OFF", state: "OFF", timerDuration: 0, timerStartedAt: null, timerExpiresAt: null },
        fanIntake: "OFF", fanExhaust: "OFF", mode: "AUTO",
      });
      console.log("🔧 Control state reset to new schema");
    }
  }

  cache.set(cacheKey, control);
  return control;
}

// ===== ANOMALY RULES (ML-DERIVED + SENSOR FAULTS + COMPOSITE RISK) =====
function generateAlertsFromReading(reading) {
  const alerts = [];

  const {
    houseId, temperature, humidity, ammonia, methane,
    fanIntakeRpm, fanExhaustRpm, fanIntakeDuty, fanExhaustDuty, createdAt,
  } = reading;

  const readingTime = createdAt || new Date();
  const hid = houseId || "house-1";

  // ── SENSOR FAULTS: missing / invalid ──
  if (temperature == null || Number.isNaN(temperature)) {
    alerts.push({ houseId: hid, type: "warning", category: "environment", severity: "medium", message: "Missing or invalid temperature reading.", source: "sensor-fault-rules", createdAt: readingTime });
  }
  if (humidity == null || Number.isNaN(humidity)) {
    alerts.push({ houseId: hid, type: "warning", category: "environment", severity: "medium", message: "Missing or invalid humidity reading.", source: "sensor-fault-rules", createdAt: readingTime });
  }
  if (ammonia == null || Number.isNaN(ammonia)) {
    alerts.push({ houseId: hid, type: "warning", category: "environment", severity: "medium", message: "Missing or invalid ammonia reading.", source: "sensor-fault-rules", createdAt: readingTime });
  }
  if (methane == null || Number.isNaN(methane)) {
    alerts.push({ houseId: hid, type: "warning", category: "environment", severity: "medium", message: "Missing or invalid methane reading.", source: "sensor-fault-rules", createdAt: readingTime });
  }

  // ── SENSOR FAULTS: impossible ranges ──
  if (typeof temperature === "number" && (temperature < 0 || temperature > 60)) {
    alerts.push({ houseId: hid, type: "critical", category: "environment", severity: "high", message: `Out-of-range temperature reading (${temperature} °C).`, source: "sensor-fault-rules", createdAt: readingTime });
  }
  if (typeof humidity === "number" && (humidity < 0 || humidity > 100)) {
    alerts.push({ houseId: hid, type: "critical", category: "environment", severity: "high", message: `Out-of-range humidity reading (${humidity} %).`, source: "sensor-fault-rules", createdAt: readingTime });
  }
  if (typeof ammonia === "number" && ammonia < 0) {
    alerts.push({ houseId: hid, type: "warning", category: "environment", severity: "medium", message: `Negative ammonia reading detected (${ammonia} ppm).`, source: "sensor-fault-rules", createdAt: readingTime });
  }
  if (typeof methane === "number" && methane < 0) {
    alerts.push({ houseId: hid, type: "warning", category: "environment", severity: "medium", message: `Negative methane reading detected (${methane} ppm).`, source: "sensor-fault-rules", createdAt: readingTime });
  }

  // ── Temperature alerts ──
  if (typeof temperature === "number") {
    if (temperature < 27 || temperature > 36) {
      alerts.push({ houseId: hid, type: "critical", category: "environment", severity: "high", message: `Critical temperature condition detected (${temperature.toFixed(1)} °C).`, source: "ml-derived-rules", createdAt: readingTime });
    } else if (temperature < 29 || temperature > 34) {
      alerts.push({ houseId: hid, type: "warning", category: "environment", severity: "medium", message: `Temperature approaching unsafe range (${temperature.toFixed(1)} °C).`, source: "ml-derived-rules", createdAt: readingTime });
    }
  }

  // ── Humidity alerts ──
  if (typeof humidity === "number") {
    if (humidity < 40 || humidity > 80) {
      alerts.push({ houseId: hid, type: "critical", category: "environment", severity: "high", message: `Critical humidity condition detected (${humidity.toFixed(1)} %).`, source: "ml-derived-rules", createdAt: readingTime });
    } else if (humidity < 45 || humidity > 75) {
      alerts.push({ houseId: hid, type: "warning", category: "environment", severity: "medium", message: `Humidity approaching unsafe range (${humidity.toFixed(1)} %).`, source: "ml-derived-rules", createdAt: readingTime });
    }
  }

  // ── Ammonia alerts ──
  if (typeof ammonia === "number") {
    if (ammonia >= 25) {
      alerts.push({ houseId: hid, type: "critical", category: "environment", severity: "high", message: `Ammonia levels in dangerous range (${ammonia.toFixed(1)} ppm).`, source: "ml-derived-rules", createdAt: readingTime });
    } else if (ammonia >= 15) {
      alerts.push({ houseId: hid, type: "warning", category: "environment", severity: "medium", message: `Ammonia levels approaching unsafe range (${ammonia.toFixed(1)} ppm).`, source: "ml-derived-rules", createdAt: readingTime });
    }
  }

  // ── Methane alerts ──
  if (typeof methane === "number") {
    if (methane > 10) {
      alerts.push({ houseId: hid, type: "critical", category: "environment", severity: "high", message: `Methane levels detected above safe range (${methane.toFixed(1)} ppm).`, source: "ml-derived-rules", createdAt: readingTime });
    } else if (methane > 5) {
      alerts.push({ houseId: hid, type: "warning", category: "environment", severity: "medium", message: `Methane levels rising above normal (${methane.toFixed(1)} ppm).`, source: "ml-derived-rules", createdAt: readingTime });
    }
  }

  // ── Fan faults ──
  const fanIntakeDutyOn = fanIntakeDuty && fanIntakeDuty > 0;
  const fanExhaustDutyOn = fanExhaustDuty && fanExhaustDuty > 0;

  if (fanIntakeDutyOn && (!fanIntakeRpm || fanIntakeRpm < 100)) {
    alerts.push({ houseId: hid, type: "critical", category: "mechanical", severity: "high", message: `Possible intake fan fault: duty ${fanIntakeDuty}% but RPM ${fanIntakeRpm}.`, source: "ml-derived-rules", createdAt: readingTime });
  }
  if (fanExhaustDutyOn && (!fanExhaustRpm || fanExhaustRpm < 100)) {
    alerts.push({ houseId: hid, type: "critical", category: "mechanical", severity: "high", message: `Possible exhaust fan fault: duty ${fanExhaustDuty}% but RPM ${fanExhaustRpm}.`, source: "ml-derived-rules", createdAt: readingTime });
  }

  // ── Composite risk score (ML-style) ──
  let riskScore = 0;
  if (typeof temperature === "number") { if (temperature < 22 || temperature > 36) riskScore += 2; else if (temperature < 24 || temperature > 29) riskScore += 1; }
  if (typeof humidity === "number") { if (humidity < 40 || humidity > 80) riskScore += 2; else if (humidity < 55 || humidity > 75) riskScore += 1; }
  if (typeof ammonia === "number") { if (ammonia > 20) riskScore += 2; else if (ammonia > 5) riskScore += 1; }
  if (typeof methane === "number") { if (methane > 5) riskScore += 2; else if (methane > 2) riskScore += 1; }
  const fanFault = (fanIntakeDutyOn && (!fanIntakeRpm || fanIntakeRpm < 100)) || (fanExhaustDutyOn && (!fanExhaustRpm || fanExhaustRpm < 100));
  if (fanFault) riskScore += 2;

  if (riskScore >= 5) {
    alerts.push({ houseId: hid, type: "critical", category: "environment", severity: "high", message: `Composite risk score high (score=${riskScore}).`, source: "ml-derived-rules", createdAt: readingTime });
  } else if (riskScore >= 3) {
    alerts.push({ houseId: hid, type: "warning", category: "environment", severity: "medium", message: `Composite risk score elevated (score=${riskScore}).`, source: "ml-derived-rules", createdAt: readingTime });
  }

  return alerts;
}

// ===== API ENDPOINTS =====

app.get("/health", (req, res) => {
  res.json({ status: "Backend is running", timestamp: new Date().toISOString(), version: "3.0.0-final-defense", cache: { keys: cache.keys().length, stats: cache.getStats() } });
});

// 1) POST /api/sensors — ESP32 Fan MCU sends sensor data
app.post("/api/sensors", async (req, res) => {
  try {
    const { houseId, temperature, humidity, ammonia, methane, light, fanIntakeRpm, fanExhaustRpm, fanIntakeDuty, fanExhaustDuty, lightStatus, pressureWasherStatus, mode } = req.body;

    if (temperature === undefined || humidity === undefined || ammonia === undefined || methane === undefined) {
      return res.status(400).json({ error: "Missing required fields: temperature, humidity, ammonia, methane" });
    }

    const sensorData = await SensorData.create({
      houseId: houseId || "house-1",
      temperature, humidity, ammonia, methane,
      light: (light != null && light >= 0) ? light : 0,
      fanIntakeRpm: fanIntakeRpm || 0,
      fanExhaustRpm: fanExhaustRpm || 0,
      fanIntakeDuty: fanIntakeDuty || 0,
      fanExhaustDuty: fanExhaustDuty || 0,
      lightStatus: (lightStatus && lightStatus !== "N/A") ? lightStatus : "OFF",
      pressureWasherStatus: (pressureWasherStatus && pressureWasherStatus !== "N/A") ? pressureWasherStatus : "OFF",
      mode: mode || "AUTO",
    });

    const alertsToCreate = generateAlertsFromReading(sensorData);
    if (alertsToCreate.length > 0) await Alert.insertMany(alertsToCreate);

    cache.del("latest_sensor");
    cache.del("sensor_history");

    return res.status(201).json({ success: true, message: "Sensor data saved", data: sensorData, alertsCreated: alertsToCreate.length });
  } catch (err) {
    console.error("Error saving sensor data:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// 2) GET /api/sensors/latest
app.get("/api/sensors/latest", async (req, res) => {
  try {
    const cacheKey = "latest_sensor";
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const latestSensor = await SensorData.findOne().sort({ createdAt: -1 }).select("-__v").lean();
    if (!latestSensor) return res.status(404).json({ message: "No sensor data yet" });

    cache.set(cacheKey, latestSensor);
    return res.json(latestSensor);
  } catch (err) {
    console.error("Error fetching latest sensor:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// 3) GET /api/sensors/history
app.get("/api/sensors/history", async (req, res) => {
  try {
    const { limit = 24, houseId = "house-1" } = req.query;
    const parsedLimit = Math.min(parseInt(limit), 100);
    const cacheKey = `sensor_history_${houseId}_${parsedLimit}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const history = await SensorData.find({ houseId }).sort({ createdAt: -1 }).limit(parsedLimit).select("temperature humidity ammonia methane light createdAt -_id").lean();
    const reversed = history.reverse();
    cache.set(cacheKey, reversed);
    return res.json(reversed);
  } catch (err) {
    console.error("Error fetching sensor history:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// 4) GET /api/control/state
app.get("/api/control/state", async (req, res) => {
  try {
    const control = await getControlState();
    return res.json(control);
  } catch (err) {
    console.error("Error fetching control state:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// 5) POST /api/control
app.post("/api/control", async (req, res) => {
  try {
    const { device, mode, timerDuration } = req.body;
    let targetDevices = [];

    if (device === "fan") { targetDevices = ["fan_positive", "fan_negative"]; }
    else if (["light", "fan_positive", "fan_negative", "pressure_washer"].includes(device)) { targetDevices = [device]; }
    else { return res.status(400).json({ error: 'Invalid device.' }); }

    const validModes = ["AUTO", "FORCE_ON", "FORCE_OFF"];
    if (!validModes.includes(mode)) return res.status(400).json({ error: `Invalid mode.` });
    if (targetDevices.includes("pressure_washer") && mode === "AUTO") return res.status(400).json({ error: "Pressure washer does not support AUTO." });

    const control = await getControlState();

    for (const dev of targetDevices) {
      control[dev].mode = mode;
      if (mode === "FORCE_ON") control[dev].state = "ON";
      else if (mode === "FORCE_OFF") control[dev].state = "OFF";
    }

    if (targetDevices.includes("pressure_washer")) {
      if (mode === "FORCE_ON") {
        const duration = parseInt(timerDuration, 10) || 300;
        const now = new Date();
        const expires = new Date(now.getTime() + duration * 1000);
        control.pressure_washer.timerDuration = duration;
        control.pressure_washer.timerStartedAt = now;
        control.pressure_washer.timerExpiresAt = expires;
        console.log(`🚿 Pressure washer ON — auto-OFF in ${duration}s`);
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

    return res.json({ success: true, message: `${device} set to ${mode}`, controlState: control });
  } catch (err) {
    console.error("Error updating control state:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// 6) GET /api/alerts
app.get("/api/alerts", async (req, res) => {
  try {
    const { limit = 20 } = req.query;
    const alerts = await Alert.find({}).sort({ createdAt: -1 }).limit(Number(limit)).lean();
    return res.json({ success: true, alerts });
  } catch (err) {
    console.error("Error fetching alerts:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// 7) POST /api/light-status — Light MCU sends ONLY light/washer status
app.post("/api/light-status", async (req, res) => {
  try {
    const { light, lightStatus, pressureWasherStatus, mode } = req.body;

    const latestSensor = await SensorData.findOne().sort({ createdAt: -1 });

    if (latestSensor) {
      if (light != null && light >= 0) latestSensor.light = light;
      if (lightStatus) latestSensor.lightStatus = lightStatus;
      if (pressureWasherStatus) latestSensor.pressureWasherStatus = pressureWasherStatus;
      await latestSensor.save();
      cache.del("latest_sensor");

      return res.status(200).json({
        success: true,
        message: "Light status updated on latest sensor record",
        data: { light: latestSensor.light, lightStatus: latestSensor.lightStatus, pressureWasherStatus: latestSensor.pressureWasherStatus },
      });
    } else {
      return res.status(404).json({ error: "No sensor data exists yet" });
    }
  } catch (err) {
    console.error("Error updating light status:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /api/control/restore
app.post("/api/control/restore", async (req, res) => {
  try {
    const control = await getControlState();
    const commands = [];
    if (control.light) commands.push({ device: "light", mode: control.light.mode, state: control.light.state });
    if (control.fan_positive) commands.push({ device: "fan", mode: control.fan_positive.mode, state: control.fan_positive.state });
    if (control.pressure_washer) commands.push({ device: "pressure_washer", mode: control.pressure_washer.mode, state: control.pressure_washer.state });
    console.log("🔄 Restore commands prepared:", commands);
    return res.json({ success: true, message: "Control state restored", restored: { light: control.light, fan: control.fan_positive, washer: control.pressure_washer }, commands });
  } catch (err) {
    console.error("Restore error:", err);
    return res.status(500).json({ error: "Failed to restore state" });
  }
});

// ===== PRESSURE WASHER SAFETY TIMER =====
setInterval(async () => {
  try {
    const control = await ControlState.findOne();
    if (!control) return;
    const pw = control.pressure_washer;
    if (pw.state === "ON" && pw.timerExpiresAt) {
      const now = new Date();
      if (now >= pw.timerExpiresAt) {
        pw.state = "OFF"; pw.mode = "FORCE_OFF"; pw.timerDuration = 0; pw.timerStartedAt = null; pw.timerExpiresAt = null;
        control.updatedAt = new Date();
        await control.save();
        cache.del("control_state");
        console.log("🚿⏱️ Pressure washer AUTO-OFF: timer expired!");
      }
    }
  } catch (err) { console.error("⚠️ Pressure washer timer check error:", err.message); }
}, 10000);

// ===== ADMIN: RESET CONTROL =====
app.post("/admin/reset-control", async (req, res) => {
  try {
    await ControlState.deleteMany({});
    const control = await ControlState.create({
      light: { mode: "AUTO", state: "OFF" }, fan_positive: { mode: "AUTO", state: "OFF" }, fan_negative: { mode: "AUTO", state: "OFF" },
      pressure_washer: { mode: "FORCE_OFF", state: "OFF", timerDuration: 0, timerStartedAt: null, timerExpiresAt: null },
      fanIntake: "OFF", fanExhaust: "OFF", mode: "AUTO",
    });
    cache.del("control_state");
    return res.json({ success: true, message: "Control state reset", control });
  } catch (err) { console.error("Reset control error:", err); return res.status(500).json({ error: "Reset failed" }); }
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
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Caching: 5s TTL`);
  console.log(`🔒 Rate limiting: 100 req/min`);
  console.log(`🔔 ML-derived alert system active`);
  console.log(`💡 Light MCU endpoint: /api/light-status`);
});