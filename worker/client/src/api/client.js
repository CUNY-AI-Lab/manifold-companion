import { createApi } from './core';

export const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
export const API = `${BASE}/api`;
export const api = createApi({ base: BASE, fetchImpl: (...a) => fetch(...a), navigate: (url) => window.location.assign(url) });
export { ApiError } from './core';
