const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const historyFile = path.join(__dirname, "data", "history.json");

// Endpoint \u0e1b\u0e01\u0e15\u0e34 (\u0e14\u0e39\u0e1b\u0e23\u0e30\u0e27\u0e31\u0e15\u0e34\u0e22\u0e49\u0e2d\u0e2b\u0e25\u0e31\u0e07)
app.get("/history", (req, res) => {
  const data = fs.readFileSync(historyFile, "utf8");
  res.setHeader("Content-Type", "application/json");
  res.send(data);
});

// \u0e40\u0e21\u0e37\u0e48\u0e2d client \u0e40\u0e0a\u0e37\u0e48\u0e2d\u0e21\u0e15\u0e48\u0e2d\u0e1c\u0e48\u0e32\u0e19 Socket.io
io.on("connection", (socket) => {
  console.log("\u2705 Client connected:", socket.id);

  // \u0e22\u0e34\u0e07 event \u0e08\u0e33\u0e25\u0e2d\u0e07\u0e43\u0e2b\u0e21\u0e48\u0e17\u0e38\u0e01\u0e46 3 \u0e27\u0e34\u0e19\u0e32\u0e17\u0e35
  const interval = setInterval(() => {
    const newDetection = {
      id: Date.now(),
      timestamp: new Date().toISOString(),
      event: "Threat detected",
      details: `Random threat level: ${["low","medium","high"][Math.floor(Math.random()*3)]}`
    };
    io.emit("detection:new", newDetection);
  }, 3000);

  socket.on("disconnect", () => {
    console.log("\u274c Client disconnected:", socket.id);
    clearInterval(interval);
  });
});

const PORT = 4000;
server.listen(PORT, () => console.log(`\ud83d\ude80 Mock server running on http://localhost:${PORT}`));
