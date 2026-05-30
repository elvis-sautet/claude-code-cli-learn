/**
 * A small Google Meet-style app built on raw WebRTC.
 *
 * - Pre-join screen with camera preview + device pickers.
 * - Mesh of RTCPeerConnections (every peer connects to every other peer).
 * - A Node WebSocket server (server.mjs) only relays SDP/ICE; media is P2P.
 * - In-call chat travels over a per-peer RTCDataChannel.
 */

// ---------------------------------------------------------------------------
// Signaling message types
// ---------------------------------------------------------------------------
interface PeerInfo {
  peerId: string;
  name: string;
}

type SignalPayload =
  | { kind: "offer"; sdp: RTCSessionDescriptionInit }
  | { kind: "answer"; sdp: RTCSessionDescriptionInit }
  | { kind: "candidate"; candidate: RTCIceCandidateInit };

type ServerMessage =
  | { type: "welcome"; peerId: string; peers: PeerInfo[] }
  | { type: "peer-joined"; peerId: string; name: string }
  | { type: "peer-left"; peerId: string }
  | { type: "signal"; from: string; data: SignalPayload };

// Messages sent over the data channel (chat + presence state).
type DataMessage =
  | { t: "chat"; text: string }
  | { t: "state"; name: string; mic: boolean; cam: boolean };

interface Peer {
  pc: RTCPeerConnection;
  videoSender: RTCRtpSender | null;
  dc: RTCDataChannel | null;
  name: string;
  tile: HTMLDivElement;
  video: HTMLVideoElement;
  haveRemote: boolean;
  pendingCandidates: RTCIceCandidateInit[];
}

const ICE: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------
function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing required element #${id}`);
  return node as T;
}

function setPressed(button: HTMLElement, on: boolean, onIcon: string, offIcon: string): void {
  button.setAttribute("aria-pressed", String(on));
  button.querySelector("iconify-icon")?.setAttribute("icon", on ? onIcon : offIcon);
}

// Pre-join
const prejoin = el<HTMLElement>("prejoin");
const previewVideo = el<HTMLVideoElement>("preview-video");
const previewOff = el<HTMLParagraphElement>("preview-off");
const pjMic = el<HTMLButtonElement>("pj-mic");
const pjCam = el<HTMLButtonElement>("pj-cam");
const micSelect = el<HTMLSelectElement>("mic-select");
const camSelect = el<HTMLSelectElement>("cam-select");
const nameInput = el<HTMLInputElement>("name-input");
const roomInput = el<HTMLInputElement>("room-input");
const copyLinkBtn = el<HTMLButtonElement>("copy-link");
const joinBtn = el<HTMLButtonElement>("join-btn");
const prejoinStatus = el<HTMLParagraphElement>("prejoin-status");

// Meeting
const meeting = el<HTMLElement>("meeting");
const grid = el<HTMLDivElement>("grid");
const roomLabel = el<HTMLSpanElement>("room-label");
const mMic = el<HTMLButtonElement>("m-mic");
const mCam = el<HTMLButtonElement>("m-cam");
const mShare = el<HTMLButtonElement>("m-share");
const mChat = el<HTMLButtonElement>("m-chat");
const mLeave = el<HTMLButtonElement>("m-leave");
const mCopy = el<HTMLButtonElement>("m-copy");

// Chat
const chat = el<HTMLElement>("chat");
const chatClose = el<HTMLButtonElement>("chat-close");
const chatLog = el<HTMLDivElement>("chat-log");
const chatForm = el<HTMLFormElement>("chat-form");
const chatInput = el<HTMLInputElement>("chat-input");

const toast = el<HTMLDivElement>("toast");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let localStream: MediaStream | null = null;
let cameraTrack: MediaStreamTrack | null = null;
let screenStream: MediaStream | null = null;
let ws: WebSocket | null = null;
let myName = "Guest";
let micOn = true;
let camOn = true;
const peers = new Map<string, Peer>();
const pendingNames = new Map<string, string>();
let selfVideo: HTMLVideoElement | null = null;
let selfTile: HTMLDivElement | null = null;
let toastTimer: number | undefined;

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------
function setStatus(message: string, isError = false): void {
  prejoinStatus.textContent = message;
  prejoinStatus.classList.toggle("error", isError);
}

function showToast(message: string): void {
  toast.textContent = "";
  const icon = document.createElement("iconify-icon");
  icon.setAttribute("icon", "mdi:check-circle");
  toast.append(icon, document.createTextNode(" " + message));
  toast.hidden = false;
  toast.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("show"), 2000);
}

// ---------------------------------------------------------------------------
// Media + devices
// ---------------------------------------------------------------------------
async function startPreview(): Promise<void> {
  try {
    setStatus("Requesting camera & microphone…");
    stopStream(localStream);
    localStream = await navigator.mediaDevices.getUserMedia({
      video: camSelect.value ? { deviceId: { exact: camSelect.value } } : true,
      audio: micSelect.value ? { deviceId: { exact: micSelect.value } } : true,
    });
    cameraTrack = localStream.getVideoTracks()[0] ?? null;
    applyTrackState();
    previewVideo.srcObject = localStream;
    await populateDevices();
    setStatus("");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    setStatus(`Could not access camera/mic: ${reason}`, true);
  }
}

function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((t) => t.stop());
}

function applyTrackState(): void {
  const v = localStream?.getVideoTracks()[0];
  const a = localStream?.getAudioTracks()[0];
  if (v) v.enabled = camOn;
  if (a) a.enabled = micOn;
  previewOff.hidden = camOn;
  previewVideo.style.visibility = camOn ? "visible" : "hidden";
  setPressed(pjMic, micOn, "mdi:microphone", "mdi:microphone-off");
  setPressed(pjCam, camOn, "mdi:video", "mdi:video-off");
}

async function populateDevices(): Promise<void> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  fillSelect(micSelect, devices, "audioinput", "microphone");
  fillSelect(camSelect, devices, "videoinput", "camera");
}

function fillSelect(
  select: HTMLSelectElement,
  devices: MediaDeviceInfo[],
  kind: MediaDeviceKind,
  label: string,
): void {
  const prev = select.value;
  const matching = devices.filter((d) => d.kind === kind);
  select.replaceChildren();
  select.add(new Option(`Default ${label}`, ""));
  matching.forEach((d, i) => select.add(new Option(d.label || `${label} ${i + 1}`, d.deviceId)));
  if (matching.some((d) => d.deviceId === prev)) select.value = prev;
}

// ---------------------------------------------------------------------------
// Room helpers
// ---------------------------------------------------------------------------
function slugify(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function randomRoom(): string {
  const words = ["sky", "river", "delta", "ember", "atlas", "lumen", "vela", "onyx"];
  const pick = () => words[Math.floor(Math.random() * words.length)];
  return `${pick()}-${pick()}-${Math.floor(Math.random() * 900 + 100)}`;
}

function meetingUrl(room: string): string {
  const url = new URL(window.location.href);
  url.searchParams.set("room", room);
  return url.toString();
}

async function copyLink(room: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(meetingUrl(room));
    showToast("Meeting link copied");
  } catch {
    showToast(meetingUrl(room));
  }
}

// ---------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------
function initials(name: string): string {
  return (name.trim()[0] || "?").toUpperCase();
}

function createTile(name: string, isSelf: boolean): { tile: HTMLDivElement; video: HTMLVideoElement } {
  const tile = document.createElement("div");
  tile.className = "tile" + (isSelf ? " self" : "");

  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  if (isSelf) video.muted = true;

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = initials(name);

  const nameTag = document.createElement("span");
  nameTag.className = "name";
  nameTag.textContent = isSelf ? `${name} (you)` : name;

  const micOff = document.createElement("span");
  micOff.className = "mic-off";
  const micIcon = document.createElement("iconify-icon");
  micIcon.setAttribute("icon", "mdi:microphone-off");
  micOff.append(micIcon);

  tile.append(video, avatar, nameTag, micOff);
  grid.append(tile);
  updateGridCount();
  return { tile, video };
}

function updateGridCount(): void {
  grid.dataset.count = String(grid.querySelectorAll(".tile").length);
}

function setTileState(tile: HTMLDivElement, cam: boolean, mic: boolean): void {
  tile.classList.toggle("video-on", cam);
  tile.classList.toggle("muted", !mic);
}

// ---------------------------------------------------------------------------
// Join / leave
// ---------------------------------------------------------------------------
async function join(): Promise<void> {
  if (!localStream) await startPreview();
  if (!localStream) return;

  myName = nameInput.value.trim() || "Guest";
  const room = slugify(roomInput.value) || randomRoom();
  roomInput.value = room;
  window.history.replaceState(null, "", meetingUrl(room));
  roomLabel.textContent = room;

  prejoin.hidden = true;
  meeting.hidden = false;

  // Self tile
  const self = createTile(myName, true);
  selfTile = self.tile;
  selfVideo = self.video;
  selfVideo.srcObject = localStream;
  setTileState(selfTile, camOn, micOn);
  setPressed(mMic, micOn, "mdi:microphone", "mdi:microphone-off");
  setPressed(mCam, camOn, "mdi:video", "mdi:video-off");

  connectSignaling(room);
}

function connectSignaling(room: string): void {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${scheme}://${window.location.host}/ws`);
  ws.addEventListener("open", () => {
    sendSignal({ type: "join", room, name: myName });
  });
  ws.addEventListener("message", (ev) => {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(ev.data as string) as ServerMessage;
    } catch {
      return;
    }
    void handleServerMessage(msg);
  });
}

function sendSignal(payload: Record<string, unknown>): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

async function handleServerMessage(msg: ServerMessage): Promise<void> {
  switch (msg.type) {
    case "welcome": {
      // We are the newcomer: initiate to everyone already here.
      for (const p of msg.peers) {
        pendingNames.set(p.peerId, p.name);
        ensurePeer(p.peerId, p.name, true);
        await makeOffer(p.peerId);
      }
      break;
    }
    case "peer-joined":
      pendingNames.set(msg.peerId, msg.name);
      break; // they will call us; we answer when their offer arrives
    case "peer-left":
      teardownPeer(msg.peerId);
      break;
    case "signal": {
      if (!peers.has(msg.from)) {
        ensurePeer(msg.from, pendingNames.get(msg.from) ?? "Guest", false);
      }
      await handleSignal(msg.from, msg.data);
      break;
    }
  }
}

function ensurePeer(peerId: string, name: string, initiator: boolean): Peer {
  const existing = peers.get(peerId);
  if (existing) return existing;

  const pc = new RTCPeerConnection(ICE);
  const { tile, video } = createTile(name, false);
  const peer: Peer = {
    pc,
    videoSender: null,
    dc: null,
    name,
    tile,
    video,
    haveRemote: false,
    pendingCandidates: [],
  };
  peers.set(peerId, peer);

  if (localStream) {
    for (const track of localStream.getTracks()) {
      const sender = pc.addTrack(track, localStream);
      if (track.kind === "video") peer.videoSender = sender;
    }
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) sendSignal({ type: "signal", to: peerId, data: { kind: "candidate", candidate: e.candidate.toJSON() } });
  };
  pc.ontrack = (e) => {
    peer.video.srcObject = e.streams[0] ?? null;
    peer.tile.classList.add("video-on");
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed" || pc.connectionState === "closed") teardownPeer(peerId);
  };

  if (initiator) {
    const dc = pc.createDataChannel("chat");
    setupDataChannel(peerId, dc);
  } else {
    pc.ondatachannel = (e) => setupDataChannel(peerId, e.channel);
  }
  return peer;
}

async function makeOffer(peerId: string): Promise<void> {
  const peer = peers.get(peerId);
  if (!peer) return;
  const offer = await peer.pc.createOffer();
  await peer.pc.setLocalDescription(offer);
  sendSignal({ type: "signal", to: peerId, data: { kind: "offer", sdp: peer.pc.localDescription! } });
}

async function handleSignal(from: string, data: SignalPayload): Promise<void> {
  const peer = peers.get(from);
  if (!peer) return;
  if (data.kind === "offer") {
    await peer.pc.setRemoteDescription(data.sdp);
    peer.haveRemote = true;
    await flushCandidates(peer);
    const answer = await peer.pc.createAnswer();
    await peer.pc.setLocalDescription(answer);
    sendSignal({ type: "signal", to: from, data: { kind: "answer", sdp: peer.pc.localDescription! } });
  } else if (data.kind === "answer") {
    await peer.pc.setRemoteDescription(data.sdp);
    peer.haveRemote = true;
    await flushCandidates(peer);
  } else {
    if (peer.haveRemote) await peer.pc.addIceCandidate(data.candidate);
    else peer.pendingCandidates.push(data.candidate);
  }
}

async function flushCandidates(peer: Peer): Promise<void> {
  for (const c of peer.pendingCandidates) await peer.pc.addIceCandidate(c);
  peer.pendingCandidates = [];
}

function teardownPeer(peerId: string): void {
  const peer = peers.get(peerId);
  if (!peer) return;
  peer.dc?.close();
  peer.pc.close();
  peer.tile.remove();
  peers.delete(peerId);
  updateGridCount();
}

// ---------------------------------------------------------------------------
// Data channel (chat + presence)
// ---------------------------------------------------------------------------
function setupDataChannel(peerId: string, dc: RTCDataChannel): void {
  const peer = peers.get(peerId);
  if (!peer) return;
  peer.dc = dc;
  dc.onopen = () => sendState(dc);
  dc.onmessage = (e) => handleData(peerId, e.data as string);
}

function handleData(peerId: string, raw: string): void {
  let msg: DataMessage;
  try {
    msg = JSON.parse(raw) as DataMessage;
  } catch {
    return;
  }
  const peer = peers.get(peerId);
  if (!peer) return;
  if (msg.t === "chat") {
    addChatMessage(peer.name, msg.text, false);
  } else {
    peer.name = msg.name;
    const tag = peer.tile.querySelector(".name");
    if (tag) tag.textContent = msg.name;
    setTileState(peer.tile, msg.cam, msg.mic);
  }
}

function sendState(dc: RTCDataChannel): void {
  if (dc.readyState === "open") {
    const state: DataMessage = { t: "state", name: myName, mic: micOn, cam: camOn };
    dc.send(JSON.stringify(state));
  }
}

function broadcastState(): void {
  for (const peer of peers.values()) if (peer.dc) sendState(peer.dc);
}

// ---------------------------------------------------------------------------
// Chat UI
// ---------------------------------------------------------------------------
function addChatMessage(from: string, text: string, isSelf: boolean): void {
  const msg = document.createElement("div");
  msg.className = "msg" + (isSelf ? " self" : "");
  const who = document.createElement("div");
  who.className = "msg-from";
  who.textContent = isSelf ? "You" : from;
  const body = document.createElement("div");
  body.className = "msg-body";
  body.textContent = text;
  msg.append(who, body);
  chatLog.append(msg);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function sendChat(text: string): void {
  const payload: DataMessage = { t: "chat", text };
  for (const peer of peers.values()) {
    if (peer.dc && peer.dc.readyState === "open") peer.dc.send(JSON.stringify(payload));
  }
  addChatMessage(myName, text, true);
}

// ---------------------------------------------------------------------------
// In-call controls
// ---------------------------------------------------------------------------
function toggleMic(): void {
  micOn = !micOn;
  const a = localStream?.getAudioTracks()[0];
  if (a) a.enabled = micOn;
  setPressed(mMic, micOn, "mdi:microphone", "mdi:microphone-off");
  if (selfTile) setTileState(selfTile, camOn, micOn);
  broadcastState();
}

function toggleCam(): void {
  camOn = !camOn;
  const v = localStream?.getVideoTracks()[0];
  if (v) v.enabled = camOn;
  setPressed(mCam, camOn, "mdi:video", "mdi:video-off");
  if (selfTile) setTileState(selfTile, camOn, micOn);
  broadcastState();
}

async function toggleShare(): Promise<void> {
  if (screenStream) {
    stopShare();
    return;
  }
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const screenTrack = screenStream.getVideoTracks()[0];
    if (!screenTrack) return;
    for (const peer of peers.values()) await peer.videoSender?.replaceTrack(screenTrack);
    if (selfVideo) selfVideo.srcObject = screenStream;
    if (selfTile) selfTile.classList.add("video-on");
    setPressed(mShare, true, "mdi:monitor-share", "mdi:monitor-share");
    mShare.setAttribute("aria-pressed", "true");
    screenTrack.onended = () => stopShare();
  } catch {
    /* user cancelled the picker */
  }
}

function stopShare(): void {
  stopStream(screenStream);
  screenStream = null;
  for (const peer of peers.values()) {
    if (cameraTrack) void peer.videoSender?.replaceTrack(cameraTrack);
  }
  if (selfVideo) selfVideo.srcObject = localStream;
  mShare.setAttribute("aria-pressed", "false");
}

function leave(): void {
  for (const id of [...peers.keys()]) teardownPeer(id);
  ws?.close();
  ws = null;
  stopStream(screenStream);
  stopStream(localStream);
  localStream = null;
  screenStream = null;
  grid.replaceChildren();
  meeting.hidden = true;
  prejoin.hidden = false;
  setStatus("You left the meeting.");
}

// ---------------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------------
pjMic.addEventListener("click", () => {
  micOn = !micOn;
  applyTrackState();
});
pjCam.addEventListener("click", () => {
  camOn = !camOn;
  applyTrackState();
});
micSelect.addEventListener("change", () => void startPreview());
camSelect.addEventListener("change", () => void startPreview());
copyLinkBtn.addEventListener("click", () => void copyLink(slugify(roomInput.value) || randomRoom()));
joinBtn.addEventListener("click", () => void join());

mMic.addEventListener("click", toggleMic);
mCam.addEventListener("click", toggleCam);
mShare.addEventListener("click", () => void toggleShare());
mChat.addEventListener("click", () => {
  chat.hidden = !chat.hidden;
  mChat.setAttribute("aria-pressed", String(!chat.hidden));
  if (!chat.hidden) chatInput.focus();
});
chatClose.addEventListener("click", () => {
  chat.hidden = true;
  mChat.setAttribute("aria-pressed", "false");
});
mLeave.addEventListener("click", leave);
mCopy.addEventListener("click", () => void copyLink(roomLabel.textContent || randomRoom()));

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  sendChat(text);
  chatInput.value = "";
});

window.addEventListener("beforeunload", () => {
  ws?.close();
  stopStream(localStream);
  stopStream(screenStream);
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
function init(): void {
  const params = new URLSearchParams(window.location.search);
  roomInput.value = params.get("room") ?? randomRoom();
  void startPreview();
}

init();

export {};
