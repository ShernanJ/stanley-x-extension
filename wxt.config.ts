import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  manifestVersion: 3,
  manifest: {
    name: 'Stanley-X',
    version: '0.1.0',
    description:
      'Turn Stanley LinkedIn drafts into X-native posts with rewrite controls, preview, and one-click compose.',
    icons: {
      16: 'stanley.png',
      32: 'stanley.png',
      48: 'stanley.png',
      96: 'stanley.png',
      128: 'stanley.png',
    },
    permissions: ['storage'],
    host_permissions: [
      'http://localhost:8787/*',
      'https://*.up.railway.app/*',
      'https://*.railway.app/*',
    ],
    web_accessible_resources: [
      {
        resources: ['linkedin.svg', 'x.svg', 'x.png', 'x-verified.svg', 'stanley.png'],
        matches: ['https://stanley.stan.store/*', 'https://*.stanley.stan.store/*'],
      },
    ],
  },
  webExt: {
    disabled: true,
  }
});
