const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

async function request(url, options = {}) {
  const res = await fetch(`${BASE}${url}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    credentials: 'same-origin',
    ...options,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.error || `Request failed: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export const api = {
  get: (url) => request(url),
  post: (url, body) => request(url, { method: 'POST', body: JSON.stringify(body) }),
  put: (url, body) => request(url, { method: 'PUT', body: JSON.stringify(body) }),
  del: (url) => request(url, { method: 'DELETE' }),
  upload: async (url, formData) => {
    const res = await fetch(`${BASE}${url}`, { method: 'POST', body: formData, credentials: 'same-origin' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const err = new Error(data.error || `Upload failed: ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }
};

export { BASE };
