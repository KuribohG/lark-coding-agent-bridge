import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { fileURLToPath } from 'node:url';

// Builds the chat page into ONE self-contained index.html written to
// ../../src/channels/web/generated/, which tsup inlines into the bundle as a
// string, like the console: the Web channel serves it with no file or CDN.
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@shared': fileURLToPath(new URL('../shared', import.meta.url)),
    },
  },
  build: {
    outDir: fileURLToPath(new URL('../../src/channels/web/generated', import.meta.url)),
    emptyOutDir: true,
    chunkSizeWarningLimit: 4096,
  },
});
