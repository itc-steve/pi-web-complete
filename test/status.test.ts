import assert from "node:assert/strict";
import {
	noteServiceUsed,
	resetSessionStatus,
	setCoworkStatus,
	setReadStatus,
	setServiceProgress,
} from "../src/status.js";

function mockUi() {
	const status: Array<[string, string | undefined]> = [];
	const widgets: Array<[string, string[] | undefined, unknown?]> = [];
	return {
		status,
		widgets,
		ui: {
			setStatus(key: string, text: string | undefined) {
				status.push([key, text]);
			},
			setWidget(
				key: string,
				content: string[] | undefined,
				options?: { placement?: string },
			) {
				widgets.push([key, content, options]);
			},
		},
	};
}

{
	const { status, widgets, ui } = mockUi();
	resetSessionStatus(ui);
	assert.ok(status.every(([, text]) => text === undefined));
	assert.deepEqual(widgets.at(-1)?.slice(0, 2), ["web", undefined]);
}

{
	const { widgets, ui } = mockUi();
	noteServiceUsed(ui, "context7");
	const last = widgets.at(-1)!;
	assert.deepEqual(last[0], "web");
	assert.deepEqual(last[1], ["context7"]);
	assert.deepEqual(last[2], { placement: "belowEditor" });
}

{
	const { widgets, ui } = mockUi();
	noteServiceUsed(ui, "brave");
	noteServiceUsed(ui, "context7");
	setCoworkStatus(ui, true, "cowork: open");
	assert.deepEqual(widgets.at(-1)?.[1], ["brave, context7, cowork: open"]);
	setReadStatus(ui, "reading...");
	assert.deepEqual(widgets.at(-1)?.[1], ["reading..."]);
	setReadStatus(ui, null);
	assert.deepEqual(widgets.at(-1)?.[1], ["brave, context7, cowork: open"]);
	setCoworkStatus(ui, false);
	assert.deepEqual(widgets.at(-1)?.[1], ["brave, context7"]);
}

{
	const { widgets, ui } = mockUi();
	resetSessionStatus(ui);
	setServiceProgress(ui, "context7: fetching...");
	assert.deepEqual(widgets.at(-1)?.[1], ["context7: fetching..."]);
	noteServiceUsed(ui, "context7");
	assert.deepEqual(widgets.at(-1)?.[1], ["context7"]);
}

console.log("status.test.ts ok");
