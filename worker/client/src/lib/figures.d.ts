// Types for the Worker's tests, which import this client module (test/export.test.ts).
export interface Placeholder { n: number; start: number; end: number; page: number | null; caption: string }
export function findPlaceholders(html: string): Placeholder[];
export function attachImage(html: string, n: number, figure: { filename: string; alt: string; width?: number; height?: number }): string | null;
export function altFromCaption(caption: string): string;
export function escapeAttr(s: string): string;
export function figureName(existing: (string | { filename: string })[], page: number | null, ext?: string): string;
export function cropPixels(rect: { x: number; y: number; w: number; h: number }, w: number, h: number): { x: number; y: number; width: number; height: number };
export function toRgba(img: { width: number; height: number; kind: number; data: Uint8Array | Uint8ClampedArray }): Uint8ClampedArray;
