import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  manifestVersion: 3,
  manifest: {
    name: 'Stanley-X',
    version: '0.1.0',
    description: 'LinkedIn draft observer for Stanley thread pages.',
    permissions: ['storage'],
    host_permissions: ['http://localhost:8787/*'],
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
