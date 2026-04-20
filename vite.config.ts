import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

import { cloudflare } from "@cloudflare/vite-plugin";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), cloudflare()],

  define: {
    global: 'globalThis',
  },

  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      buffer: 'buffer',
    },
  },

  server: {
    port: 8888,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/auth': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/instruments-gz': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/nubra-optionchains': {
        target: 'https://api.nubra.io/optionchains',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/nubra-optionchains/, ''),
      },
    },
  },

  preview: {
    port: 8888,
  },

  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 800,  // antd is 713kB gzip:213kB — acceptable for lazy page
    rollupOptions: {
      onwarn(warning, warn) {
        // protobufjs uses indirect eval via string replace — safe to suppress
        if (warning.code === 'EVAL' && warning.id?.includes('protobufjs')) return;
        warn(warning);
      },
      output: {
        manualChunks(id) {
          // React core
          if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/')) return 'react';
          // Charting libs (heavy)
          if (id.includes('node_modules/lightweight-charts')) return 'charts';
          if (id.includes('node_modules/@amcharts')) return 'amcharts';
          // Data grid (heavy)
          if (id.includes('node_modules/@glideapps')) return 'datagrid';
          // Radix UI + shadcn components
          if (id.includes('node_modules/@radix-ui')) return 'radix';
          // TanStack table
          if (id.includes('node_modules/@tanstack')) return 'table';
          // Recharts + tremor (dashboard charts)
          if (id.includes('node_modules/recharts') || id.includes('node_modules/@tremor')) return 'dashcharts';
          // Date utils
          if (id.includes('node_modules/date-fns') || id.includes('node_modules/@internationalized')) return 'dates';
          // protobuf + pako + otplib (binary/compression/auth)
          if (id.includes('node_modules/protobufjs') || id.includes('node_modules/pako') || id.includes('node_modules/otplib')) return 'binary';
          // Ant Design (heavy)
          if (id.includes('node_modules/antd') || id.includes('node_modules/@ant-design') || id.includes('node_modules/rc-')) return 'antd';
          // Lodash
          if (id.includes('node_modules/lodash')) return 'lodash';
          // Everything else in node_modules → vendor
          if (id.includes('node_modules/')) return 'vendor';
        },
      },
    },
  },
});