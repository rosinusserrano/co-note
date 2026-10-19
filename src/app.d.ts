// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces

/// <reference types="vite-plugin-pwa/info" />
/// <reference types="vite-plugin-pwa/client" />

declare global {
	/** When this build was made (vite.config.ts). */
	const __BUILD_ID__: string;
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
