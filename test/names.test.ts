import { test } from "node:test";
import assert from "node:assert/strict";
import { allocateName, fallbackName, normalizeName, parseName } from "../src/names.ts";

test("normalizeName lowercases and maps spaces/underscores to dashes", () => {
	assert.equal(normalizeName("  Auth_Tests "), "auth-tests");
	assert.equal(normalizeName("DB Scout"), "db-scout");
	assert.equal(normalizeName("probe"), "probe");
});

test("parseName accepts only the design pattern", () => {
	assert.deepEqual(parseName("probe"), { ok: true, name: "probe" });
	assert.deepEqual(parseName("Probe_2"), { ok: true, name: "probe-2" });
	assert.equal(parseName("").ok, false);
	assert.equal(parseName("2fast").ok, false);
	assert.equal(parseName("probe!").ok, false);
	assert.equal(parseName("-probe").ok, false);
	assert.equal(parseName("a".repeat(21)).ok, false);
	assert.equal(parseName("a".repeat(20)).ok, true);
});

test("allocateName appends -2, -3, ... before the name is free", () => {
	const taken = new Set(["probe", "probe-2", "probe-4"]);
	assert.equal(allocateName("probe", (name) => taken.has(name)), "probe-3");
});

test("allocateName keeps candidates inside the length cap", () => {
	const base = "a".repeat(20);
	const taken = new Set([base]);
	const name = allocateName(base, (candidate) => taken.has(candidate));
	assert.equal(name, `${"a".repeat(18)}-2`);
	assert.equal(parseName(name).ok, true);
});

test("fallbackName prefers the lane key, then the role", () => {
	assert.equal(fallbackName("lane-probe", "scout", () => false), "lane-probe");
	assert.equal(fallbackName(undefined, "evidence-auditor", () => false), "evidence-auditor");
	assert.equal(fallbackName("Not A Name!", "scout", () => false), "scout");
	assert.equal(fallbackName(undefined, "scout", (name) => name === "scout"), "scout-2");
});
