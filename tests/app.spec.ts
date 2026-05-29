import { test, expect, type Page } from "@playwright/test";

/**
 * A fake JitsiMeetExternalAPI served in place of the real CDN script, so the
 * meeting flow is tested deterministically and offline.
 */
const JITSI_STUB = `
(function () {
  class FakeJitsi {
    constructor(domain, options) {
      this._listeners = {};
      this._audioMuted = false;
      this._videoMuted = false;
      this._sharing = false;
      const frame = document.createElement('iframe');
      frame.setAttribute('data-stub', 'true');
      frame.title = 'jitsi-stub';
      if (options && options.parentNode) options.parentNode.appendChild(frame);
      this._frame = frame;
      setTimeout(() => this._emit('videoConferenceJoined', { roomName: options.roomName }), 0);
    }
    addEventListener(event, cb) { (this._listeners[event] = this._listeners[event] || []).push(cb); }
    _emit(event, payload) { (this._listeners[event] || []).forEach((cb) => cb(payload)); }
    executeCommand(cmd) {
      if (cmd === 'toggleAudio') { this._audioMuted = !this._audioMuted; this._emit('audioMuteStatusChanged', { muted: this._audioMuted }); }
      else if (cmd === 'toggleVideo') { this._videoMuted = !this._videoMuted; this._emit('videoMuteStatusChanged', { muted: this._videoMuted }); }
      else if (cmd === 'toggleShareScreen') { this._sharing = !this._sharing; this._emit('screenSharingStatusChanged', { on: this._sharing }); }
      else if (cmd === 'hangup') { this._emit('readyToClose', {}); }
    }
    dispose() { if (this._frame && this._frame.parentNode) this._frame.parentNode.removeChild(this._frame); }
  }
  window.JitsiMeetExternalAPI = FakeJitsi;
})();
`;

async function gotoApp(page: Page): Promise<void> {
  // Replace the real Jitsi script with the stub.
  await page.route("**/external_api.js", (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript", body: JITSI_STUB }),
  );
  // Don't depend on the Iconify CDN during tests.
  await page.route("**/iconify-icon*.js", (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript", body: "" }),
  );
  await page.goto("/");
}

test.beforeEach(async ({ page }) => {
  await gotoApp(page);
});

test("loads with correct initial UI", async ({ page }) => {
  await expect(page.locator("h1")).toContainText("Camera & Meetings");
  await expect(page.locator("#open-camera")).toBeEnabled();
  await expect(page.locator("#stop-camera")).toBeDisabled();
  await expect(page.locator("#copy-link")).toBeDisabled();
  await expect(page.locator("#meeting-controls")).toBeHidden();
});

test("opens the camera, toggles tracks, then stops", async ({ page }) => {
  await page.click("#open-camera");

  await expect(page.locator("#local-video")).toHaveClass(/active/);
  await expect(page.locator("#status")).toHaveText("Camera is live.");
  await expect(page.locator("#stop-camera")).toBeEnabled();
  await expect(page.locator("#open-camera")).toBeDisabled();
  await expect(page.locator("#camera-bar")).toBeVisible();

  // Camera toggle: on -> off
  await expect(page.locator("#toggle-camera")).toHaveAttribute("aria-pressed", "true");
  await page.click("#toggle-camera");
  await expect(page.locator("#toggle-camera")).toHaveAttribute("aria-pressed", "false");

  // Mic toggle: on -> off
  await expect(page.locator("#toggle-mic")).toHaveAttribute("aria-pressed", "true");
  await page.click("#toggle-mic");
  await expect(page.locator("#toggle-mic")).toHaveAttribute("aria-pressed", "false");

  // Stop
  await page.click("#stop-camera");
  await expect(page.locator("#local-video")).not.toHaveClass(/active/);
  await expect(page.locator("#camera-placeholder")).toBeVisible();
  await expect(page.locator("#stop-camera")).toBeDisabled();
});

test("generates a random room, enables and copies the invite link", async ({ page }) => {
  await expect(page.locator("#copy-link")).toBeDisabled();
  await page.click("#random-room");

  const room = await page.locator("#room-name").inputValue();
  expect(room).toMatch(/^[a-z]+-[a-z]+-\d+$/);

  await expect(page.locator("#copy-link")).toBeEnabled();
  await page.click("#copy-link");

  await expect(page.locator("#toast")).toContainText("copied");
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toBe(`https://meet.jit.si/${room}`);
});

test("typing a room name enables copy link with a slugified link", async ({ page }) => {
  await page.fill("#room-name", "Team Standup!!");
  await expect(page.locator("#copy-link")).toBeEnabled();
  await page.click("#copy-link");
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toBe("https://meet.jit.si/team-standup");
});

test("launches a meeting, toggles in-call controls, then leaves", async ({ page }) => {
  await page.fill("#display-name", "Elvis");
  await page.fill("#room-name", "Team Standup");
  await page.click("#launch-meeting");

  // Meeting UI swaps in
  await expect(page.locator("#meeting-controls")).toBeVisible();
  await expect(page.locator("#meeting-setup")).toBeHidden();
  await expect(page.locator("#meeting-badge")).toBeVisible();
  await expect(page.locator("#meeting-container")).toHaveClass(/active/);
  await expect(page.locator('#meeting-container iframe[data-stub="true"]')).toHaveCount(1);

  // The stubbed conference-joined event lands
  await expect(page.locator("#status")).toHaveText('Joined meeting "team-standup".');

  // Mic: on -> muted
  await expect(page.locator("#m-mic")).toHaveAttribute("aria-pressed", "true");
  await page.click("#m-mic");
  await expect(page.locator("#m-mic")).toHaveAttribute("aria-pressed", "false");

  // Camera: on -> off
  await page.click("#m-cam");
  await expect(page.locator("#m-cam")).toHaveAttribute("aria-pressed", "false");

  // Screen share: off -> on
  await expect(page.locator("#m-share")).toHaveAttribute("aria-pressed", "false");
  await page.click("#m-share");
  await expect(page.locator("#m-share")).toHaveAttribute("aria-pressed", "true");

  // Leave
  await page.click("#leave-meeting");
  await expect(page.locator("#meeting-setup")).toBeVisible();
  await expect(page.locator("#meeting-controls")).toBeHidden();
  await expect(page.locator("#meeting-container")).not.toHaveClass(/active/);
  await expect(page.locator('#meeting-container iframe[data-stub="true"]')).toHaveCount(0);
});
