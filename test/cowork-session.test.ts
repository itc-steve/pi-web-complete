import assert from "node:assert/strict";
import { coworkWaitError, shouldKeepCoworkSession, resolveCoworkHeadless } from "../src/cowork/session.js";

const profile = "/tmp/cowork-profile";
assert.equal(shouldKeepCoworkSession({ userDataDir: profile }, profile), true);
assert.equal(shouldKeepCoworkSession({ userDataDir: profile }, "/tmp/other"), false);
assert.equal(shouldKeepCoworkSession(undefined, profile), false);

assert.equal(coworkWaitError({ open: false }), null);
assert.equal(coworkWaitError({ open: true, headless: false }), null);
assert.match(coworkWaitError({ open: true, headless: true }) ?? "", /visible cowork window/);

assert.equal(resolveCoworkHeadless(undefined, "linux", {}), true);
assert.equal(resolveCoworkHeadless(true, "linux", {}), true);
assert.throws(() => resolveCoworkHeadless(false, "linux", {}), /headless:true/);
assert.equal(resolveCoworkHeadless(undefined, "linux", { DISPLAY: ":0" }), false);
assert.equal(resolveCoworkHeadless(undefined, "linux", { WAYLAND_DISPLAY: "wayland-0" }), false);
assert.equal(resolveCoworkHeadless(undefined, "darwin", {}), false);

console.log("Cowork session policy checks passed");
