import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { TERMINAL_STATES } from "../src/types.ts";

test("toolchain resolves Pi packages and local .ts imports", () => {
	assert.equal(visibleWidth("fugue"), 5);
	assert.ok(TERMINAL_STATES.has("done"));
});
