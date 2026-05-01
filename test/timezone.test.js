const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { CyberbossApp, loadTimezoneConfig, saveTimezoneConfig } = require("../src/core/app");

test("saveTimezoneConfig and loadTimezoneConfig round-trip", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-tz-test-"));
  const filePath = path.join(dir, "timezone-config.json");

  saveTimezoneConfig(filePath, "Australia/Sydney");
  const loaded = loadTimezoneConfig(filePath);
  assert.equal(loaded, "Australia/Sydney");
});

test("loadTimezoneConfig returns empty string for missing file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-tz-test-"));
  const loaded = loadTimezoneConfig(path.join(dir, "nonexistent.json"));
  assert.equal(loaded, "");
});

test("loadTimezoneConfig returns empty string for invalid timezone in file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-tz-test-"));
  const filePath = path.join(dir, "timezone-config.json");
  fs.writeFileSync(filePath, JSON.stringify({ timezone: "Not/A/Zone" }));
  const loaded = loadTimezoneConfig(filePath);
  assert.equal(loaded, "");
});

test("handleTimezoneCommand shows current timezone when no arg given", async () => {
  const sent = [];
  const appLike = {
    config: { timezone: "Asia/Shanghai" },
    channelAdapter: {
      async sendText(payload) { sent.push(payload); },
    },
  };

  await CyberbossApp.prototype.handleTimezoneCommand.call(appLike, {
    senderId: "user-1",
    contextToken: "ctx-1",
  }, { args: "" });

  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Asia\/Shanghai/);
});

test("handleTimezoneCommand switches to a valid timezone", async () => {
  const sent = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-tz-test-"));
  const tzFile = path.join(dir, "timezone-config.json");
  const appLike = {
    config: { timezone: "Asia/Shanghai", timezoneConfigFile: tzFile },
    channelAdapter: {
      async sendText(payload) { sent.push(payload); },
    },
  };

  await CyberbossApp.prototype.handleTimezoneCommand.call(appLike, {
    senderId: "user-1",
    contextToken: "ctx-1",
  }, { args: "Australia/Sydney" });

  assert.equal(appLike.config.timezone, "Australia/Sydney");
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Australia\/Sydney/);
  assert.equal(loadTimezoneConfig(tzFile), "Australia/Sydney");
});

test("handleTimezoneCommand rejects invalid timezone", async () => {
  const sent = [];
  const appLike = {
    config: { timezone: "Asia/Shanghai" },
    channelAdapter: {
      async sendText(payload) { sent.push(payload); },
    },
  };

  await CyberbossApp.prototype.handleTimezoneCommand.call(appLike, {
    senderId: "user-1",
    contextToken: "ctx-1",
  }, { args: "Fake/Zone" });

  assert.equal(appLike.config.timezone, "Asia/Shanghai");
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Invalid timezone/);
});
