import type { PluginRuntime } from "openclaw/plugin-sdk";

let _runtime: PluginRuntime | null = null;

/** Call once from register(api) — must happen before startAccount fires. */
export function setRuntime(runtime: PluginRuntime): void {
  _runtime = runtime;
}

/** Retrieve the stored PluginRuntime. Throws if called before register(). */
export function getRuntime(): PluginRuntime {
  if (!_runtime) {
    throw new Error(
      "[mentra] PluginRuntime not initialized — setRuntime() must be called in register()"
    );
  }
  return _runtime;
}
