import { test } from "node:test";
import assert from "node:assert/strict";
import { RunState } from "./run-state.js";
test("new questions invalidate old callbacks and abort the previous connection", () => {
  const state = new RunState();
  const old = state.start();
  const current = state.start();
  assert.equal(old.current(), false);
  assert.equal(old.signal.aborted, true);
  assert.equal(current.current(), true);
  state.cancel();
  assert.equal(current.current(), false);
  assert.equal(current.signal.aborted, true);
});

test("answer anchors use distinct local scopes without requiring secure-context browser APIs", () => {
  const state = new RunState();
  const first = state.start();
  const second = state.start();
  assert.notEqual(first.scope, second.scope);
  assert.match(second.scope, /^answer-\d+$/);
});
