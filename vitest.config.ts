import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Unit tests for the React frontend. Kept apart from vite.config.ts, which
// carries the Tauri dev-server settings.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test/setup.ts"],
  },
});
