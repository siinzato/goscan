import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const API_PORT = process.env.API_PORT || "8788";

export default defineConfig({
  server: {
    host: true,
    allowedHosts: true,
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://localhost:${API_PORT}`,
        changeOrigin: true,
      },
    },
  },

  build: {
    outDir: "dist",
    sourcemap: true,
  },

  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "auto",

      includeAssets: [
        "icons/icon-192.png",
        "icons/icon-512.png",
        "icons/apple-touch-icon-180.png",
        "icons/favicon-32.png"
      ],

      manifest: {
        name: "GoScan — Conferência Inteligente de Produtos GoCase",
        short_name: "GoScan",
        description:
          "Conferência Inteligente de Produtos GoCase — uma ferramenta GoGroup.",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#FFFFFF",
        theme_color: "#123F78",

        icons: [
          {
            src: "/icons/icon-192.png",
            sizes: "192x192",
            type: "image/png"
          },
          {
            src: "/icons/icon-512.png",
            sizes: "512x512",
            type: "image/png"
          },
          {
            src: "/icons/icon-512-maskable.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable"
          },
        ],
      },

      workbox: {
        globPatterns: [
          "**/*.{js,css,html,svg,png,ico,webmanifest}"
        ],
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [],
      },

      devOptions: {
        enabled: false,
      },
    }),
  ],
});