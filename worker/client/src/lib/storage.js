// window.localStorage, or a do-nothing stand-in where it is unavailable (some
// private modes throw on access). Drafts are a convenience: losing them must
// never break editing.
const none = { length: 0, key: () => null, getItem: () => null, setItem: () => {}, removeItem: () => {} };
export function browserStorage() {
  try { return window.localStorage ?? none; } catch { return none; }
}
