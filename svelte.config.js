import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		// SPA: no server, everything runs client-side. A single fallback
		// document is served for every route so the app can be hosted as
		// plain static files (and installed as a PWA).
		adapter: adapter({ fallback: 'index.html' })
	}
};

export default config;
