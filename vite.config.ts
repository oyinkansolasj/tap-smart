import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    // Makes the app installable ("Add to Home Screen") and lets it open without a connection.
    VitePWA({
      // A new version is picked up the next time the app is opened, with no "update" prompt.
      registerType: 'autoUpdate',
      // The icons are already stored by the globPatterns below; don't add them a second time.
      includeManifestIcons: false,
      manifest: {
        id: '/',
        name: 'Which card?',
        short_name: 'Which card',
        description: 'Pick which of your cards earns the most at the till. Your cards and purchases stay on your phone.',
        lang: 'en-GB',
        dir: 'ltr',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        // Matches --accent and --bg in src/index.css (light mode).
        theme_color: '#0b6e4f',
        background_color: '#f6f6f3',
        categories: ['finance', 'shopping', 'utilities'],
        // Made from public/icon.svg by `npm run icons`.
        // icon-512.png keeps its mark inside the safe area, so Android can also crop it into a circle (maskable).
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Store the app and the card catalogue on the device, so the till works with no signal.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,json}'],
      },
    }),
  ],
})
