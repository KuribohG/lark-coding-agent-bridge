import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Match tsup's `.html` text loader (tsup.config.ts) so `import html from
// './generated/index.html'` returns the file's contents as a string under
// vitest too. Without this, vite's import-analysis tries to parse the built
// console HTML as JS and fails.
export default defineConfig({
  plugins: [
    {
      name: "html-string-loader",
      enforce: "pre",
      transform(code: string, id: string) {
        if (id.endsWith(".html")) {
          return { code: `export default ${JSON.stringify(code)};`, map: null };
        }
        return null;
      },
    },
  ],
  resolve: {
    // The bridge bundles the in-repo engine from source.
    alias: { "@kuribohg/agent-workflows": fileURLToPath(new URL("packages/workflow-engine/src/index.ts", import.meta.url)) },
  },
  test: {
    // GitHub's runners are ~3x slower than a dev box, and the heavier
    // suites drive hundreds of items; vitest's 5s default trips on them.
    testTimeout: 20_000,
    // The workflow engine checks every commit against a rebuild of the workflow from its journal.
    env: { WORKFLOW_ENGINE_VERIFY: process.env.WORKFLOW_ENGINE_VERIFY ?? "1" },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "packages/*/src/**/*.ts"],
      // Re-export barrels have no logic of their own.
      exclude: ["src/index.ts", "src/runtime/public.ts", "src/channels/*/index.ts", "src/workflows/index.ts", "packages/*/src/index.ts", "packages/*/src/cli.ts"],
      reporter: ["text-summary", "json-summary", "json", "html"],
      // CI publishes the report even when a test fails.
      reportOnFailure: true,
      // Floor just under the current baseline so coverage cannot silently
      // regress; raise it as tests are added.
      thresholds: { lines: 83, statements: 83, branches: 81, functions: 89 },
    },
  },
});
