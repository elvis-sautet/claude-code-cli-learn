/**
 * Signaling + static server for the WebRTC meeting app.
 *
 * - Serves the static frontend (index.html, app.js, styles.css, ...).
 * - Exposes a WebSocket endpoint at /ws that relays SDP/ICE between peers
 *   and tracks room membership. It never sees media — that flows peer-to-peer.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT) || 5173;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

// ---------------------------------------------------------------------------
// Static file server
// ---------------------------------------------------------------------------
const httpServer = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
    const filePath = normalize(join(root, rel));
    if (!filePath.startsWith(root)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    const body = await readFile(filePath);
    res.writeHead(200, { "Content-Type": TYPES[extname(filePath)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
  }
});

// ---------------------------------------------------------------------------
// WebSocket signaling
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

/** roomId -> Map<peerId, { socket, name }> */
const rooms = new Map();

function send(socket, message) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

function peersInRoom(roomId, exceptId) {
  const room = rooms.get(roomId);
  if (!room) return [];
  return [...room.entries()]
    .filter(([id]) => id !== exceptId)
    .map(([id, info]) => ({ peerId: id, name: info.name }));
}

wss.on("connection", (socket) => {
  let peerId = randomUUID();
  let roomId = null;
  let name = "Guest";

  socket.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case "join": {
        roomId = String(msg.room || "lobby");
        name = String(msg.name || "Guest").slice(0, 60);
        if (!rooms.has(roomId)) rooms.set(roomId, new Map());
        const room = rooms.get(roomId);
        // Tell the newcomer who is already here, then announce them.
        send(socket, { type: "welcome", peerId, peers: peersInRoom(roomId, peerId) });
        for (const [, info] of room) {
          send(info.socket, { type: "peer-joined", peerId, name });
        }
        room.set(peerId, { socket, name });
        break;
      }

      case "signal": {
        // Relay an offer/answer/ICE candidate to a specific peer.
        const room = roomId && rooms.get(roomId);
        const target = room && room.get(msg.to);
        if (target) {
          send(target.socket, { type: "signal", from: peerId, data: msg.data });
        }
        break;
      }

      default:
        break;
    }
  });

  socket.on("close", () => {
    const room = roomId && rooms.get(roomId);
    if (!room) return;
    room.delete(peerId);
    for (const [, info] of room) {
      send(info.socket, { type: "peer-left", peerId });
    }
    if (room.size === 0) rooms.delete(roomId);
  });
});

httpServer.listen(port, () => {
  console.log(`Meeting app on http://localhost:${port}  (ws: /ws)`);
});
