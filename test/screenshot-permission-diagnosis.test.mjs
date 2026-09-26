#!/usr/bin/env node
/**
 * #14 — "Screen Recording permission may have been lost" although the user had granted it to
 * Safari and VS Code and rebooted. The message guessed. macOS attributes the grant to the
 * responsible .app (the IDE/terminal that launched safari-mcp), and on macOS 26 window capture
 * can fail with the grant intact. The final error now reports the helper's actual
 * CGPreflightScreenCaptureAccess result and names the app whose grant applies.
 */
import assert from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { _screenshotFailureMessage, _appNameFromCommPath } from "../safari.js";

test("not granted: names the launching app, says Safari is the wrong target, demands Cmd+Q", () => {
  const msg = _screenshotFailureMessage({ screenRecording: false, hostApp: "Visual Studio Code" });
  assert.match(msg, /NOT granted/);
  assert.match(msg, /"Visual Studio Code"/);
  assert.match(msg, /safari-helper/);
  assert.match(msg, /Cmd\+Q/);
  assert.match(msg, /Granting it to Safari does not help/);
});

test("granted: says it is not a permission problem instead of sending the user to re-grant", () => {
  const msg = _screenshotFailureMessage({ screenRecording: true, hostApp: "Terminal" });
  assert.match(msg, /IS granted/);
  assert.match(msg, /not a permission problem/);
  assert.doesNotMatch(msg, /may have been lost/);
});

test("unknown state still points at the launching app and at safari_doctor", () => {
  const msg = _screenshotFailureMessage({});
  assert.match(msg, /your terminal or IDE, not Safari/);
  assert.match(msg, /safari_doctor/);
});

test("every variant keeps the 'screencapture' keyword index.js retries on", () => {
  for (const screenRecording of [true, false, undefined]) {
    assert.match(_screenshotFailureMessage({ screenRecording }), /screencapture/);
  }
});

test("the OUTERMOST .app in a process path is the responsible app", () => {
  assert.equal(
    _appNameFromCommPath("/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)"),
    "Visual Studio Code"
  );
  assert.equal(_appNameFromCommPath("/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal"), "Terminal");
  assert.equal(_appNameFromCommPath("/usr/local/bin/node"), null);
  assert.equal(_appNameFromCommPath("-zsh"), null);
});

test("the final screenshot error is built from the preflight, not hard-coded", () => {
  const src = readFileSync(new URL("../safari.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /throw new Error\("screencapture failed — Screen Recording permission may have been lost/);
  assert.match(src, /throw new Error\(_screenshotFailureMessage\(\{ screenRecording: pf \? pf\.screenRecording : undefined, hostApp \}\)\)/);
});
