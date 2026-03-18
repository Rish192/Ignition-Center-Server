import dotenv from "dotenv";
dotenv.config();
import express from "express";
import cors from "cors";
import http from "http";
import { WebSocketServer } from "ws";
import pkg from "agora-token";
import axios from "axios";
import base64 from "base-64";
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import userRoutes from './routes/userRoutes.js';

import path from "path";
import { fileURLToPath } from "url";

const AGORA_CUSTOMER_ID = "c137f53594a64eae92d22e6e7c519282"; // Developer Toolkit - Restful API b958d7372e2f47219ec13860c4c91d24
const AGORA_CUSTOMER_SECRET = "165652a0079943ed8cb7242159d36e75"; //Developer Toolkit - Restful API cab20702caee4f7eb3e5e2ad36353564

const { RtcTokenBuilder, RtcRole } = pkg;

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.text());

// Fix __dirname issue with ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Serve React static files ---
const reactBuildPath = path.join(__dirname, "client", "dist"); // or "build"
app.use(express.static(reactBuildPath));

const APP_ID = "eaf68a6a6a0c4786a8df44957469031c"; //Agora Project App ID 53cb0bf2c9fe4e1196cd97b456f57122
const APP_CERTIFICATE = "1ab076138ed14490ad0382744c3420bb"; // from Agora Console - Primary Certificate 57951c0e9f984f55a6b62045d4070ebe
const SDK_TOKEN = "NETLESSSDK_YWs9UzJsREtGbjZ4X0d2eURNZyZub25jZT0yMzRjYzRiMC0xZGY2LTExZjEtYjQ1Ni0wNTUwOWRkNTJhYmUmcm9sZT0wJnNpZz0wMmNmMjk5NjNmY2ExYzQ1ZDhhYTE5ODhiZmIwN2JjMzg4M2U1ZTNlMzVhMmQ1MjhjNDU5NGYyYWUzZjc1ODA5"; //Generate SDK Token [Interactive Whiteboard] NETLESSSDK_YWs9MjY3STBIZU96elloSlhHMiZub25jZT03NTk4NmUyMC03ZGIyLTExZjAtYjAyYS1iNzEwOGZjNTVhMjcmcm9sZT0wJnNpZz1lZTY5M2VmMWY1YTc5NWU3MTA0OWJiZTEzYWJmNmIyOTk5ZTM4YzRiMjgxZDE4YzAwYjk2ZTFjODFjYjdkYzJj
const REGION = "us-sv";
let rooms = [];
const chatRooms = new Map();

function digitsOnly(s = "") {
  return String(s).replace(/\D+/g, "");
}
function formatCode(d9) {
  const d = digitsOnly(d9).padStart(9, "0").slice(0,9);
  return `${d.slice(0,3)}-${d.slice(3,6)}-${d.slice(6,9)}`;
}
function generateUniqueMeetingCode() {
  let code;
  do {
    const n = Math.floor(100000000 + Math.random() * 900000000); 
    code = formatCode(String(n));
  } while (rooms.some(r => digitsOnly(r.meetingCode) === digitsOnly(code)));
  return code;
}

// List all rooms
app.get("/api/rooms", (req, res) => {
    console.log("GET /api/rooms hit");
  res.json(rooms.sort((a, b) => b.createdAt - a.createdAt));
});

//Get breakout rooms
app.get("/api/breakout-status", (req, res) => {
  const activeBreakouts = rooms
    .filter(r => r.currentBreakout)
    .map(room => {
      const detailedAssignments = {};

      Object.entries(room.currentBreakout.assignments).forEach(([subRoomName, uids]) => {
        detailedAssignments[subRoomName] = uids.map(uid => {
          const p = room.participants.find(part => String(part.uid) === String(uid));
          return {
            uid: uid,
            name: p ? p.name : "Left Room",
            role: p ? p.role : "Unknown"
          };
        });
      });

      return {
        mainRoomName: room.roomName,
        status: room.currentBreakout.status,
        active: room.currentBreakout.active,
        breakoutStartedAt: new Date(room.currentBreakout.startTime).toISOString(),
        breakoutEndedAt: room.currentBreakout.endTime ? new Date(room.currentBreakout.endTime).toISOString() : "Still Active",
        rooms: detailedAssignments
      };
    });
    res.json(activeBreakouts);
});

// Lookup username by uid + room
app.get("/api/username", (req, res) => {
  const { uid, roomName } = req.query;

  const mainRoomName = roomName.split('_')[0]; //mapping breakout room to main room
  
  const room = rooms.find(r => r.roomName === mainRoomName);
  if (!room) {
    console.log(`[Error] Room not found: ${mainRoomName} (from ${roomName})`);
    return res.status(404).json({ error: "Room not found" });
  }

  const participant = room.participants.find(p => String(p.uid) === String(uid));
  if (!participant) return res.status(404).json({ error: "User not found" });

  res.json({
    username: participant.name || null,
    gender:
      !participant.isScreen && participant.gender
        ? String(participant.gender).trim().toLowerCase()
        : null
  });
});

// Create a room
app.post("/api/rooms", async(req, res) => {
  const {
    roomName,
    createdBy,
    startDateTimeMsUtc,
    endDateTimeMsUtc,
    startDateTime,
    endDateTime,
    meetingCode
  } = req.body || {};

  if (!roomName) {
    return res.status(400).json({ error: "roomName required" });
  }

  let startMs;
  let endMs;

  if (typeof startDateTimeMsUtc === "number" && typeof endDateTimeMsUtc === "number") {
    startMs = startDateTimeMsUtc;
    endMs = endDateTimeMsUtc;
  } else if (startDateTime && endDateTime) {
    // try to parse legacy string inputs
    // e.g. "2025-10-25T18:30:00"
    const parsedStart = new Date(startDateTime).getTime();
    const parsedEnd = new Date(endDateTime).getTime();
    if (Number.isFinite(parsedStart) && Number.isFinite(parsedEnd)) {
      startMs = parsedStart;
      endMs = parsedEnd;
    }
  }

  if (
    typeof startMs !== "number" ||
    typeof endMs !== "number" ||
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs)
  ) {
    return res.status(400).json({
      error: "startDateTime and endDateTime required"
    });
  }

  if (rooms.find(r => r.roomName === roomName)) {
    return res.status(409).json({ error: "Room already exists" });
  }

  let finalCode = meetingCode ? formatCode(meetingCode) : generateUniqueMeetingCode();
  if (rooms.find(r => digitsOnly(r.meetingCode) === digitsOnly(finalCode))) {
    return res.status(409).json({ error: "Meeting code already in use" });
  }

  const start = startMs;
  const end = endMs;
  const now = Date.now();
  
  if (start < now - 60000) {
    return res.status(400).json({error: "Selected date/time is in the past. Please choose a future date/time"});
  }
  if (end <= start) {
    return res.status(400).json({ error: "End date and time must be after the start date and time" })
  }

  try {
    const roomRes = await axios.post(
      "https://api.netless.link/v5/rooms",
      { isRecord: false },
      {
        headers: {
          token: SDK_TOKEN,
          "Content-Type": "application/json",
          region: REGION,
        },
      }
    );

    const { uuid } = roomRes.data;
    console.log("Room UUID:", uuid);
    
    const lifespanMs = end - now;
    const expireSeconds = Math.floor(lifespanMs / 1000);
    
    const tokenRes = await axios.post(
      `https://api.netless.link/v5/tokens/rooms/${uuid}`,
      {
        lifespan: lifespanMs,
        role: "admin",
      },
      {
        headers: {
          token: SDK_TOKEN,
          "Content-Type": "application/json",
          region: REGION,
        },
      }
    );

    const roomToken = tokenRes.data;
    console.log("Room Token:", roomToken);

    const hostToken = crypto.randomUUID();

    const newRoom = {
      roomName,
      createdBy: createdBy || "Anonymous",
      createdAt: now,
      hostToken,
      // store canonical UTC ms timestamps
      startDateTime: start,
      endDateTime: end,
      participants: [],
      waiting: [],
      approved: [],
      declined: [],
      whiteboard: {
        uuid,
        token: roomToken,
        expiresAt: Date.now() + lifespanMs,
      },
      meetingCode: finalCode
    };
    rooms.push(newRoom);
    res.json({
      ok: true,
      hostToken,
      whiteboard: newRoom.whiteboard,
      scheduled: {
        startDateTimeMsUtc: start,
        endDateTimeMsUtc: end,
      },
      meetingCode: finalCode
    });
  } catch (err) {
    console.error("Error:", err.response?.data || err.message);
    res.status(500).json({ error: "Error creating room" });
  }
});

setInterval(() => {
  const now = Date.now();
  rooms = rooms.filter(r => r.endDateTime > now);
}, 60 * 1000);

// Get whiteboard info for a room
app.get("/api/rooms/:roomName/whiteboard", (req, res) => {
  const mainRoom = rooms.find(r => r.roomName === req.params.roomName);
  const breakoutName = req.query.breakout;
  if (!mainRoom) {
    return res.status(404).json({ error: "Room not found" });
  }
  if (breakoutName && mainRoom.currentBreakout?.whiteboards?.[breakoutName]) {
    return res.json(mainRoom.currentBreakout.whiteboards[breakoutName]);
  }
  if (mainRoom.whiteboard) {
    return res.json(mainRoom.whiteboard);
  }
  res.status(404).json({ error: "Whiteboard not found" });
});

app.get("/api/meetingCode/new", (req, res) => {
  const code = generateUniqueMeetingCode();
  res.json({ meetingCode: code });
});

app.get("/api/roomByCode/:code", (req, res) => {
  const code = req.params.code || "";
  const norm = digitsOnly(code);
  const room = rooms.find(r => digitsOnly(r.meetingCode) === norm);
  if (!room) return res.status(404).json({ error: "Invalid meeting code" });
  res.json({ roomName: room.roomName });
});

//Check meeting time without adding participants
app.post("/api/tokenCheck", (req, res) => {
  const { roomName } = req.body || {};
  if (!roomName) return res.status(400).json({ error: "roomName required" });

  const room = rooms.find(r => r.roomName === roomName);
  if (!room) return res.status(404).json({ error: "Room not found" });

  const now = Date.now();

  if (now < room.startDateTime  && req.body.role !== "employee") {
    // Send back UTC ms. Client will localize.
    return res.status(403).json({
      error: "Meeting not started yet",
      startDateTime: room.startDateTime,
    });
  }

  if (now > room.endDateTime) {
    return res.status(403).json({ 
      error: "Meeting has already ended.",
      endDateTime: room.endDateTime,
    });
  }

  // Meeting is active
  return res.json({ ok: true, message: "Meeting has started" });
});

// Generate a RTC token
app.post("/api/token", (req, res) => {
  const { roomName, uid, userName, role, isScreen, gender , hostToken} = req.body || {};

  if (!roomName) {
    return res.status(400).json({ error: "roomName required" });
  }

  const isBreakout = roomName.endsWith("_breakout");
  const mainRoomName = isBreakout ? roomName.split('_')[0] : roomName;

  let room = rooms.find((r) => r.roomName === mainRoomName);

  if (!room && !isBreakout) {
    return res.status(404).json({ error: "Room not found" });
  }

  if (room) {
    const nowMs = Date.now();
    if (nowMs < room.startDateTime && role !== "employee" && role !== "client") {
      return res.status(403).json({
        error: "Meeting not started yet",
        startDateTime: room.startDateTime,
      });
    }
    if (nowMs > room.endDateTime) {
      return res.status(403).json({ error: "Meeting has already ended." });
    }
  }

  // Choose uid (screen shares always get a fresh uid)
  let uidNum;
  if (isScreen) {
    uidNum = Math.floor(Math.random() * 1_000_000_000);
  } else {
    uidNum =
      Number.isInteger(uid) && uid > 0
        ? uid
        : Math.floor(Math.random() * 1_000_000_000);
  }
  if (room) {
      room.approved = room.approved || [];
      room.participants = room.participants || [];
      const approvedUser = room.approved.find(
        u => String(u.uid) === String(uidNum)
      );
  }

  const agoraRole = RtcRole.PUBLISHER;

  // Normalize gender once (only for non-screen users, only if provided & non-empty)
  const normalizedGender =
    !isScreen &&
    typeof gender !== "undefined" &&
    gender !== null &&
    String(gender).trim() !== ""
      ? String(gender).trim().toLowerCase()
      : null;

  const expireSeconds = 60 * 60 * 24; // 24 hours
  const now = Math.floor(Date.now() / 1000);
  const privilegeExpiredTs = now + expireSeconds;

  const token = RtcTokenBuilder.buildTokenWithUid(
    APP_ID,
    APP_CERTIFICATE,
    roomName,
    uidNum,
    agoraRole,
    privilegeExpiredTs
  );

  // Upsert participant; never overwrite an existing gender with null/undefined.
  if (room && userName) {
    const existing = room.participants.find(
      p => String(p.uid) === String(uidNum)
    );

    if (existing) {
      existing.name = userName;
      existing.role = role || existing.role || "client";
      if (typeof isScreen !== "undefined") {
        existing.isScreen = !!isScreen;
      }
      if (!isScreen && normalizedGender) {
        existing.gender = normalizedGender;
      }
      existing.approved = true;
      existing.token = token;
    } else {
      room.participants.push({
        uid: uidNum,
        name: userName || approvedUser?.name,
        role: role || approvedUser?.role || "client",
        isScreen: !!isScreen,
        gender: !isScreen ? normalizedGender : null,
        // approved: true,
        // token,
      });
    }
  }

  const stored = room ? (room.participants || []).find(
    (p) => String(p.uid) === String(uidNum)
  ) : null;
  const isHost = room && hostToken === room.hostToken;

  res.json({
    appId: APP_ID,
    token,
    roomName,
    uid: uidNum,
    userName: userName || null,
    isHost: !!isHost,
    //host: isHost ? "host" : "non-host",
    role: role || "client",
    isScreen: !!isScreen,
    // Always reflect the canonical stored gender (or null)
    gender:
      stored && !stored.isScreen && stored.gender
        ? String(stored.gender).trim().toLowerCase()
        : null,
    expiresAt: privilegeExpiredTs,
  });
  if (room && approvedUser) {
    room.approved = room.approved.filter(
      u => String(u.uid) !== String(uidNum)
    );
  }
});

// Fetch room details for checking if Client can join or not
app.post("/api/roomDetails", async (req, res) => {
  const { roomName, role } = req.body;
  const room = rooms.find(r => r.roomName === roomName);
  if (!room) {
    return res.status(404).json({ error: "Room not found" });
  }
  const participants = room.participants || [];
  const now = Date.now();
  if (now < room.startDateTime && role !== "employee") {
    return res.status(403).json({
      error: "Meeting not started yet",
      startDateTime: room.startDateTime,
      endDateTime: room.endDateTime,
      participants,
      participantCount: participants.length,
    });
  }
  if (now > room.endDateTime) {
    return res.status(403).json({ 
      error: "Meeting has already ended.",
      endDateTime: room.endDateTime,
    });
  }
  res.json({
    roomName: room.roomName,
    startDateTime: room.startDateTime,
    endDateTime: room.endDateTime,
    participants,
    participantCount: participants.length,
  });
});

// Fetch room details for Client Preview Page
app.post("/api/roomPreviewDetails", async (req, res) => {
  const { roomName, role } = req.body;
  const room = rooms.find(r => r.roomName === roomName);
  if (!room) {
    return res.status(404).json({ error: "Room not found" });
  }
  const now = Date.now();
  if (now > room.endDateTime) {
    return res.status(403).json({ 
      error: "Meeting has already ended.",
      endDateTime: room.endDateTime,
    });
  }
  const participants = room.participants || [];
  res.json({
    roomName: room.roomName,
    startDateTime: room.startDateTime,
    endDateTime: room.endDateTime,
    participants,
    participantCount: participants.length,
  });
});

// join request
app.post("/api/joinRequest", (req, res) => {
  const { roomName, userName, role } = req.body;
  if (!roomName || !userName) return res.status(400).json({ error: "missing fields" });

  const room = rooms.find(r => r.roomName === roomName);
  if (!room) return res.status(404).json({ error: "room not found" });

  const uidNum = Math.floor(Math.random() * 1_000_000_000);

  if (!room.waiting) room.waiting = [];
  room.waiting.push({ uid: uidNum, name: userName, role: role || "client" });

  res.json({ uid: uidNum, status: "waiting" });
});

// employees poll waiting list
app.get("/api/waiting/:roomName", (req, res) => {
  const room = rooms.find(r => r.roomName === req.params.roomName);
  if (!room) return res.json([]);

  const now = Date.now();
  if (now >= room.startDateTime) {
    // console.log(`Clearing waiting list - Meeting start time reached.`);
    room.waiting = [];
  }
  res.json(room.waiting || []);
});

// approve: generate token, move from waiting to participants
app.post("/api/approve", (req, res) => {
  const { roomName, uid } = req.body;
  const room = rooms.find(r => r.roomName === roomName);
  if (!room) return res.status(404).json({ error: "room not found" });

  room.waiting = room.waiting || [];
  room.approved = room.approved || [];
  const idx = room.waiting.findIndex(u => String(u.uid) === String(uid));
  if (idx === -1) return res.status(404).json({ error: "user not found in waiting" });

  const user = room.waiting.splice(idx, 1)[0];

  const expireSeconds = 60 * 60;
  const now = Math.floor(Date.now() / 1000);
  const token = RtcTokenBuilder.buildTokenWithUid(
    APP_ID,
    APP_CERTIFICATE,
    roomName,
    user.uid,
    RtcRole.PUBLISHER,
    now + expireSeconds
  );
  room.approved.push({
    uid: user.uid,
    name: user.name,
    role: user.role,
    token
  });

  res.json({
    approved: true,
    appId: APP_ID,
    roomName,
    uid: user.uid,
    userName: user.name,
    role: user.role,
    token,
  });
});

// decline
app.post("/api/decline", (req, res) => {
  const { roomName, uid } = req.body;
  const room = rooms.find(r => r.roomName === roomName);
  if (!room) return res.status(404).json({ error: "room not found" });
  room.waiting = room.waiting || [];
  room.declined = room.declined || [];

  room.waiting = room.waiting.filter(u => String(u.uid) !== String(uid));
  room.declined.push(String(uid));
  res.json({ declined: true });
});

// client polls for approval result
app.get("/api/checkApproval/:roomName/:uid", (req, res) => {
  const { roomName, uid } = req.params;
  const room = rooms.find(r => r.roomName === roomName);
  if (!room) return res.json({ approved: false });

  // check if approved
  const approvedUser = (room.approved || []).find(
    u => String(u.uid) === String(uid)
  );
  if (approvedUser) {
    res.json({
      approved: true,
      appId: APP_ID,
      token: approvedUser.token,
      roomName,
      uid: approvedUser.uid,
      userName: approvedUser.name,
      role: approvedUser.role
    });
  }

  // check if declined
  const isDeclined = (room.declined || []).includes(String(uid));
  if (isDeclined) {
    return res.json({ approved: false, declined: true});
  }

  // otherwise, still waiting
  res.json({ approved: false, declined: false })
});

app.post("/api/leaveWaiting", (req, res) => {
  const { roomName, uid } = req.body;
  
  const room = rooms.find(r => r.roomName === roomName);
  if (!room) return res.status(404).json({ error: "Room not found" });

  // Filter out the user from the waiting array
  if (room.waiting) {
    const initialCount = room.waiting.length;
    room.waiting = room.waiting.filter(u => String(u.uid) !== String(uid));
    
    if (room.waiting.length < initialCount) {
      console.log(`User ${uid} removed from waiting list in room ${roomName}`);
    }
  }

  res.json({ ok: true });
});

async function getAgoraAccessToken() {
  const credentials = base64.encode(`${AGORA_CUSTOMER_ID}:${AGORA_CUSTOMER_SECRET}`)

  const res = await axios.post(
    "https://api.agora.io/v1/token",
    {},
    {
      headers: {
        Authorization: `Basic ${credentials}`,
      },
    }
  );
  return res.data.accessToken;
}

let muteOrders = {};

app.post("/api/moderate/mute", (req, res) => {
  const {roomName, targetUid} = req.body;
  if (!muteOrders[roomName]) muteOrders[roomName] = new Set();
  muteOrders[roomName].add(String(targetUid));
  res.json({ok: true});
});

app.get("/api/checkMute/:roomName/:uid", (req, res) => {
  const {roomName, uid} = req.params;
  const muted = muteOrders[roomName]?.has(String(uid));

  if(muted){
    muteOrders[roomName].delete(String(uid));
  }
  res.json({muted: !!muted});
});

app.post("/api/moderate/kick", async(req, res) => {
  const {roomName, targetUid} = req.body;
  try{
    const credentials = base64.encode(`${AGORA_CUSTOMER_ID}:${AGORA_CUSTOMER_SECRET}`)

    const response = await axios.post(
      "https://api.agora.io/dev/v1/kicking-rule",
      {
        appid: APP_ID,
        cname: roomName,
        uid: String(targetUid),
        time: 60,
        privilege: "kick"
      },
      {
        headers: {
          Authorization: `Basic ${credentials}`,
          "Content-Type": "application/json",
        },
      }
    );

    res.json({ok: true, data: response.data});
  } catch(err) {
    console.error("Kick error:", err.response?.data || err.message);
    res.status(500).json({error: "Failed to kick user"});
  }
});

app.post("/api/leave", (req, res) => {
  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (e) {
      return res.status(400).json({error: 'Invalid JSON payload'});
    }
  }

  const {roomName, uid} = body;
  const roomIndex = rooms.findIndex(r => r.roomName === roomName);
  if (roomIndex === -1) return res.status(400).json({error: "Room not found"});

  const room = rooms[roomIndex];
  
  //Remove participant
  room.participants = (room.participants || []).filter(
    p => String(p.uid) !== String(uid)
  );

  //Remove from waiting list
  room.waiting = (room.waiting|| []).filter(
    p => String(p.uid) !== String(uid)
  );

  //Decide if any normal (non-screen) participants remain
  const remaining = room.participants || [];
  const normalParticipants = remaining.filter(p => {
    if(typeof p.isScreen !== 'undefined') return !p.isScreen;
    return !(p.name && p.name.startsWith("Screen-"));
  });

  console.log(`User ${uid} left room ${roomName}`);
  res.json({ok: true});
})

// --- All other routes -> React app ---
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api')) {
    return res.sendFile(path.join(reactBuildPath, 'index.html'));
  }
  next();
});

const PORT = process.env.PORT || 5000;

const server = http.createServer(app);

const wss = new WebSocketServer({ server, path: "/ws" });

function markAlive() {
  this.isAlive = true;
}

// Ping all clients every 0.9s to keep tunnel alive
const HEARTBEAT_MS = 900;
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    // If last pong not received -> kill
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch (_) {}
      return;
    }

    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  });
}, HEARTBEAT_MS);

wss.on("close", () => {
  clearInterval(heartbeatInterval);
});

wss.on("connection", (ws, req) => {
  try {
    // Heartbeat flags
    ws.isAlive = true;
    ws.on("pong", markAlive);

    const url = new URL(req.url, `http://${req.headers.host}`);
    const roomName = url.searchParams.get("roomName");
    const userName = url.searchParams.get("userName") || "Anonymous";
    const uid = url.searchParams.get("uid");

    if (!roomName) {
      ws.close(1008, "roomName is required");
      return;
    }

    const room = rooms.find((r) => r.roomName === roomName);
    if (!room) {
      ws.close(1008, "Room not found");
      return;
    }

    ws.roomName = roomName;
    ws.userName = userName;
    ws.uid = uid;

    try {
      ws.send(JSON.stringify({ type: "system", status: "connected", ts: Date.now() }));
    } catch (_) {}

    console.log(
      `[WS] New connection → room="${roomName}", user="${userName}"`
    );

    let set = chatRooms.get(roomName);
    if (!set) {
      set = new Set();
      chatRooms.set(roomName, set);
    }
    set.add(ws);

    // Incoming messages from this client
    ws.on("message", async (data) => {
      let payload;
      try {
        payload = JSON.parse(data.toString());
      } catch (e) {
        return;
      }

      // Allow lightweight heartbeat from client
      if (payload?.type === "ping") {
        try {
          ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
        } catch (_) {}
        return;
      }

      if (payload.type === "chat" && payload.text) {
        const targetRoom = payload.roomName || roomName;
        const message = {
          type: "chat",
          roomName: targetRoom,
          userName,
          text: String(payload.text),
          ts: Date.now(),
        };
        broadcastToSpecificRoom(roomName, targetRoom, message);
      }
      else if (payload.type === "trigger_breakout") {
        const room = rooms.find(r => r.roomName === roomName);
        if (room) {
          room.currentBreakout = {
            active: true,
            status: "IN_PROGRESS",
            startTime: Date.now(),
            endTime: null,
            assignments: payload.assignments,
            whiteboards: {}
          };
          const breakoutRoomNames = Object.keys(payload.assignments);
          await Promise.all(breakoutRoomNames.map(async (subName) => {
            try {
              const roomRes = await axios.post(
                "https://api.netless.link/v5/rooms",
                { isRecord: false },
                { headers: { token: SDK_TOKEN, "Content-Type": "application/json", region: REGION } }
              );

              const { uuid } = roomRes.data;
              const parentEnd = Number(room.endDateTime);
              const now = Date.now();
              const lifespanMs = Math.max(parentEnd - now, 3600000); // at least 1 hour

              const tokenRes = await axios.post(
                `https://api.netless.link/v5/tokens/rooms/${uuid}`,
                { lifespan: lifespanMs, role: "admin" },
                { headers: { token: SDK_TOKEN, "Content-Type": "application/json", region: REGION } }
              );

              room.currentBreakout.whiteboards[subName] = {
                uuid,
                token: tokenRes.data,
                expiresAt: now + lifespanMs,
              };
              // rooms.push({
              //   roomName: uniqueSubRoomName,
              //   isBreakout: true, // flag to identify it
              //   parentRoom: roomName,
              //   createdAt: now,
              //   startDateTime: room.startDateTime,
              //   endDateTime: room.endDateTime,
              //   whiteboard: {
              //     uuid,
              //     token: tokenRes.data,
              //     expiresAt: now + lifespanMs,
              //   }
              // });
              console.log(`[Whiteboard] Created for breakout: ${subName}`);
            } catch (err) {
              console.error(`Failed to create whiteboard for ${subName}:`, err.message);
            }
          })).then(() => {
            const breakoutCommand = {
              type: "BREAKOUT_START",
              assignments: payload.assignments,
              triggeredBy: payload.uid,
            };
            broadcastToRoom(roomName, breakoutCommand);
          });
        }
        // const breakoutCommand = {
        //   type: "BREAKOUT_START",
        //   assignments: payload.assignments,
        //   triggeredBy: payload.uid,
        // };
        // console.log(`[WS] Room ${roomName} starting breakout.`);
        // broadcastToRoom(roomName, breakoutCommand);
      }
      else if (payload.type === "trigger_move_to_breakout") {
        const {targetUid, breakoutRoomName} = payload;

        const room = rooms.find(r => r.roomName === roomName);
        if (room && room.currentBreakout) {
          Object.keys(room.currentBreakout.assignments).forEach(rName => {
            room.currentBreakout.assignments[rName] = room.currentBreakout.assignments[rName].filter(uid => String(uid) !== String(targetUid));
          });

          if (!room.currentBreakout.assignments[breakoutRoomName]) {
            room.currentBreakout.assignments[breakoutRoomName] = [];
          }
          if (!room.currentBreakout.assignments[breakoutRoomName].includes(Number(targetUid))) {
              room.currentBreakout.assignments[breakoutRoomName].push(Number(targetUid));
          }

          const allAssigned = Object.values(room.currentBreakout.assignments).flat();
          const updatedRoomUids = room.currentBreakout.assignments[breakoutRoomName];
          console.log(`[WS] Moving user ${targetUid} to breakout room ${breakoutRoomName} in room ${roomName}. Assigned users in that breakout: ${updatedRoomUids.join(", ")}`);
          
          const moveCommand = {
            type: "MOVE_TO_BREAKOUT",
            breakoutRoomName: breakoutRoomName,
            allRoomUids: room.currentBreakout.assignments[breakoutRoomName]
          };
          
          const hostNotice = {
            type: "USER_MOVED_TO_BREAKOUT",
            uid: targetUid,
            breakoutRoomName: breakoutRoomName,
            allAssignedUids: allAssigned
          };
          
          const syncNotice = {
            type: "BREAKOUT_USER_ADDED",
            uid: targetUid,
            breakoutRoomName: breakoutRoomName,
            allRoomUids: updatedRoomUids
          }
          
          const clients = chatRooms.get(roomName) || new Set();
          for (const client of clients) {
            if (client.readyState !== client.OPEN) continue;

            const clientUid = Number(client.uid);
            const targetUidNum = Number(targetUid);

            if (clientUid === targetUidNum) {
              client.send(JSON.stringify(moveCommand));
            } else if (allAssigned.includes(clientUid)) {
              console.log(`[WS] Notifying user ${client.uid} about new breakout assignment to ${breakoutRoomName}`);
              client.send(JSON.stringify(syncNotice));
            } else {
              client.send(JSON.stringify(hostNotice));
            }
          }
        }
      }
      else if (payload.type === "trigger_unassign_user") {
        const {targetUid} = payload;
        const room = rooms.find(r => r.roomName === roomName);

        if (room && room.currentBreakout) {
          Object.keys(room.currentBreakout.assignments).forEach(rName => {
            room.currentBreakout.assignments[rName] = room.currentBreakout.assignments[rName].filter(uid => String(uid) !== String(targetUid));
          });

          const allAssigned = Object.values(room.currentBreakout.assignments).flat();
          const returnCommand = {
            type: "UNASSIGN_FROM_BREAKOUT",
            allAssignedUids: allAssigned
          };

          const updateNotice = {
            type: "USER_UNASSIGNED",
            uid: targetUid,
            allAssignedUids: allAssigned
          };

          const clients = chatRooms.get(roomName) || new Set();
          for (const client of clients) {
            if (client.readyState !== client.OPEN) continue;
            if (Number(client.uid) === Number(targetUid)) {
              client.send(JSON.stringify(returnCommand));
            } else {
              client.send(JSON.stringify(updateNotice));
            }
          }
        }
      }
      else if (payload.type === "trigger_end_breakout") {
        const room = rooms.find(r => r.roomName === roomName);
        if (room) {
          // room.currentBreakout = null;
          if (room.currentBreakout) {
            room.currentBreakout.active = false;
            room.currentBreakout.status = "ENDED";
            room.currentBreakout.endTime = Date.now();
          }
        }
        const endCommand = {
          type: "BREAKOUT_STOP"
        };
        console.log(`[WS] Room ${roomName} ending breakout`);
        broadcastToRoom(roomName, endCommand);
      }
      else if (payload.type === "sync_room") {
        ws.currentSubRoom = payload.currentRoom;
        console.log(`[WS] Sync: ${userName} is now in ${payload.currentRoom}`);
      }
    });

    function broadcastToSpecificRoom(mainRoomName, targetSubRoom, msgObj) {
      const clients = chatRooms.get(mainRoomName) || new Set();
      const stringified = JSON.stringify(msgObj);

      for (const client of clients) {
        if (client.readyState !== client.OPEN) continue;

        if (client.currentSubRoom === targetSubRoom) {
          client.send(stringified);
        }
      }
    }

    function broadcastToRoom(targetRoom, msgObj) {
      // Broadcast to everyone in the same room only
      const clients = chatRooms.get(targetRoom) || new Set();
      const stringified = JSON.stringify(msgObj);
      for (const client of clients) {
        if (client.readyState === client.OPEN) {
          client.send(stringified);
        }
      }
    }

    ws.on("close", () => {
      const set = chatRooms.get(ws.roomName);
      if (!set) return;
      set.delete(ws);
      if (set.size === 0) {
        chatRooms.delete(ws.roomName);
      }
      try { ws.terminate(); } catch (_) {}
    });
  } catch (err) {
    console.error("WebSocket connection error:", err);
    try {
      ws.close(1011, "Unexpected error");
    } catch (_) {}
  }
});

const MONGO_URI = process.env.MONGO_URI;

mongoose.connect(MONGO_URI)
.then(() => console.log("MongoDB Connected"))
.catch((err) => console.log("MongoDB Connection Error: ", err));

app.use("/api/users", userRoutes);

server.listen(PORT, () => {
  console.log(`Backend + WebSocket running on port ${PORT}`);
});