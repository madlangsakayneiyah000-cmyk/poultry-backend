app.get("/health", (req, res) => {
  const dbStatus = mongoose.connection.readyState === 1 ? "Connected" : "Not connected";
  res.json({
    status: "Backend is running",
    dbStatus,
    timestamp: new Date().toISOString(),
    version: "1.0.0",
  });
});
