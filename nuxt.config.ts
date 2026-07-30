export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: false },
  app: {
    head: {
      title: 'Terrain — development harness',
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      ],
    },
  },
  vite: {
    // three is large and stable; pre-bundling it keeps dev reloads quick.
    optimizeDeps: { include: ['three'] },
  },
})
