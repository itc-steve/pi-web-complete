import assert from "node:assert/strict";
import { coworkWaitError, shouldKeepCoworkSession } from "../src/cowork/session.js";

const profile = "/tmp/cowork-profile";
assert.equal(shouldKeepCoworkSession({ userDataDir: profile }, profile), true);
assert.equal(shouldKeepCoworkSession({ userDataDir: profile }, "/tmp/other"), false);
assert.equal(shouldKeepCoworkSession(undefined, profile), false);

assert.equal(coworkWaitError({ open: false }), null);
assert.equal(coworkWaitError({ open: true, headless: false }), null);
assert.match(coworkWaitError({ open: true, headless: true }) ?? "", /visible cowork window/);

console.log("Cowork session policy checks passed");
