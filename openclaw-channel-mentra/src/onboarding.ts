import type { ChannelOnboardingAdapter } from "openclaw/plugin-sdk";

const CHANNEL_ID = "mentra";

export const mentraOnboarding: ChannelOnboardingAdapter = {
  channel: CHANNEL_ID,

  getStatus: async ({ cfg }: { cfg: any }) => {
    const apiKey = cfg?.channels?.mentra?.mentraApiKey;
    const packageName = cfg?.channels?.mentra?.mentraPackageName;
    const configured = !!(apiKey && packageName);

    return {
      channel: CHANNEL_ID,
      configured,
      statusLines: configured
        ? [`Package: ${packageName}`, "API key: configured"]
        : ["Not configured — run: openclaw config setup mentra"],
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
      message: `Use default TpaServer port 7010?`,
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

    const newCfg = {
      ...cfg,
      channels: {
        ...cfg?.channels,
        mentra: {
          ...cfg?.channels?.mentra,
          mentraPackageName: packageName.trim(),
          mentraApiKey: apiKey.trim(),
          mentraServerPort: serverPort,
        },
      },
    };

    await prompter.outro("Mentra channel configured. Restart the gateway to connect.");

    return { cfg: newCfg, accountId: "default" };
  },
};
