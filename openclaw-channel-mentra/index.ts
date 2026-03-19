import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { mentraChannel } from "./src/channel.js";
import { setRuntime } from "./src/runtime.js";

// @mentra/sdk has a bug: handleReconnection() is called without .catch() in the
// WebSocket close handler, causing unhandled promise rejections that crash the
// host process. Guard here so the OpenClaw gateway stays alive.
process.on("unhandledRejection", (reason) => {
  console.error("[mentra-plugin] unhandled rejection (suppressed to protect gateway):", reason);
});

const plugin = {
  id: "mentra",
  name: "Mentra Smart Glasses",
  description: "MentraOS G2 Smart Glasses channel",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setRuntime(api.runtime);
    api.registerChannel({ plugin: mentraChannel });
  },
};

export default plugin;
