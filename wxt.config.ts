import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  manifestVersion: 3,
  manifest: {
    name: 'Stanley-X',
    version: '0.1.0',
    description: 'LinkedIn draft observer for Stanley thread pages.',
    permissions: ['storage'],
  },
});
