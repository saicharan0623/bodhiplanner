import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/bodhiplanner/",
  server: {
    proxy: {
      "/bodhiplanner/api": "http://localhost:3001",
      "/bodhiplanner/auth": "http://localhost:3001",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
