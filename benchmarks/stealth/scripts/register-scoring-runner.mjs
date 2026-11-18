import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const entrypoint = process.env.BENCHSDK_RUNNER_ENTRYPOINT;
if (!entrypoint) throw new Error('Set BENCHSDK_RUNNER_ENTRYPOINT to a built runner index.js for cross-repository scoring tests');

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@benchsdk/runner') {
      return { url: pathToFileURL(entrypoint).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
