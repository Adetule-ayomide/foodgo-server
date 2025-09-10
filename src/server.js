const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors");

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

app.use(cors());
app.use(express.json());

// Store active rooms and their participants
const activeRooms = new Map();

// Generate a random 6-digit call code
const generateCallCode = () => {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
};

// API endpoint to create a new call room
app.post("/api/create-call", (req, res) => {
  const callCode = generateCallCode();

  // Ensure the code is unique
  while (activeRooms.has(callCode)) {
    callCode = generateCallCode();
  }

  activeRooms.set(callCode, {
    participants: [],
    createdAt: new Date(),
    status: "waiting",
  });

  console.log(`Created call room with code: ${callCode}`);

  res.json({
    success: true,
    callCode: callCode,
    message: "Call room created successfully",
  });
});

// API endpoint to check if a call code exists
app.get("/api/check-call/:code", (req, res) => {
  const { code } = req.params;
  const room = activeRooms.get(code.toUpperCase());

  if (!room) {
    return res.json({
      success: false,
      message: "Invalid call code",
    });
  }

  if (room.participants.length >= 2) {
    return res.json({
      success: false,
      message: "Call room is full",
    });
  }

  res.json({
    success: true,
    message: "Call code is valid",
    participantCount: room.participants.length,
  });
});

// Socket.IO connection handling
io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Join a call room
  socket.on("join-call", (data) => {
    const { callCode, userName } = data;
    const roomCode = callCode.toUpperCase();
    const room = activeRooms.get(roomCode);

    if (!room) {
      socket.emit("call-error", { message: "Invalid call code" });
      return;
    }

    if (room.participants.length >= 2) {
      socket.emit("call-error", { message: "Call room is full" });
      return;
    }

    // Add participant to room
    room.participants.push({
      socketId: socket.id,
      userName: userName || "Anonymous",
      joinedAt: new Date(),
    });

    socket.join(roomCode);
    socket.callCode = roomCode;

    console.log(`User ${socket.id} joined call ${roomCode}`);

    // Notify all participants in the room
    socket.to(roomCode).emit("user-joined", {
      socketId: socket.id,
      userName: userName || "Anonymous",
      participantCount: room.participants.length,
    });

    socket.emit("call-joined", {
      callCode: roomCode,
      participantCount: room.participants.length,
      participants: room.participants,
    });

    // If room is full (2 participants), start the call
    if (room.participants.length === 2) {
      room.status = "active";
      io.to(roomCode).emit("call-ready", {
        message: "Both participants are ready. Call can begin!",
        participants: room.participants,
      });
    }
  });

  // Handle WebRTC signaling
  socket.on("webrtc-offer", (data) => {
    const { callCode, offer, targetSocketId } = data;
    console.log(`Forwarding offer from ${socket.id} to ${targetSocketId}`);

    socket.to(targetSocketId).emit("webrtc-offer", {
      offer: offer,
      fromSocketId: socket.id,
    });
  });

  socket.on("webrtc-answer", (data) => {
    const { answer, targetSocketId } = data;
    console.log(`Forwarding answer from ${socket.id} to ${targetSocketId}`);

    socket.to(targetSocketId).emit("webrtc-answer", {
      answer: answer,
      fromSocketId: socket.id,
    });
  });

  socket.on("webrtc-ice-candidate", (data) => {
    const { candidate, targetSocketId } = data;
    console.log(
      `Forwarding ICE candidate from ${socket.id} to ${targetSocketId}`
    );

    socket.to(targetSocketId).emit("webrtc-ice-candidate", {
      candidate: candidate,
      fromSocketId: socket.id,
    });
  });

  // Handle call end
  socket.on("end-call", () => {
    const roomCode = socket.callCode;
    if (roomCode) {
      socket.to(roomCode).emit("call-ended", {
        message: "Call ended by other participant",
      });

      // Clean up room
      const room = activeRooms.get(roomCode);
      if (room) {
        room.participants = room.participants.filter(
          (p) => p.socketId !== socket.id
        );
        if (room.participants.length === 0) {
          activeRooms.delete(roomCode);
          console.log(`Deleted empty call room: ${roomCode}`);
        }
      }
    }
  });

  // Handle disconnect
  socket.on("disconnect", () => {
    console.log(`User disconnected: ${socket.id}`);

    const roomCode = socket.callCode;
    if (roomCode) {
      const room = activeRooms.get(roomCode);
      if (room) {
        room.participants = room.participants.filter(
          (p) => p.socketId !== socket.id
        );

        // Notify other participants
        socket.to(roomCode).emit("user-left", {
          socketId: socket.id,
          participantCount: room.participants.length,
        });

        // Clean up empty room
        if (room.participants.length === 0) {
          activeRooms.delete(roomCode);
          console.log(`Deleted empty call room: ${roomCode}`);
        }
      }
    }
  });
});

// Clean up old rooms (optional - runs every 5 minutes)
setInterval(() => {
  const now = new Date();
  for (const [code, room] of activeRooms.entries()) {
    const roomAge = now - room.createdAt;
    // Remove rooms older than 1 hour with no participants
    if (roomAge > 60 * 60 * 1000 && room.participants.length === 0) {
      activeRooms.delete(code);
      console.log(`Cleaned up old room: ${code}`);
    }
  }
}, 5 * 60 * 1000);

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`WebRTC Signaling Server running on port ${PORT}`);
  console.log(`HTTP API available at http://localhost:${PORT}`);
});

module.exports = { app, server, io };
