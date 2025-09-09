// Call Management Backend
const express = require("express");
const { RtcTokenBuilder, RtcRole } = require("agora-access-token");
const admin = require("firebase-admin");
const cors = require("cors");
const http = require("http");
const socketIo = require("socket.io");

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

// Agora Configuration
const AGORA_APP_ID = process.env.AGORA_APP_ID;
const AGORA_APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE;

// Firebase Admin (for push notifications)
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
});

// In-memory storage for active calls (use Redis in production)
const activeCalls = new Map();
const userSockets = new Map();

// Generate Agora RTC Token
function generateAgoraToken(channelName, uid, role = RtcRole.PUBLISHER) {
  const expirationTimeInSeconds = 3600; // 1 hour
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

  return RtcTokenBuilder.buildTokenWithUid(
    AGORA_APP_ID,
    AGORA_APP_CERTIFICATE,
    channelName,
    uid,
    role,
    privilegeExpiredTs
  );
}

// API Routes

// 1. Initialize Call
app.post("/api/calls/initiate", async (req, res) => {
  try {
    const {
      callerId,
      receiverId,
      orderTrackingId,
      callType = "voice",
    } = req.body;

    // Generate unique channel name
    const channelName = `call_${orderTrackingId}_${Date.now()}`;

    // Generate tokens for both users
    const callerToken = generateAgoraToken(channelName, parseInt(callerId));
    const receiverToken = generateAgoraToken(channelName, parseInt(receiverId));

    // Create call session
    const callSession = {
      id: `call_${Date.now()}`,
      channelName,
      callerId,
      receiverId,
      orderTrackingId,
      callType,
      status: "initiated",
      createdAt: new Date().toISOString(),
      tokens: {
        caller: callerToken,
        receiver: receiverToken,
      },
    };

    // Store active call
    activeCalls.set(callSession.id, callSession);

    // Send real-time notification to receiver via Socket.IO
    const receiverSocketId = userSockets.get(receiverId);
    if (receiverSocketId) {
      io.to(receiverSocketId).emit("incoming_call", {
        callId: callSession.id,
        callerId,
        callerName: req.body.callerName || "Customer",
        orderTrackingId,
        callType,
      });
    }

    // Send push notification to receiver
    await sendPushNotification(receiverId, {
      title: "Incoming Call",
      body: `${
        req.body.callerName || "Customer"
      } is calling about order #${orderTrackingId}`,
      data: {
        type: "incoming_call",
        callId: callSession.id,
        callerId,
        orderTrackingId,
      },
    });

    res.json({
      success: true,
      callSession: {
        id: callSession.id,
        channelName,
        token: callerToken,
        agoraAppId: AGORA_APP_ID,
      },
    });
  } catch (error) {
    console.error("Error initiating call:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. Accept Call
app.post("/api/calls/:callId/accept", async (req, res) => {
  try {
    const { callId } = req.params;
    const { userId } = req.body;

    const callSession = activeCalls.get(callId);
    if (!callSession) {
      return res.status(404).json({ success: false, error: "Call not found" });
    }

    // Update call status
    callSession.status = "accepted";
    callSession.acceptedAt = new Date().toISOString();

    // Get appropriate token
    const token =
      userId === callSession.callerId
        ? callSession.tokens.caller
        : callSession.tokens.receiver;

    // Notify caller that call was accepted
    const callerSocketId = userSockets.get(callSession.callerId);
    if (callerSocketId && userId !== callSession.callerId) {
      io.to(callerSocketId).emit("call_accepted", { callId });
    }

    res.json({
      success: true,
      callSession: {
        id: callSession.id,
        channelName: callSession.channelName,
        token,
        agoraAppId: AGORA_APP_ID,
      },
    });
  } catch (error) {
    console.error("Error accepting call:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 3. Reject Call
app.post("/api/calls/:callId/reject", async (req, res) => {
  try {
    const { callId } = req.params;
    const { userId } = req.body;

    const callSession = activeCalls.get(callId);
    if (!callSession) {
      return res.status(404).json({ success: false, error: "Call not found" });
    }

    // Update call status
    callSession.status = "rejected";
    callSession.endedAt = new Date().toISOString();

    // Notify caller that call was rejected
    const callerSocketId = userSockets.get(callSession.callerId);
    if (callerSocketId) {
      io.to(callerSocketId).emit("call_rejected", { callId });
    }

    // Clean up
    activeCalls.delete(callId);

    res.json({ success: true });
  } catch (error) {
    console.error("Error rejecting call:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 4. End Call
app.post("/api/calls/:callId/end", async (req, res) => {
  try {
    const { callId } = req.params;
    const { userId } = req.body;

    const callSession = activeCalls.get(callId);
    if (!callSession) {
      return res.status(404).json({ success: false, error: "Call not found" });
    }

    // Update call status
    callSession.status = "ended";
    callSession.endedAt = new Date().toISOString();

    // Notify other participant
    const otherUserId =
      userId === callSession.callerId
        ? callSession.receiverId
        : callSession.callerId;
    const otherUserSocketId = userSockets.get(otherUserId);

    if (otherUserSocketId) {
      io.to(otherUserSocketId).emit("call_ended", { callId });
    }

    // Clean up
    activeCalls.delete(callId);

    res.json({ success: true });
  } catch (error) {
    console.error("Error ending call:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Socket.IO Connection Handling
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // User authentication
  socket.on("authenticate", (userId) => {
    userSockets.set(userId, socket.id);
    console.log(`User ${userId} authenticated with socket ${socket.id}`);
  });

  // Handle call events
  socket.on("call_status_update", (data) => {
    const { callId, status, targetUserId } = data;
    const targetSocketId = userSockets.get(targetUserId);

    if (targetSocketId) {
      io.to(targetSocketId).emit("call_status_update", { callId, status });
    }
  });

  socket.on("disconnect", () => {
    // Remove user from active sockets
    for (const [userId, socketId] of userSockets.entries()) {
      if (socketId === socket.id) {
        userSockets.delete(userId);
        break;
      }
    }
    console.log("User disconnected:", socket.id);
  });
});

// Push Notification Helper
async function sendPushNotification(userId, notification) {
  try {
    // Get user's FCM token from database
    // const userToken = await getUserFCMToken(userId);

    // For demo purposes, assuming you have the token
    const message = {
      notification: {
        title: notification.title,
        body: notification.body,
      },
      data: notification.data,
      // token: userToken,
    };

    // await admin.messaging().send(message);
    console.log("Push notification sent to user:", userId);
  } catch (error) {
    console.error("Error sending push notification:", error);
  }
}

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "OK", timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Call service running on port ${PORT}`);
});

module.exports = { app, io };
