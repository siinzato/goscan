import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const API_PORT = process.env.API_PORT || "8788";

export default defineConfig({
  server: {
    port: 5173,
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
      includeAssets: ["icons/icon-192.png", "icons/icon-512.png"],
      manifest: {
        name: "Conferência de Estoque · Outlet",
        short_name: "Outlet Conf.",
        description: "Conferência de estoque do Outlet a partir de prints, texto ou planilha.",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#F3EEE4",
        theme_color: "#B8501C",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icons/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // Only precache the app shell / static build assets. Supabase calls are
        // authenticated JSON responses and must never be cached by the SW.
        globPatterns: ["**/*.{js,css,html,svg,png,ico,webmanifest}"],
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
});
