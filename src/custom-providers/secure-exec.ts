import {
  NodeRuntime,
  createNodeDriver,
  createNodeRuntimeDriverFactory,
  createNodeV8Runtime,
} from "secure-exec";
import type { ProviderConfig } from "../types.js";

// Singleton promise — created once, shared across all sandbox creates
let sharedRuntimePromise: ReturnType<typeof initSharedRuntime> | null = null;

async function initSharedRuntime() {
  const systemDriver = createNodeDriver();
  const v8Runtime = await createNodeV8Runtime();
  const runtimeDriverFactory = createNodeRuntimeDriverFactory({ v8Runtime });
  return { systemDriver, runtimeDriverFactory };
}

function getSharedRuntime() {
  if (!sharedRuntimePromise) {
    sharedRuntimePromise = initSharedRuntime();
  }
  return sharedRuntimePromise;
}

async function createSecureExecCompute() {
  // Kick off singleton init eagerly so first create is fast
  const shared = getSharedRuntime();

  return {
    sandbox: {
      create: async () => {
        const { systemDriver, runtimeDriverFactory } = await shared;

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
