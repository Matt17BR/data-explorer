import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import test from "node:test";
import { editorDisplayLaunchArgs, startIsolatedEditorDisplay } from "./editor-acceptance.mjs";

test("Linux editor acceptance defaults to an isolated zero-window platform", async () => {
  const environment = {
    DISPLAY: ":desktop",
    GDK_BACKEND: "wayland",
    HOME: "/desktop/home",
    WAYLAND_DISPLAY: "wayland-0",
    XDG_CACHE_HOME: "/desktop/cache",
    XDG_CONFIG_HOME: "/desktop/config",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/desktop/bus",
    CURSOR_IPC_HOOK_CLI: "/desktop/cursor.sock",
    XDG_DATA_HOME: "/desktop/data",
    XDG_RUNTIME_DIR: "/desktop/runtime",
    XDG_SESSION_TYPE: "wayland",
    VSCODE_IPC_HOOK_CLI: "/desktop/code.sock"
  };

  const isolation = await startIsolatedEditorDisplay({ platform: "linux", environment });
  const runtimeDirectory = environment.XDG_RUNTIME_DIR;
  try {
    assert.equal(isolation.mode, "headless");
    assert.equal(isolation.isolated, true);
    assert.equal(environment.DISPLAY, undefined);
    assert.equal(environment.WAYLAND_DISPLAY, undefined);
    assert.equal(environment.GDK_BACKEND, undefined);
    assert.equal(environment.XDG_SESSION_TYPE, "tty");
    assert.deepEqual(editorDisplayLaunchArgs("linux", environment), [
      "--ozone-platform=headless",
      "--disable-gpu",
      "--force-disable-user-env",
      "--disable-updates",
      "--disable-crash-reporter",
      "--disable-telemetry",
      "--use-inmemory-secretstorage",
      "--password-store=basic",
      "--skip-add-to-recently-opened"
    ]);
    if (process.platform !== "win32") {
      assert.equal((await stat(runtimeDirectory)).mode & 0o777, 0o700);
    }
    for (const key of ["HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME"]) {
      const pathWithinRuntime = relative(runtimeDirectory, environment[key]);
      assert.notEqual(pathWithinRuntime, "");
      assert.equal(pathWithinRuntime.startsWith(".."), false);
      assert.equal(isAbsolute(pathWithinRuntime), false);
      if (process.platform !== "win32") {
        assert.equal((await stat(environment[key])).mode & 0o777, 0o700);
      }
    }
    assert.equal(environment.DBUS_SESSION_BUS_ADDRESS, "unix:path=/desktop/bus");
    assert.equal(environment.CURSOR_IPC_HOOK_CLI, undefined);
    assert.equal(environment.VSCODE_IPC_HOOK_CLI, undefined);
  } finally {
    await isolation.stop();
    await isolation.stop();
  }

  await assert.rejects(stat(runtimeDirectory), { code: "ENOENT" });
  assert.deepEqual(environment, {
    DISPLAY: ":desktop",
    GDK_BACKEND: "wayland",
    HOME: "/desktop/home",
    WAYLAND_DISPLAY: "wayland-0",
    XDG_CACHE_HOME: "/desktop/cache",
    XDG_CONFIG_HOME: "/desktop/config",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/desktop/bus",
    CURSOR_IPC_HOOK_CLI: "/desktop/cursor.sock",
    XDG_DATA_HOME: "/desktop/data",
    XDG_RUNTIME_DIR: "/desktop/runtime",
    XDG_SESSION_TYPE: "wayland",
    VSCODE_IPC_HOOK_CLI: "/desktop/code.sock"
  });
});

test("a current-desktop debug run must be requested explicitly", async () => {
  const environment = {
    DISPLAY: ":desktop",
    OPEN_WRANGLER_EDITOR_DISPLAY: "current",
    XDG_RUNTIME_DIR: "/desktop/runtime"
  };

  const isolation = await startIsolatedEditorDisplay({ platform: "linux", environment });
  assert.equal(isolation.mode, "current");
  assert.equal(isolation.isolated, false);
  assert.deepEqual(editorDisplayLaunchArgs("linux", environment), []);
  assert.equal(environment.DISPLAY, ":desktop");
  assert.equal(environment.XDG_RUNTIME_DIR, "/desktop/runtime");
  await isolation.stop();
});

test("Xvfb remains an explicit isolated compatibility fallback", async (context) => {
  if (process.platform === "win32") {
    context.skip("The executable Xvfb acceptance double uses a POSIX shebang.");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-fake-xvfb-"));
  const executable = join(directory, "fake-xvfb.mjs");
  await writeFile(
    executable,
    `#!/usr/bin/env node
import { writeSync } from "node:fs";
const displayFd = Number(process.argv[process.argv.indexOf("-displayfd") + 1]);
writeSync(displayFd, "731\\n");
process.on("SIGTERM", () => process.exit(0));
setInterval(() => undefined, 1_000);
`
  );
  await chmod(executable, 0o700);
  const environment = {
    DISPLAY: ":desktop",
    OPEN_WRANGLER_EDITOR_DISPLAY: "xvfb",
    OPEN_WRANGLER_XVFB_EXECUTABLE: executable,
    XDG_RUNTIME_DIR: "/desktop/runtime"
  };

  try {
    const isolation = await startIsolatedEditorDisplay({ platform: "linux", environment });
    const runtimeDirectory = environment.XDG_RUNTIME_DIR;
    try {
      assert.equal(isolation.display, ":731");
      assert.equal(environment.DISPLAY, ":731");
      assert.equal(environment.GDK_BACKEND, "x11");
      assert.deepEqual(editorDisplayLaunchArgs("linux", environment), [
        "--ozone-platform=x11",
        "--force-disable-user-env",
        "--disable-updates",
        "--disable-crash-reporter",
        "--disable-telemetry",
        "--use-inmemory-secretstorage",
        "--password-store=basic",
        "--skip-add-to-recently-opened"
      ]);
      assert.equal((await stat(runtimeDirectory)).mode & 0o777, 0o700);
    } finally {
      await isolation.stop();
    }
    await assert.rejects(stat(runtimeDirectory), { code: "ENOENT" });
    assert.equal(environment.DISPLAY, ":desktop");
    assert.equal(environment.XDG_RUNTIME_DIR, "/desktop/runtime");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid isolation modes fail before an editor can launch", async () => {
  const environment = { OPEN_WRANGLER_EDITOR_DISPLAY: "automatic" };
  await assert.rejects(startIsolatedEditorDisplay({ platform: "linux", environment }), {
    message: /must be "headless", "xvfb", or "current"/u
  });
  assert.throws(() => editorDisplayLaunchArgs("linux", environment), {
    message: /must be "headless", "xvfb", or "current"/u
  });
});
