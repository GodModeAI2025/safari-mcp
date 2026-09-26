#!/usr/bin/env node
/**
 * #29 — on macOS 26 a mouse CGEvent is accepted, reported as delivered, and never reaches
 * WebKit content; keyboard CGEvents still do. safari_native_click arms a page-side probe
 * before posting the mouse event; with no TRUSTED pointer/mouse/click event and no toggle
 * change, it focuses the element and presses Space/Return natively.
 *
 * Hardened after a security review: the probe used a fixed global (`__mcpNCL`) that a page
 * could pre-set to blind it (forcing a second press after every delivered click), it missed
 * clicks inside iframes, and the fallback re-found the element by attribute in the top
 * document only. These tests run the probe JS in jsdom (synthetic events are untrusted —
 * exactly the "never delivered" verdict).
 */
import assert from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { _nativeClickNeedsKeyboardFallback, _activationKeyFor, _autoKeyboardFallbackApplies } from "../safari.js";

const src = readFileSync(new URL("../safari.js", import.meta.url), "utf8");
const impl = src.slice(src.indexOf("async function _nativeClickImpl("), src.indexOf("// ========== NATIVE HOVER"));

const builders = new Function(
  impl.slice(impl.indexOf("const _PROBE_TOGGLE_JS"), impl.indexOf("// Darwin 25 is macOS 26")) +
    impl.slice(impl.indexOf("function _activateViaKeyboardJS("), impl.length) +
    "return { arm: _nativeClickProbeArmJS, read: _nativeClickProbeReadJS, clear: _nativeClickProbeClearJS, kb: _activateViaKeyboardJS };"
)();

function page(html = `<button id="b">Next</button><input type="checkbox" id="c">`) {
  const dom = new JSDOM(html, { runScripts: "outside-only" });
  const run = (js) => dom.window.eval(js);
  return { dom, run };
}
const arm = (run, sel, token) => run(`var el=document.querySelector('${sel}');${builders.arm(token)}`);

test("untrusted events only → '0' → keyboard fallback", () => {
  const { dom, run } = page();
  arm(run, "#b", "mcpncA");
  dom.window.document.getElementById("b").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  const verdict = run(builders.read("mcpncA"));
  assert.equal(verdict, "0");
  assert.equal(_nativeClickNeedsKeyboardFallback(verdict), true);
});

test("a page pre-setting the old global guard can no longer blind the probe", () => {
  const { run } = page();
  run("window.__mcpNCL=1;window.__mcpNC={t:'x',trusted:false};");
  arm(run, "#b", "mcpncB");
  assert.equal(run("typeof window['mcpncB'].off"), "function", "listeners are installed on every arm");
  run("window['mcpncB'].trusted=true"); // what the capture handler does for e.isTrusted
  assert.equal(run(builders.read("mcpncB")), "1");
});

test("a toggle whose state changed counts as delivered — no second press flips it back", () => {
  const { dom, run } = page();
  arm(run, "#c", "mcpncC");
  dom.window.document.getElementById("c").checked = true; // the mouse click landed
  assert.equal(run(builders.read("mcpncC")), "1");
  const { run: run2 } = page(`<div id="s" role="switch" aria-checked="false"></div>`);
  arm(run2, "#s", "mcpncD");
  run2("document.getElementById('s').setAttribute('aria-checked','true')");
  assert.equal(run2(builders.read("mcpncD")), "1");
});

test("clicks inside a same-origin iframe are observed on the frame's own window", () => {
  const { dom, run } = page(`<iframe id="f"></iframe>`);
  const fdoc = dom.window.document.getElementById("f").contentDocument;
  fdoc.body.innerHTML = `<button id="inner">Go</button>`;
  run(`var el=document.getElementById('f').contentDocument.getElementById('inner');${builders.arm("mcpncE")}`);
  // Registered on the frame's window: an untrusted dispatch there must reach the handler path
  // (it stays '0' because jsdom events are untrusted, but the element is tracked, not 'gone').
  fdoc.getElementById("inner").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(run(builders.read("mcpncE")), "0");
  const info = JSON.parse(run(builders.kb("mcpncE")));
  assert.equal(info.tag, "BUTTON", "the fallback finds the element in the iframe by reference");
  assert.equal(info.focused, true, "focus is checked in the element's own document");
});

test("navigated/removed element or cleared probe reads 'gone' and is never pressed again", () => {
  const { run } = page();
  assert.equal(run(builders.read("mcpncNever")), "gone");
  arm(run, "#b", "mcpncF");
  run("document.getElementById('b').remove()");
  assert.equal(run(builders.read("mcpncF")), "gone");
  arm(run, "#c", "mcpncG");
  run(builders.clear("mcpncG"));
  assert.equal(run(builders.read("mcpncG")), "gone");
  assert.equal(run("Object.keys(window).filter(function(k){return k.indexOf('mcpnc')===0}).length"), 0, "the probe is not enumerable");
  for (const v of ["gone", "", "1", undefined, "error"]) assert.equal(_nativeClickNeedsKeyboardFallback(v), false);
});

test("auto fallback applies only on macOS 26+ (Darwin 25+)", () => {
  assert.equal(_autoKeyboardFallbackApplies(25), true);
  assert.equal(_autoKeyboardFallbackApplies(26), true);
  assert.equal(_autoKeyboardFallbackApplies(24), false);
  assert.equal(_autoKeyboardFallbackApplies(0), false);
  assert.match(impl, /activate === "keyboard" \|\| \(activate === "auto" && _autoKeyboardFallbackApplies\(_darwinMajor\(\)\)\)/);
});

test("links and submit inputs use Return; buttons, checkboxes and the rest use Space", () => {
  assert.equal(_activationKeyFor({ tag: "A" }), "return");
  assert.equal(_activationKeyFor({ tag: "DIV", role: "link" }), "return");
  assert.equal(_activationKeyFor({ tag: "INPUT", type: "submit" }), "return");
  assert.equal(_activationKeyFor({ tag: "BUTTON" }), "space");
  assert.equal(_activationKeyFor({ tag: "INPUT", type: "checkbox" }), "space");
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
  assert.match(kb, /return `Native activated:/);
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
