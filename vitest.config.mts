import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
      obsidian: path.resolve(
        import.meta.dirname,
        "./src/tests/__mocks__/obsidian.ts",
      ),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/tests/**/*.test.ts"],
  },
});
