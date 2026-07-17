// Keep a preload entry for electron-vite, but expose no renderer API.
process.once('loaded', () => undefined)
