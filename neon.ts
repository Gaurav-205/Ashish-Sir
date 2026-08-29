import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  auth: true,
  dataApi: true,
  preview: {
    functions: {},
    buckets: {},
    aiGateway: true,
  },
  branch: (branch) => {
    if (branch.exists) {
      return {};
    }
    if (branch.name.startsWith("dev")) {
      return {
        ttl: "7d",
        postgres: {
          computeSettings: {
            autoscalingLimitMinCu: 0.25,
            autoscalingLimitMaxCu: 1,
            suspendTimeout: "5m",
          },
        },
      };
    }
    return {};
  },
});
