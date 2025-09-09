const express = require("express");
const http = require("http");
const socketio = require("socket.io");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");

const app = express();
const server = http.createServer(app);

// Use a simple in-memory store for users and active calls.
// In a production app, you would use a database (e.g., MongoDB, PostgreSQL, Redis)
// to store this data for persistence and scalability.
const users = new Map(); // Maps userId to socketId
const activeCalls = new Map(); // Maps callId to callSession details

// Use CORS to allow requests from your Expo app
app.use(cors());
app.use(express.json());

// Initialize Socket.IO with CORS
const io = new socketio.Server(server, {
  cors: {
    origin: "*", // Adjust this to your frontend URL in production
    methods: ["GET", "POST"],
  },
});

// Socket.IO connection handler
io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`);

  // When a user authenticates, store their userId and socketId
  socket.on("authenticate", (userId) => {
    console.log(`User ${userId} authenticated with socket ${socket.id}`);
    users.set(userId, socket.id);
  });

  // Handle incoming audio data and relay it to the other party
  // Note: This is a simplified relay and would need to be optimized
  // for real-time performance and WebRTC integration in a production app.
  socket.on("audio_data", (data) => {
    const { callId, audioChunk } = data;
    const callSession = activeCalls.get(callId);
    if (!callSession) return;

    // Determine the recipient
    const recipientId =
      callSession.callerId === data.senderId
        ? callSession.receiverId
        : callSession.callerId;

    const recipientSocketId = users.get(recipientId);
    if (recipientSocketId) {
      console.log(`Relaying audio data for call ${callId}`);
      io.to(recipientSocketId).emit("audio_data", {
        callId,
        timestamp: Date.now(),
        audioChunk,
      });
    }
  });

  // Handle user disconnection
  socket.on("disconnect", () => {
    console.log(`User disconnected: ${socket.id}`);
    // Clean up user from the map
    for (const [userId, socketId] of users.entries()) {
      if (socketId === socket.id) {
        users.delete(userId);
        console.log(`User ${userId} removed from active users.`);
        // Also, handle any active calls this user was in
        activeCalls.forEach((call, callId) => {
          if (call.callerId === userId || call.receiverId === userId) {
            console.log(`Ending call ${callId} due to user disconnect.`);
            io.to(call.callerId).emit("call_ended", { callId });
            io.to(call.receiverId).emit("call_ended", { callId });
            activeCalls.delete(callId);
          }
        });
        break;
      }
    }
  });
});

// API endpoint to initiate a call
app.post("/api/calls/initiate-simple", (req, res) => {
  const { callerId, receiverId, orderTrackingId, callerName, callType } =
    req.body;

  if (!callerId || !receiverId) {
    return res
      .status(400)
      .json({ success: false, error: "Caller and receiver IDs are required." });
  }

  // Check if either user is already in a call
  const isCallerBusy = [...activeCalls.values()].some(
    (call) =>
      call.status !== "ended" &&
      call.status !== "rejected" &&
      (call.callerId === callerId || call.receiverId === callerId)
  );
  const isReceiverBusy = [...activeCalls.values()].some(
    (call) =>
      call.status !== "ended" &&
      call.status !== "rejected" &&
      (call.callerId === receiverId || call.receiverId === receiverId)
  );

  if (isCallerBusy) {
    return res
      .status(409)
      .json({ success: false, error: "Caller is already in a call." });
  }

  if (isReceiverBusy) {
    return res
      .status(409)
      .json({ success: false, error: "Receiver is already in a call." });
  }

  const callId = uuidv4();
  const callSession = {
    id: callId,
    callerId,
    receiverId,
    orderTrackingId,
    callerName,
    callType,
    status: "ringing",
    createdAt: Date.now(),
  };

  activeCalls.set(callId, callSession);
  console.log(`Initiating new call session: ${callId}`);

  // Send push notification (simulated)
  // In a real app, you would use Expo's Push Notification API
  // to send a notification to the receiver's Expo Push Token.
  console.log(
    `[PUSH] Sending push notification to ${receiverId} for incoming call.`
  );

  // Notify the receiver via Socket.IO
  const receiverSocketId = users.get(receiverId);
  if (receiverSocketId) {
    io.to(receiverSocketId).emit("incoming_call", {
      callId,
      callerId,
      orderTrackingId,
      callerName,
    });
    console.log(`Notified receiver ${receiverId} of incoming call.`);
  } else {
    console.log(`Receiver ${receiverId} is not connected.`);
    return res.status(404).json({
      success: false,
      error: "Receiver not found or is offline.",
    });
  }

  res.status(200).json({ success: true, callSession });
});

// API endpoint to accept a call
app.post("/api/calls/:callId/accept", (req, res) => {
  const { callId } = req.params;
  const { userId } = req.body;

  const callSession = activeCalls.get(callId);
  if (!callSession) {
    return res.status(404).json({
      success: false,
      error: "Call session not found.",
    });
  }

  if (callSession.receiverId !== userId) {
    return res.status(403).json({
      success: false,
      error: "User is not the receiver of this call.",
    });
  }

  callSession.status = "accepted";
  activeCalls.set(callId, callSession);
  console.log(`Call ${callId} accepted by ${userId}.`);

  // Notify the caller that the call has been accepted
  const callerSocketId = users.get(callSession.callerId);
  if (callerSocketId) {
    io.to(callerSocketId).emit("call_accepted", { callSession });
  }

  res.status(200).json({ success: true, callSession });
});

// API endpoint to reject a call
app.post("/api/calls/:callId/reject", (req, res) => {
  const { callId } = req.params;
  const { userId } = req.body;

  const callSession = activeCalls.get(callId);
  if (!callSession) {
    return res.status(404).json({
      success: false,
      error: "Call session not found.",
    });
  }

  if (callSession.receiverId !== userId) {
    return res.status(403).json({
      success: false,
      error: "User is not the receiver of this call.",
    });
  }

  callSession.status = "rejected";
  activeCalls.set(callId, callSession);
  console.log(`Call ${callId} rejected by ${userId}.`);

  // Notify the caller that the call was rejected
  const callerSocketId = users.get(callSession.callerId);
  if (callerSocketId) {
    io.to(callerSocketId).emit("call_rejected", { callId });
  }

  // Clean up the call session after rejection
  activeCalls.delete(callId);

  res.status(200).json({ success: true });
});

// API endpoint to end a call
app.post("/api/calls/:callId/end", (req, res) => {
  const { callId } = req.params;
  const { userId } = req.body;

  const callSession = activeCalls.get(callId);
  if (!callSession) {
    return res.status(404).json({
      success: false,
      error: "Call session not found.",
    });
  }

  callSession.status = "ended";
  activeCalls.set(callId, callSession);
  console.log(`Call ${callId} ended by ${userId}.`);

  // Notify both parties that the call has ended
  const callerSocketId = users.get(callSession.callerId);
  const receiverSocketId = users.get(callSession.receiverId);

  if (callerSocketId) {
    io.to(callerSocketId).emit("call_ended", { callId });
  }
  if (receiverSocketId) {
    io.to(receiverSocketId).emit("call_ended", { callId });
  }

  // Clean up the call session
  activeCalls.delete(callId);

  res.status(200).json({ success: true });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});
