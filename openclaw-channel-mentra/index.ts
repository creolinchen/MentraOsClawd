import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { mentraChannel } from "./src/channel.js";
import { setRuntime } from "./src/runtime.js";

const plugin = {
  id: "mentra",
  name: "Mentra Smart Glasses",
  description: "MentraOS G2 Smart Glasses channel",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    // Store api.runtime so gateway.startAccount can access the full
    // channel-reply dispatch layer (ctx.runtime lacks it).
    setRuntime(api.runtime);
    api.registerChannel({ plugin: mentraChannel });
  },
};

export default plugin;
