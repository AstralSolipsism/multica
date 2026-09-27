import { resolve } from "path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [
    // Vite 8 retains hashbangs in imported .mjs scripts; Vitest then wraps
    // them inside a function, where a hashbang is invalid JavaScript.
    { name: "test-script-hashbang", enforce: "pre", transform(code, id) {
      if (id.endsWith(".mjs") && code.startsWith("#!")) {
        return { code: code.replace(/^#![^\r\n]*/, ""), map: null };
      }
    } },
    react(),
  ],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src/renderer/src"),
    },
  },
  test: {
    globals: true,
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.mjs"],
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    passWithNoTests: true,
  },
});
