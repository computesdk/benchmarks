import {
  NodeRuntime,
  createNodeDriver,
  createNodeRuntimeDriverFactory,
  createNodeV8Runtime,
} from "secure-exec";
import type { ProviderConfig } from "../types.js";

async function createSecureExecCompute() {
  console.log("[secure-exec] createSecureExecCompute called");
  const systemDriver = createNodeDriver();
  const v8Runtime = await createNodeV8Runtime();
  const runtimeDriverFactory = createNodeRuntimeDriverFactory({ v8Runtime });

  return {
    sandbox: {
      create: async () => {
        const runtime = new NodeRuntime({
          systemDriver,
          runtimeDriverFactory,
        });

        return {
          runCommand: async () => {
            await runtime.run("export const x = 1;");
            return { exitCode: 0 };
          },
          destroy: async () => {
            runtime.dispose();
          },
        };
      },
    },
  };
}

export const secureExecProvider: ProviderConfig = {
  name: 'secure-exec',
  requiredEnvVars: [],
  createCompute: createSecureExecCompute,
};
