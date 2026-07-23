/**
 * Ambient type declarations for @earendil-works/pi-ai (optional peer dep).
 */

declare module "@earendil-works/pi-ai" {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	export function StringEnum<T extends readonly string[]>(
		values: T,
		options?: { description?: string; default?: T[number] },
	): any;
}
