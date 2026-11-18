// Generates the app's PNG icons and favicon.ico from public/icon.svg. Run: npm run icons
// The icons are committed, so this only needs running again when the icon changes.
//
// Output (in public/):
//   icon-192.png, icon-512.png       manifest icons (icon-512.png is also the "maskable" one)
//   apple-touch-icon-180x180.png     iPhone home screen
//   favicon.ico                      browser tab

import { defaultAssetName, defineConfig } from '@vite-pwa/assets-generator/config';

export default defineConfig({
  headLinkOptions: { preset: '2023' },
  preset: {
    // The SVG already has a solid background and keeps its mark inside the safe area, so no padding.
    transparent: { sizes: [192, 512], padding: 0, favicons: [[48, 'favicon.ico']] },
    // No separate maskable file: icon-512.png already works as one (see public/icon.svg).
    maskable: { sizes: [], padding: 0 },
    apple: { sizes: [180], padding: 0 },
    assetName: (type, size) => (type === 'transparent' ? `icon-${size.width}.png` : defaultAssetName(type, size)),
  },
  images: ['public/icon.svg'],
});
