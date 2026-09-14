/**
 * /web command parsing + tool toggling.
 *
 * Run:  npx tsx test/toggle.test.ts
 */

import assert from "node:assert/strict";
import {
	WebToggleTarget,
	ToolActivator,
	parseWebCommand,
	isToolActive,
	setToolEnabled,
} from "../src/toggle.js";

const BASE = ["read", "edit", "web_search", "web_read", "web_cowork"];

function fakeApi(initial: string[]): ToolActivator & { _get(): string[] } {
	const active = new Set(initial);
	return {
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => {
			active.clear();
			for (const n of names) active.add(n);
		},
		_get: () => [...active],
	};
}

// 1. parse: status / bare target toggles / explicit state / case-insensitive
{
	assert.deepEqual(parseWebCommand(""), { target: "status", state: "toggle" }, "empty = status");
	assert.deepEqual(parseWebCommand("  "), { target: "status", state: "toggle" }, "blank = status");
	assert.deepEqual(parseWebCommand("search"), { target: "search", state: "toggle" }, "bare = toggle");
	assert.deepEqual(parseWebCommand("SEARCH ON"), { target: "search", state: "on" }, "case-insensitive");
	assert.deepEqual(parseWebCommand("cowork off"), { target: "cowork", state: "off" }, "cowork off");
	assert.deepEqual(parseWebCommand("cowork maybe"), { target: "cowork", state: "toggle" }, "unknown state = toggle");
}

// 2. toggle off removes only that tool
{
	const api = fakeApi(BASE);
	assert.equal(setToolEnabled(api, "search", "toggle"), "off");
	assert.deepEqual(api._get().sort(), ["edit", "read", "web_cowork", "web_read"], "only web_search removed");
	assert.equal(isToolActive(api, "search"), false);
}

// 3. explicit on restores; off is idempotent
{
	const api = fakeApi(BASE);
	assert.equal(setToolEnabled(api, "cowork", "off"), "off");
	assert.equal(setToolEnabled(api, "cowork", "off"), "off", "idempotent off");
	assert.equal(api._get().length, BASE.length - 1);
	assert.equal(setToolEnabled(api, "cowork", "on"), "on");
	assert.deepEqual(api._get().sort(), [...BASE].sort(), "restored");
}

// 4. toggle on from off
{
	const api = fakeApi(BASE);
	setToolEnabled(api, "cowork", "off");
	assert.equal(setToolEnabled(api, "cowork", "toggle"), "on");
	assert.equal(isToolActive(api, "cowork"), true);
}

// 5. both targets map to the right tool names
{
	const api = fakeApi(BASE);
	const targets: WebToggleTarget[] = ["search", "cowork"];
	for (const t of targets) setToolEnabled(api, t, "off");
	assert.deepEqual(api._get().sort(), ["edit", "read", "web_read"], "both off");
}

console.log("toggle tests passed");
