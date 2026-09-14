import { test } from "node:test";
import assert from "node:assert/strict";
import { ElapsedTimer } from "./elapsed-timer.js";
test("restarting and stopping clear every timer handle", () => {
  const originalSet = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  const handles = new Set<object>();
  globalThis.setInterval = ((callback: () => void) => {
    const handle = {};
    handles.add(handle);
    callback();
    return handle;
  }) as typeof setInterval;
  globalThis.clearInterval = ((handle: object) => {
    handles.delete(handle);
  }) as typeof clearInterval;
  try {
    const timer = new ElapsedTimer();
    const node = { textContent: "" } as HTMLElement;
    timer.start(node);
    assert.equal(handles.size, 1);
    timer.start(node);
    assert.equal(handles.size, 1);
    timer.stop();
    timer.stop();
    assert.equal(handles.size, 0);
    assert.match(node.textContent!, /s$/);
  } finally {
    globalThis.setInterval = originalSet;
    globalThis.clearInterval = originalClear;
  }
});
