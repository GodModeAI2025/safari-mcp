#!/usr/bin/env node
/**
 * #64 — a native (OS-level CGEvent) click fired at a user's tab.
 *
 * Reported sequence: the session owned tab 17 (a Google Form). The user was opening and
 * closing tabs, so indices shifted. safari_native_click computed coordinates from our DOM,
 * then delivered the event to whichever tab was selected — a Chatwoot conversation. The
 * next safari_evaluate read the user's tab.
 *
 * _withTargetTabFronted is the one gate every native event passes. It used to (a) front the
 * cached activeTabIndex without re-proving it, and (b) when the session had lost its index,
 * take the "no owned tab — nothing to front" exit and fire at the selected tab anyway. An
 * OS-level event cannot be refused by any page-side guard afterwards, so the gate itself
 * must fail closed.
 */
import assert from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { _nativeFrontingPlan } from "../safari.js";

const src = readFileSync(new URL("../safari.js", import.meta.url), "utf8");
const gate = src.slice(
  src.indexOf("async function _withTargetTabFronted("),
  src.indexOf("// Atomic tab-identity guard, as a JS prefix.")
);

test("a session that owns a tab but lost its index refuses instead of firing unfronted", () => {
  assert.deepEqual(
    _nativeFrontingPlan({ ownsTab: true, markerAfter: true, resolvedIdx: null }),
    { action: "refuse" }
  );
  assert.deepEqual(
    _nativeFrontingPlan({ ownsTab: true, markerAfter: false, resolvedIdx: null }),
    { action: "refuse" }
  );
});

test("a marker proven gone refuses even if a URL/domain match produced an index", () => {
  assert.deepEqual(
    _nativeFrontingPlan({ ownsTab: true, markerAfter: false, resolvedIdx: 4 }),
    { action: "refuse" }
  );
});

test("a re-proven tab is fronted at its CURRENT index, not the cached one", () => {
  assert.deepEqual(
    _nativeFrontingPlan({ ownsTab: true, markerAfter: true, resolvedIdx: 5 }),
    { action: "front", idx: 5 }
  );
});

test("a session that never owned a tab keeps the historical front-tab behaviour", () => {
  assert.deepEqual(
    _nativeFrontingPlan({ ownsTab: false, markerAfter: false, resolvedIdx: null }),
    { action: "unfronted" }
  );
});

test("the gate re-resolves by marker BEFORE reading or switching the selection", () => {
  const resolveAt = gate.indexOf("await resolveActiveTab()");
  const planAt = gate.indexOf("_nativeFrontingPlan(");
  const readSelAt = gate.indexOf("(index of current tab)");
  const switchAt = gate.indexOf("set current tab to tab ${idx}");
  assert.ok(resolveAt > 0, "must re-resolve the owned tab");
  assert.ok(resolveAt < planAt && planAt < readSelAt && readSelAt < switchAt);
  assert.ok(!/const idx = _st\(\)\.activeTabIndex;/.test(gate), "must not front the raw cached index");
});

test("an unreadable selection refuses for a session that owns a tab", () => {
  const branch = gate.slice(gate.indexOf("if (!Number.isFinite(prev))"), gate.indexOf("const mustSwitch"));
  assert.match(branch, /if \(ownsTab\) throw _nativeTrackingLostError\(/);
});

test("the selected tab's marker is verified after the switch and before the event fires", () => {
  const verifyAt = gate.indexOf("in current tab)");
  const switchAt = gate.indexOf("set current tab to tab ${idx}");
  const fireAt = gate.indexOf("_tabFrontedDepth++");
  assert.ok(verifyAt > switchAt && verifyAt < fireAt, "marker check must sit between switch and fn()");
  const refuse = gate.slice(verifyAt, fireAt);
  assert.match(refuse, /set current tab to tab \$\{prev\}/, "a refused switch must hand the user's tab back");
  assert.match(refuse, /throw _nativeTrackingLostError\(/);
});

test("a marker lost BEFORE this call (page cleared window.name) still refuses a URL/domain match", () => {
  // Security review: the refusal used to fire only when the marker vanished inside this very
  // call. Once lost earlier, resolveActiveTab matched by URL/domain — possibly a user tab on
  // the same site — and the event fired there.
  assert.deepEqual(
    _nativeFrontingPlan({ ownsTab: true, markerAfter: false, resolvedIdx: 4 }),
    { action: "refuse" }
  );
});

test("after the switch, an owned session with no marker refuses and hands the tab back", () => {
  const branch = gate.slice(gate.indexOf("if (ownsTab && !marker) {"), gate.indexOf("if (marker) {"));
  assert.match(branch, /set current tab to tab \$\{prev\}/);
  assert.match(branch, /throw _nativeTrackingLostError\(/);
});
