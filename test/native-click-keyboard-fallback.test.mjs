#!/usr/bin/env node
/**
 * #29 — on macOS 26 a mouse CGEvent is accepted, reported as delivered, and never reaches
 * WebKit content; keyboard CGEvents still do (upstream maintainer, measured on a Google OAuth
 * consent screen: focus + native Space toggled the checkbox a native click could not).
 *
 * safari_native_click now arms a page-side probe before posting the mouse event. If no
 * TRUSTED pointerdown/mousedown/click arrives, it focuses the element and presses
 * Space/Return natively. The probe runs here in jsdom: synthetic events are untrusted, which
 * is exactly the "event never delivered" verdict.
 */
import assert from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { _nativeClickNeedsKeyboardFallback, _activationKeyFor } from "../safari.js";

const src = readFileSync(new URL("../safari.js", import.meta.url), "utf8");
const impl = src.slice(src.indexOf("async function _nativeClickImpl("), src.indexOf("// ========== NATIVE HOVER"));

// Pull the probe JS builders out of the source and evaluate them standalone.
const builders = new Function(
  impl.slice(impl.indexOf("function _nativeClickProbeArmJS("), impl.indexOf("// '0' is the only verdict")) +
    "return { arm: _nativeClickProbeArmJS, read: _nativeClickProbeReadJS, clear: _nativeClickProbeClearJS };"
)();

function page() {
  const dom = new JSDOM(`<button id="b">Next</button>`, { runScripts: "outside-only" });
  const run = (js) => dom.window.eval(js);
  return { dom, run };
}

test("a probe that saw only untrusted events reports '0' and triggers the keyboard fallback", () => {
  const { dom, run } = page();
  run(`var el=document.getElementById('b');${builders.arm("tok1")}`);
  dom.window.document.getElementById("b").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  const verdict = run(builders.read("tok1"));
  assert.equal(verdict, "0");
  assert.equal(_nativeClickNeedsKeyboardFallback(verdict), true);
});

test("a trusted event flips the probe to '1' — no fallback, no second press", () => {
  const { run } = page();
  run(`var el=document.getElementById('b');${builders.arm("tok2")}`);
  run(`window.__mcpNC.trusted=true`); // what the capture listener does for e.isTrusted
  const verdict = run(builders.read("tok2"));
  assert.equal(verdict, "1");
  assert.equal(_nativeClickNeedsKeyboardFallback(verdict), false);
});

test("a navigated or replaced page reads 'gone' and is never pressed again", () => {
  const { run } = page();
  assert.equal(run(builders.read("never-armed")), "gone");
  run(`var el=document.getElementById('b');${builders.arm("tok3")}`);
  run(builders.clear("tok3"));
  assert.equal(run(builders.read("tok3")), "gone");
  assert.equal(run(`document.querySelector('[data-mcp-nc]')`), null, "clear must remove the marker attribute");
  for (const v of ["gone", "", "1", undefined, "error"]) assert.equal(_nativeClickNeedsKeyboardFallback(v), false);
});

test("arming twice installs the window listeners once", () => {
  const { run } = page();
  run(`var el=document.getElementById('b');${builders.arm("a")}`);
  run(`var el=document.getElementById('b');${builders.arm("b")}`);
  assert.equal(run("window.__mcpNCL"), 1);
  assert.equal(run("window.__mcpNC.t"), "b", "the latest click owns the probe");
});

test("links and submit inputs use Return; buttons, checkboxes and the rest use Space", () => {
  assert.equal(_activationKeyFor({ tag: "A" }), "return");
  assert.equal(_activationKeyFor({ tag: "DIV", role: "link" }), "return");
  assert.equal(_activationKeyFor({ tag: "INPUT", type: "submit" }), "return");
  assert.equal(_activationKeyFor({ tag: "BUTTON" }), "space");
  assert.equal(_activationKeyFor({ tag: "INPUT", type: "checkbox" }), "space");
  assert.equal(_activationKeyFor({ tag: "DIV", role: "switch" }), "space");
});

test("the probe is armed in the locate script, before the mouse event is posted", () => {
  const armAt = impl.indexOf("_nativeClickProbeArmJS(probe)");
  const fireAt = impl.indexOf("await _helperNativeClick(");
  const readAt = impl.indexOf("_nativeClickProbeReadJS(probe)");
  assert.ok(armAt > 0 && armAt < fireAt && fireAt < readAt);
  assert.equal((impl.match(/_nativeClickProbeArmJS\(probe\)/g) || []).length, 3, "ref, selector and text paths all arm it");
});

test("activate:'keyboard' needs an element and never posts a mouse event", () => {
  assert.match(impl, /activate === "keyboard" && !byElement\) \{\n\s*throw new Error/);
  const kb = impl.slice(impl.indexOf('if (activate === "keyboard") {'), impl.indexOf("await _helperNativeClick("));
  assert.match(kb, /return `Native activated:/, "keyboard mode must return before the mouse click");
});

test("the fallback refuses to press a key when the element would not take focus", () => {
  const act = impl.slice(impl.indexOf("async function _activateViaKeyboard("));
  const focusCheck = act.indexOf("if (!info.focused) throw");
  const press = act.indexOf("await _helperNativeKeyboard(");
  assert.ok(focusCheck > 0 && focusCheck < press);
});

test("the tool exposes activate with auto as the default", () => {
  const idx = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.match(idx, /activate: z\.enum\(\["auto", "mouse", "keyboard"\]\)\.optional\(\)\.default\("auto"\)/);
});
