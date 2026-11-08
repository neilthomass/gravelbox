const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");

test("Gradescope support is additive and references packaged files", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json")));
  const gradescopeScript = manifest.content_scripts.find((entry) =>
    entry.matches.includes("*://*.gradescope.com/*")
  );

  assert.ok(gradescopeScript);
  assert.equal(manifest.action.default_popup, "popup.html");
  assert.equal(manifest.content_scripts[0].js[0], "page-camera.js");
  assert.ok(manifest.permissions.includes("identity"));
  assert.ok(manifest.permissions.includes("alarms"));
  assert.ok(manifest.permissions.includes("scripting"));

  for (const file of gradescopeScript.js) {
    assert.equal(fs.existsSync(path.join(root, file)), true, file);
  }

  const popup = fs.readFileSync(path.join(root, "popup.html"), "utf8");
  const contentScript = fs.readFileSync(
    path.join(root, "gradescope/contentScript.js"),
    "utf8"
  );
  assert.doesNotMatch(popup, /id="gradescopeSync"/);
  assert.doesNotMatch(popup, /id="gradescopeSyncStatus"/);
  assert.doesNotMatch(popup, /id="gradescopeEnabled"/);
  assert.doesNotMatch(contentScript, /gradescopeEnabled/);

  const workers = ["service-worker.js", "gradescope/background.js"];
  for (const worker of workers) {
    const source = fs.readFileSync(path.join(root, worker), "utf8");
    for (const match of source.matchAll(/["'](gradescope\/[^"']+\.js)["']/g)) {
      assert.equal(fs.existsSync(path.join(root, match[1])), true, match[1]);
    }
  }
});

test("manifest uses the OAuth-registered extension identity", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json")));
  const digest = crypto.createHash("sha256")
    .update(Buffer.from(manifest.key, "base64"))
    .digest()
    .subarray(0, 16);
  const extensionId = [...digest]
    .map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15)))
    .join("");
  assert.equal(extensionId, "bbepekfgnpdfclkpfoojmfclnbkkbbco");
});

test("calendar sync creates a one-day all-day event and course-scoped key", async () => {
  class EventCache {
    addToCache() {}
  }
  const quietConsole = { log() {}, warn() {}, error() {} };
  const context = {
    self: {}, EventCache, console: quietConsole, fetch, URLSearchParams, setTimeout
  };
  const source = fs.readFileSync(
    path.join(root, "gradescope/auth/calendarAPIClient.js"),
    "utf8"
  );
  vm.runInNewContext(source, context);
  const CalendarAPIClient = context.self.CalendarAPIClient;
  const client = new CalendarAPIClient(
    { CALENDAR_API_BASE: "https://example.test" },
    { getValidToken: async () => "token" },
    { getChromeToken: async () => "token" }
  );
  let event;
  client.makeAPIRequest = async (_endpoint, options) => {
    event = JSON.parse(options.body);
    return { id: "event-1", ...event };
  };

  await client.createEventFromAssignment({
    assignmentId: "42",
    course: "CS 101",
    title: "Homework",
    dueDate: "2026-09-05T23:59:00-07:00",
    timezone: "America/Los_Angeles",
    url: "https://www.gradescope.com/courses/1/assignments/42"
  });

  assert.equal(event.start.date, "2026-09-05");
  assert.equal(event.end.date, "2026-09-06");
  assert.equal(event.extendedProperties.private.gradescope_assignment_id, "CS 101:42");
  assert.notEqual(
    client.getAssignmentKey({ course: "CS 101", assignmentId: "42" }),
    client.getAssignmentKey({ course: "MATH 101", assignmentId: "42" })
  );

  client.findExistingEvent = async () => ({ id: "event-1" });
  const duplicate = await client.syncAssignments([{
    assignmentId: "42",
    course: "CS 101",
    title: "Homework",
    dueDate: "2026-09-05T23:59:00-07:00",
    timezone: "America/Los_Angeles",
    url: "https://www.gradescope.com/courses/1/assignments/42"
  }]);
  assert.deepEqual(
    { created: duplicate.created, skipped: duplicate.skipped, errors: duplicate.errors },
    { created: 0, skipped: 1, errors: 0 }
  );

  let createAttempted = false;
  client.findExistingEvent = async () => {
    throw new Error("Could not verify existing Calendar events: network unavailable");
  };
  client.createEventFromAssignment = async () => {
    createAttempted = true;
  };
  const unavailable = await client.syncAssignments([{
    assignmentId: "42",
    course: "CS 101",
    title: "Homework",
    dueDate: "2026-09-05T23:59:00-07:00",
    timezone: "America/Los_Angeles",
    url: "https://www.gradescope.com/courses/1/assignments/42"
  }]);
  assert.equal(createAttempted, false);
  assert.equal(unavailable.created, 0);
  assert.equal(unavailable.errors, 1);
});
