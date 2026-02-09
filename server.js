const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const NodeCache = require("node-cache"); // ✅ NEW: Caching library
require("dotenv").config();

const app = express();

// ===== ✅ NEW: CACHING SETUP =====
// Cache sensor data for 5 seconds to reduce MongoDB queries
const cache = new NodeCache({ 
  stdTTL: 5,           // 5-second cache
  checkperiod: 10,     // Check for expired keys every 10s
  useClones: false     // Better performance
});

// ===== MIDDLEWARE =====
// ✅ OPTIMIZED: Restricted CORS for better security & performance
app.use(cors({
  origin: process.env.FRONTEND_URL || "*", // Specify your Netlify URL in production
  methods: ["GET", "POST"],
  credentials: true
}));

app.use(express.json({ limit: "10kb" })); // ✅ NEW: Limit payload size

// ===== ✅ NEW: REQUEST RATE LIMITING =====
// Prevents system overload from too many requests
const rateLimit = require("express-rate-limit");
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute window
  max: 100, // 100 requests per minute per IP
  message: "Too many requests, please try again later"
});
app.use("/api", limiter);

// ===== MONGODB CONNECTION =====
// ✅ OPTIMIZED: Connection pooling for better performance
mongoose
  .connect(process.env.MONGODB_URI, {
    maxPoolSize: 10,        // ✅ NEW: Connection pool (reuse connections)
    minPoolSize: 2,         // ✅ NEW: Minimum connections
    socketTimeoutMS: 45000, // ✅ NEW: Socket timeout
    serverSelectionTimeoutMS: 10000, // ✅ NEW: Faster timeout
  })
  .then(() => {
    console.log("✅ MongoDB Connected with connection pooling");
    createIndexes(); // ✅ NEW: Create indexes on startup
  })
  .catch((err) => {
    console.error("❌ MongoDB Error:", err);
    process.exit(1); // Exit if DB connection fails
  });

// ===== MONGODB SCHEMAS =====

// Sensor Data Schema (historical storage)
const sensorSchema = new mongoose.Schema({
  houseId: { type: String, default: "house-1", index: true }, // ✅ ADDED: Index
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
  createdAt: { type: Date, default: Date.now, index: true }, // ✅ ADDED: Index
});

// ✅ NEW: Compound index for faster queries (most important!)
sensorSchema.index({ houseId: 1, createdAt: -1 });

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

// ===== ✅ NEW: CREATE INDEXES FUNCTION =====
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
  // ✅ OPTIMIZED: Check cache first
  const cacheKey = "control_state";
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }

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

  // ✅ NEW: Cache for 5 seconds
  cache.set(cacheKey, control);
  return control;
}

// ===== API ENDPOINTS =====

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "Backend is running",
    timestamp: new Date().toISOString(),
    version: "2.1.0-optimized",
    cache: {
      keys: cache.keys().length,
      stats: cache.getStats()
    }
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

    // ✅ OPTIMIZED: Use lean() for faster saves
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

    // ✅ NEW: Invalidate cache when new data arrives
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

// 2️⃣ GET /api/sensors/latest - Frontend gets latest sensor reading
app.get("/api/sensors/latest", async (req, res) => {
  try {
    // ✅ OPTIMIZED: Check cache first
    const cacheKey = "latest_sensor";
    const cached = cache.get(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    // ✅ OPTIMIZED: Use lean() and select only needed fields
    const latestSensor = await SensorData.findOne()
      .sort({ createdAt: -1 })
      .select("-__v") // Exclude version key
      .lean(); // ✅ NEW: Returns plain JS object (faster)

    if (!latestSensor) {
      return res.status(404).json({ message: "No sensor data yet" });
    }

    // ✅ NEW: Cache the result
    cache.set(cacheKey, latestSensor);

    return res.json(latestSensor);
  } catch (err) {
    console.error("Error fetching latest sensor:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// 3️⃣ GET /api/sensors/history - Frontend gets data for charts
app.get("/api/sensors/history", async (req, res) => {
  try {
    const { limit = 24, houseId = "house-1" } = req.query;
    const parsedLimit = Math.min(parseInt(limit), 100); // ✅ NEW: Max 100 records

    // ✅ OPTIMIZED: Cache key includes parameters
    const cacheKey = `sensor_history_${houseId}_${parsedLimit}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    // ✅ OPTIMIZED: Use projection to fetch only needed fields
    const history = await SensorData.find({ houseId })
      .sort({ createdAt: -1 })
      .limit(parsedLimit)
      .select("temperature humidity ammonia methane light createdAt -_id") // ✅ NEW: Only chart data
      .lean(); // ✅ NEW: Faster query

    const reversed = history.reverse(); // Oldest to newest for chart

    // ✅ NEW: Cache for 5 seconds
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

    // ✅ NEW: Invalidate cache after update
    cache.del("control_state");

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

// ===== ADMIN: RETENTION POLICY (DELETE OLD DATA) =====
// Deletes sensor data older than N days (default: 90)
app.delete("/admin/cleanup", async (req, res) => {
  try {
    const { safeKey, days } = req.query;

    // Simple protection: require secret key from .env
    if (!safeKey || safeKey !== process.env.ADMIN_KEY) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const retentionDays = parseInt(days) || 90; // default: 90 days
    const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    const result = await SensorData.deleteMany({
      createdAt: { $lt: cutoffDate }
    });

    return res.json({
      success: true,
      message: `Deleted sensor data older than ${retentionDays} days`,
      deletedCount: result.deletedCount,
      cutoffDate
    });
  } catch (err) {
    console.error("Error during cleanup:", err);
    return res.status(500).json({ error: "Cleanup failed" });
  }
});


// ===== ✅ NEW: GRACEFUL SHUTDOWN =====
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