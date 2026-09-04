import { defineConfig } from 'tsup';
import pkg from './package.json';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    bin: 'src/bin.ts',
  },
  format: ['cjs', 'esm'],
  // Only the library entry needs type declarations; the bin is an executable
  // and its by-name self-import can't be resolved during a clean dts build.
  dts: { entry: { index: 'src/index.ts' } },
  splitting: false,
  sourcemap: true,
  clean: true,
  // The bin re-imports the package by name so it resolves to the same built
  // module as any benchmark it loads; keep that import external instead of
  // bundling a second copy of the runner into bin.*.
  external: ['@benchsdk/runner'],
  define: {
    __BENCH_VERSION__: JSON.stringify(pkg.version),
  },
});
