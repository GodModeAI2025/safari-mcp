#!/usr/bin/env node
// index.d.ts is generated from the live tools/list (scripts/gen-types.mjs). This fails when a
// tool or parameter changes without `npm run gen:types`, so the published types cannot drift
// from the server the way hand-maintained counts and docs repeatedly did.
import assert from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { listTools, renderTypes, toTs } from "../scripts/gen-types.mjs";

test("committed index.d.ts matches the server's registrations", { timeout: 60_000 }, async () => {
  const expected = renderTypes(await listTools());
  const committed = readFileSync(new URL("../index.d.ts", import.meta.url), "utf8");
  assert.ok(committed === expected, "index.d.ts is stale — run `npm run gen:types` and commit the result");
});

test("package.json publishes the types", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.types, "index.d.ts");
  assert.ok(pkg.files.includes("index.d.ts"));
});

test("schema conversion covers the shapes zod emits", () => {
  assert.equal(toTs({ type: "string" }), "string");
  assert.equal(toTs({ type: "integer" }), "number");
  assert.equal(toTs({ enum: ["up", "down"] }), '"up" | "down"');
  assert.equal(toTs({ type: "array", items: { type: "string" } }), "string[]");
  assert.equal(toTs({ type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } }), "Array<string | number>");
  assert.equal(toTs({ type: "object", properties: {}, additionalProperties: { type: "string" } }), "Record<string, string>");
  assert.equal(
    toTs({ type: "object", properties: { a: { type: "string" }, "b-c": { type: "boolean" } }, required: ["a"] }),
    '{\n  a: string;\n  "b-c"?: boolean;\n}'
  );
  assert.equal(toTs({}), "unknown");
});
