import { reactRouter } from '@react-router/dev/vite';
import { defineConfig } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';
import tailwindCssVitePlugin from '@qwery/tailwind-config/vite';

export default defineConfig(({ command }) => ({
  plugins: [
    reactRouter(),
    tsconfigPaths(),
    ...tailwindCssVitePlugin.plugins,
  ],
  resolve: {
    dedupe: ['react', 'react-dom', '@radix-ui/react-direction'],
  },
  server: {
    port: 4097,
    host: '0.0.0.0',
  },
  ssr: {
    noExternal: command === 'build' ? true : [],
    external: ['pg', 'pg-native'],
  },
  build: {
    sourcemap: false,
    rollupOptions: {
      external: (id: string) => id.startsWith('node:'),
    },
  },
}));
