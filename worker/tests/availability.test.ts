import assert from "node:assert/strict";
import test from "node:test";
import { ServiceAvailability, ServiceSleeping } from "../availability.ts";

test("wrapped quota errors use the failure time across UTC midnight", async () => {
  const availability = new ServiceAvailability();
  let now = Date.parse("2026-10-15T23:59:59Z");
  await assert.rejects(availability.run("workers_ai", async () => {
    now += 2000;
    throw new Error("Binding failed", { cause: Object.assign(new Error("Account limited"), { code: 3036 }) });
  }, () => now), error => {
    assert.ok(error instanceof ServiceSleeping);
    assert.equal(error.pause.resetAt, Date.parse("2026-10-17T00:00:00Z"));
    return true;
  });
});

test("an overlapping temporary failure cannot shorten a recognized daily quota pause", async () => {
  const availability = new ServiceAvailability();
  const now = () => Date.parse("2026-10-15T12:00:00Z");
  let release: () => void = () => { throw new Error("Operation did not start"); };
  const pending = new Promise<void>(resolve => { release = resolve; });
  const transient = availability.run("vectorize", async () => {
    await pending;
    throw new Error("Temporarily unavailable");
  }, now);
  const assertion = assert.rejects(transient, error => {
    assert.ok(error instanceof ServiceSleeping);
    assert.equal(error.pause.service, "workers_ai");
    assert.equal(error.pause.resetAt, Date.parse("2026-10-16T00:00:00Z"));
    return true;
  });
  await assert.rejects(availability.run("workers_ai", async () => {
    throw new Error("AI_ERROR: 3036");
  }, now), ServiceSleeping);
  release();
  await assertion;
});
