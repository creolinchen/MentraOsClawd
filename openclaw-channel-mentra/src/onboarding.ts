import type { ChannelOnboardingAdapter } from "openclaw/plugin-sdk";

const CHANNEL_ID = "mentra";

export const mentraOnboarding: ChannelOnboardingAdapter = {
  channel: CHANNEL_ID,

  getStatus: async ({ cfg }: { cfg: any }) => {
    const apiKey = cfg?.channels?.mentra?.mentraApiKey;
    const packageName = cfg?.channels?.mentra?.mentraPackageName;
    const serverUrl = cfg?.channels?.mentra?.mentraServerUrl;
    const configured = !!(apiKey && packageName && serverUrl);

    return {
      channel: CHANNEL_ID,
      configured,
      statusLines: configured
        ? [`Package: ${packageName}`, "API key: configured", `Server URL: ${serverUrl}`]
        : ["Not configured — run: openclaw configure --section channels"],
      selectionHint: configured ? packageName : undefined,
    };
  },

  configure: async ({ cfg, prompter }: { cfg: any; prompter: any }) => {
    await prompter.note(
      "Get your package name and API key from https://console.mentra.glass",
      "Mentra Setup"
    );

    const packageName = await prompter.text({
      message: "Package name (from console.mentra.glass)",
      placeholder: "com.yourname.app",
      initialValue: cfg?.channels?.mentra?.mentraPackageName ?? "",
      validate: (v: string) => (v.trim() ? undefined : "Package name is required"),
    });

    const apiKey = await prompter.text({
      message: "API key (from console.mentra.glass)",
      initialValue: cfg?.channels?.mentra?.mentraApiKey ?? "",
      validate: (v: string) => (v.trim() ? undefined : "API key is required"),
    });

    const useDefaultPort = await prompter.confirm({
      message: "Use default TpaServer port 7010?",
      initialValue: true,
    });

    let serverPort = 7010;
    if (!useDefaultPort) {
      const portStr = await prompter.text({
        message: "TpaServer port",
        placeholder: "7010",
        validate: (v: string) =>
          /^\d+$/.test(v.trim()) ? undefined : "Must be a number",
      });
      serverPort = parseInt(portStr.trim(), 10);
    }

    await prompter.note(
      "Your TpaServer must be publicly reachable by MentraOS.
" +
      "Use ngrok or similar: ngrok http " + serverPort + "
" +
      "Then copy the https://... URL and enter it below.
" +
      "Also set this URL as the Server URL in console.mentra.glass.",
      "Public Server URL required"
    );

    const serverUrl = await prompter.text({
      message: "Public server URL (e.g. https://abc123.ngrok-free.app)",
      placeholder: "https://your-tunnel.ngrok-free.app",
      initialValue: cfg?.channels?.mentra?.mentraServerUrl ?? "",
      validate: (v: string) => {
        const trimmed = v.trim();
        if (!trimmed) return "Server URL is required";
        if (!trimmed.startsWith("https://")) return "Must start with https://";
        return undefined;
      },
    });

    const newCfg = {
      ...cfg,
      channels: {
        ...cfg?.channels,
        mentra: {
          ...cfg?.channels?.mentra,
          mentraPackageName: packageName.trim(),
          mentraApiKey: apiKey.trim(),
          mentraServerPort: serverPort,
          mentraServerUrl: serverUrl.trim(),
        },
      },
    };

    await prompter.note(
      "IMPORTANT: Go to console.mentra.glass and set your app's
" +
      "Server URL to: " + serverUrl.trim() + "
" +
      "This tells MentraOS where to connect.",
      "Set URL in Mentra Console"
    );

    await prompter.outro("Mentra channel configured. Restart the gateway to connect.");

    return { cfg: newCfg, accountId: "default" };
  },
};
