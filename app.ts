/**
 * Camera + free Jitsi meetings — full-featured, type-safe frontend.
 *
 * Camera:   open/stop, device selection (camera & mic), toggle camera, toggle mic.
 * Meeting:  launch/join free Jitsi rooms, in-call mic/camera/screen-share toggles
 *           synced from Jitsi events, copy invite link, leave.
 */

// ---------------------------------------------------------------------------
// Jitsi external API typings — just the slice we use, so TS stays strict.
// ---------------------------------------------------------------------------
interface JitsiMeetExternalAPIOptions {
  roomName: string;
  width?: string | number;
  height?: string | number;
  parentNode?: HTMLElement;
  userInfo?: { displayName?: string };
  configOverwrite?: Record<string, unknown>;
  interfaceConfigOverwrite?: Record<string, unknown>;
}

interface JitsiMeetExternalAPIInstance {
  addEventListener(event: string, listener: (payload: unknown) => void): void;
  executeCommand(command: string, ...args: unknown[]): void;
  dispose(): void;
}

type JitsiMeetExternalAPIConstructor = new (
  domain: string,
  options: JitsiMeetExternalAPIOptions,
) => JitsiMeetExternalAPIInstance;

declare global {
  interface Window {
    JitsiMeetExternalAPI?: JitsiMeetExternalAPIConstructor;
  }
}

const JITSI_DOMAIN = "meet.jit.si";

// ---------------------------------------------------------------------------
// Typed DOM helpers — every lookup is checked, never assumed.
// ---------------------------------------------------------------------------
function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing required element #${id}`);
  return node as T;
}

function setButtonIcon(button: HTMLElement, icon: string): void {
  const iconEl = button.querySelector("iconify-icon");
  iconEl?.setAttribute("icon", icon);
}

/** Reflect a boolean "on" state onto an aria-pressed toggle button. */
function setToggle(
  button: HTMLButtonElement,
  on: boolean,
  cfg: { onIcon: string; offIcon: string; onLabel: string; offLabel: string },
): void {
  button.setAttribute("aria-pressed", String(on));
  setButtonIcon(button, on ? cfg.onIcon : cfg.offIcon);
  const label = on ? cfg.onLabel : cfg.offLabel;
  button.setAttribute("aria-label", label);
  button.title = label;
}

// Camera elements
const localVideo = el<HTMLVideoElement>("local-video");
const cameraPlaceholder = el<HTMLParagraphElement>("camera-placeholder");
const cameraBar = el<HTMLDivElement>("camera-bar");
const openCameraBtn = el<HTMLButtonElement>("open-camera");
const stopCameraBtn = el<HTMLButtonElement>("stop-camera");
const toggleCameraBtn = el<HTMLButtonElement>("toggle-camera");
const toggleMicBtn = el<HTMLButtonElement>("toggle-mic");
const statusEl = el<HTMLParagraphElement>("status");
const toggleSettingsBtn = el<HTMLButtonElement>("toggle-settings");
const settingsPanel = el<HTMLDivElement>("settings");
const cameraSelect = el<HTMLSelectElement>("camera-select");
const micSelect = el<HTMLSelectElement>("mic-select");

// Meeting elements
const displayNameInput = el<HTMLInputElement>("display-name");
const roomNameInput = el<HTMLInputElement>("room-name");
const randomRoomBtn = el<HTMLButtonElement>("random-room");
const launchMeetingBtn = el<HTMLButtonElement>("launch-meeting");
const copyLinkBtn = el<HTMLButtonElement>("copy-link");
const meetingSetup = el<HTMLDivElement>("meeting-setup");
const meetingControls = el<HTMLDivElement>("meeting-controls");
const meetingBadge = el<HTMLSpanElement>("meeting-badge");
const meetingContainer = el<HTMLDivElement>("meeting-container");
const mMic = el<HTMLButtonElement>("m-mic");
const mCam = el<HTMLButtonElement>("m-cam");
const mShare = el<HTMLButtonElement>("m-share");
const mCopy = el<HTMLButtonElement>("m-copy");
const leaveMeetingBtn = el<HTMLButtonElement>("leave-meeting");
const toast = el<HTMLDivElement>("toast");

let cameraStream: MediaStream | null = null;
let meeting: JitsiMeetExternalAPIInstance | null = null;
let currentRoom = "";
let toastTimer: number | undefined;

// ---------------------------------------------------------------------------
// Feedback helpers
// ---------------------------------------------------------------------------
function setStatus(message: string, isError = false): void {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function showToast(message: string): void {
  toast.textContent = "";
  const icon = document.createElement("iconify-icon");
  icon.setAttribute("icon", "mdi:check-circle");
  toast.append(icon, document.createTextNode(" " + message));
  toast.hidden = false;
  toast.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.classList.remove("show");
  }, 2000);
}

// ---------------------------------------------------------------------------
// Device enumeration
// ---------------------------------------------------------------------------
async function populateDevices(): Promise<void> {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  fillSelect(cameraSelect, devices, "videoinput", "Camera");
  fillSelect(micSelect, devices, "audioinput", "Microphone");
}

function fillSelect(
  select: HTMLSelectElement,
  devices: MediaDeviceInfo[],
  kind: MediaDeviceKind,
  fallbackLabel: string,
): void {
  const previous = select.value;
  const matching = devices.filter((d) => d.kind === kind);
  select.replaceChildren();
  const def = new Option(`Default ${fallbackLabel.toLowerCase()}`, "");
  select.add(def);
  matching.forEach((device, i) => {
    select.add(new Option(device.label || `${fallbackLabel} ${i + 1}`, device.deviceId));
  });
  if (matching.some((d) => d.deviceId === previous)) select.value = previous;
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------
function buildConstraints(): MediaStreamConstraints {
  const cam = cameraSelect.value;
  const mic = micSelect.value;
  return {
    video: cam ? { deviceId: { exact: cam } } : true,
    audio: mic ? { deviceId: { exact: mic } } : true,
  };
}

async function openCamera(): Promise<void> {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("This browser does not support camera access.", true);
    return;
  }
  try {
    setStatus("Requesting camera & microphone…");
    stopTracks(); // release any previous stream first
    cameraStream = await navigator.mediaDevices.getUserMedia(buildConstraints());
    localVideo.srcObject = cameraStream;
    localVideo.classList.add("active");
    cameraPlaceholder.style.display = "none";
    cameraBar.hidden = false;
    openCameraBtn.disabled = true;
    stopCameraBtn.disabled = false;
    syncCameraToggles();
    await populateDevices(); // labels are available now that permission is granted
    setStatus("Camera is live.");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    setStatus(`Could not open camera: ${reason}`, true);
  }
}

function stopTracks(): void {
  if (cameraStream) {
    for (const track of cameraStream.getTracks()) track.stop();
    cameraStream = null;
  }
}

function stopCamera(): void {
  stopTracks();
  localVideo.srcObject = null;
  localVideo.classList.remove("active");
  cameraPlaceholder.style.display = "";
  cameraBar.hidden = true;
  openCameraBtn.disabled = false;
  stopCameraBtn.disabled = true;
  setStatus("Camera stopped.");
}

function syncCameraToggles(): void {
  const videoOn = cameraStream?.getVideoTracks()[0]?.enabled ?? false;
  const audioOn = cameraStream?.getAudioTracks()[0]?.enabled ?? false;
  setToggle(toggleCameraBtn, videoOn, {
    onIcon: "mdi:camera", offIcon: "mdi:camera-off",
    onLabel: "Turn camera off", offLabel: "Turn camera on",
  });
  setToggle(toggleMicBtn, audioOn, {
    onIcon: "mdi:microphone", offIcon: "mdi:microphone-off",
    onLabel: "Mute microphone", offLabel: "Unmute microphone",
  });
}

function toggleTrack(kind: "video" | "audio"): void {
  if (!cameraStream) return;
  const tracks = kind === "video" ? cameraStream.getVideoTracks() : cameraStream.getAudioTracks();
  const track = tracks[0];
  if (!track) return;
  track.enabled = !track.enabled;
  syncCameraToggles();
}

// ---------------------------------------------------------------------------
// Room helpers
// ---------------------------------------------------------------------------
function slugifyRoom(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function randomRoom(): string {
  const words = ["sky", "river", "delta", "ember", "atlas", "lumen", "vela", "onyx", "cedar", "nova"];
  const a = words[Math.floor(Math.random() * words.length)];
  const b = words[Math.floor(Math.random() * words.length)];
  const n = Math.floor(Math.random() * 900 + 100);
  return `${a}-${b}-${n}`;
}

function meetingLink(room: string): string {
  return `https://${JITSI_DOMAIN}/${room}`;
}

function refreshCopyState(): void {
  copyLinkBtn.disabled = slugifyRoom(roomNameInput.value).length === 0;
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    showToast("Invite link copied");
  } catch {
    setStatus(`Copy failed. Link: ${text}`, true);
  }
}

// ---------------------------------------------------------------------------
// Meeting (Jitsi)
// ---------------------------------------------------------------------------
function launchMeeting(): void {
  const Api = window.JitsiMeetExternalAPI;
  if (!Api) {
    setStatus("Meeting library failed to load. Check your connection.", true);
    return;
  }
  leaveMeeting(); // only one at a time

  const room = slugifyRoom(roomNameInput.value) || randomRoom();
  roomNameInput.value = room;
  currentRoom = room;
  const displayName = displayNameInput.value.trim();

  meeting = new Api(JITSI_DOMAIN, {
    roomName: room,
    parentNode: meetingContainer,
    width: "100%",
    height: "100%",
    userInfo: displayName ? { displayName } : undefined,
    configOverwrite: { prejoinPageEnabled: false },
  });

  meeting.addEventListener("videoConferenceJoined", () => {
    setStatus(`Joined meeting "${room}".`);
  });
  meeting.addEventListener("audioMuteStatusChanged", (p) => {
    setToggle(mMic, !readMuted(p), {
      onIcon: "mdi:microphone", offIcon: "mdi:microphone-off",
      onLabel: "Mute", offLabel: "Unmute",
    });
  });
  meeting.addEventListener("videoMuteStatusChanged", (p) => {
    setToggle(mCam, !readMuted(p), {
      onIcon: "mdi:video", offIcon: "mdi:video-off",
      onLabel: "Stop video", offLabel: "Start video",
    });
  });
  meeting.addEventListener("screenSharingStatusChanged", (p) => {
    setToggle(mShare, readOn(p), {
      onIcon: "mdi:monitor-share", offIcon: "mdi:monitor-share",
      onLabel: "Stop sharing", offLabel: "Share screen",
    });
  });
  meeting.addEventListener("readyToClose", () => leaveMeeting());

  meetingSetup.hidden = true;
  meetingControls.hidden = false;
  meetingBadge.hidden = false;
  meetingContainer.classList.add("active");
  setStatus(`Launching meeting "${room}"…`);
}

function readMuted(payload: unknown): boolean {
  return typeof payload === "object" && payload !== null && "muted" in payload
    ? Boolean((payload as { muted: unknown }).muted)
    : false;
}

function readOn(payload: unknown): boolean {
  return typeof payload === "object" && payload !== null && "on" in payload
    ? Boolean((payload as { on: unknown }).on)
    : false;
}

function leaveMeeting(): void {
  if (meeting) {
    meeting.dispose();
    meeting = null;
  }
  currentRoom = "";
  meetingContainer.replaceChildren();
  meetingContainer.classList.remove("active");
  meetingSetup.hidden = false;
  meetingControls.hidden = true;
  meetingBadge.hidden = true;
}

function command(cmd: string): void {
  meeting?.executeCommand(cmd);
}

// ---------------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------------
openCameraBtn.addEventListener("click", () => void openCamera());
stopCameraBtn.addEventListener("click", stopCamera);
toggleCameraBtn.addEventListener("click", () => toggleTrack("video"));
toggleMicBtn.addEventListener("click", () => toggleTrack("audio"));

toggleSettingsBtn.addEventListener("click", () => {
  settingsPanel.hidden = !settingsPanel.hidden;
});
cameraSelect.addEventListener("change", () => {
  if (cameraStream) void openCamera();
});
micSelect.addEventListener("change", () => {
  if (cameraStream) void openCamera();
});

roomNameInput.addEventListener("input", refreshCopyState);
randomRoomBtn.addEventListener("click", () => {
  roomNameInput.value = randomRoom();
  refreshCopyState();
});
copyLinkBtn.addEventListener("click", () => {
  void copyToClipboard(meetingLink(slugifyRoom(roomNameInput.value)));
});

launchMeetingBtn.addEventListener("click", launchMeeting);
leaveMeetingBtn.addEventListener("click", leaveMeeting);
mMic.addEventListener("click", () => command("toggleAudio"));
mCam.addEventListener("click", () => command("toggleVideo"));
mShare.addEventListener("click", () => command("toggleShareScreen"));
mCopy.addEventListener("click", () => {
  void copyToClipboard(meetingLink(currentRoom || slugifyRoom(roomNameInput.value)));
});

window.addEventListener("beforeunload", () => {
  stopCamera();
  leaveMeeting();
});

// Initial state
refreshCopyState();
void populateDevices();

export {};
