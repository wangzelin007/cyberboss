const test = require("node:test");
const assert = require("node:assert/strict");

// CopilotSdkClient requires @github/copilot-sdk at construction time, so we
// test the onError normalization logic in isolation by extracting the same
// algorithm used in client-wrapper.js.

function normalizeError(err) {
  if (err instanceof Error) return err;
  if (err && typeof err === "object") {
    let msg = err.message || (err.data && err.data.message) || "";
    if (!msg) {
      try { msg = JSON.stringify(err); } catch { msg = "Unknown runtime error (unserializable)"; }
    }
    return new Error(msg);
  }
  return new Error(String(err));
}

test("normalizeError: Error instance passes through", () => {
  const original = new Error("something broke");
  const result = normalizeError(original);
  assert.strictEqual(result, original);
  assert.equal(result.message, "something broke");
});

test("normalizeError: object with .message extracts message", () => {
  const err = { type: "session.error", message: "Model not available" };
  const result = normalizeError(err);
  assert.equal(result.message, "Model not available");
});

test("normalizeError: object with .data.message extracts nested message", () => {
  const err = { type: "session.error", data: { errorType: "query", message: "Execution failed: timeout" } };
  const result = normalizeError(err);
  assert.equal(result.message, "Execution failed: timeout");
});

test("normalizeError: object without message falls back to JSON", () => {
  const err = { code: 42, detail: "unknown" };
  const result = normalizeError(err);
  assert.equal(result.message, JSON.stringify(err));
});

test("normalizeError: circular object does not throw", () => {
  const err = { foo: "bar" };
  err.self = err;
  const result = normalizeError(err);
  assert.equal(result.message, "Unknown runtime error (unserializable)");
});

test("normalizeError: string error", () => {
  const result = normalizeError("plain string error");
  assert.equal(result.message, "plain string error");
});

test("normalizeError: null/undefined", () => {
  assert.equal(normalizeError(null).message, "null");
  assert.equal(normalizeError(undefined).message, "undefined");
});
