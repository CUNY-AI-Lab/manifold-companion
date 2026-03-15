# Deploy Manifold Companion to Production

## Context
Deploy the app to a Debian server at `100.111.252.53` behind nginx at `tools.ailab.gc.cuny.edu/manifold-companion/`. The server has two drives (one for installs, one for storage). Other tools already use nginx on this domain — we ADD a location block, not replace the config.

**Server**: 100.111.252.53, user `smorello.adm@gc.cuny.edu`, Debian
**URL**: `https://tools.ailab.gc.cuny.edu/manifold-companion/`

---

## Part 1: Code Changes for Subpath Deployment

The app must work under `/manifold-companion/` subpath. Nginx `proxy_pass http://127.0.0.1:3000/;` (trailing slash) strips the prefix before forwarding to Express, so the server needs no changes. But the **client** must generate URLs prefixed with `/manifold-companion/`.

### 1a. `client/vite.config.js` — Add base path
```js
export default defineConfig({
  base: '/manifold-companion/',
  plugins: [react()],
  // ...
});
```
This makes all built asset references (JS, CSS, images) use `/manifold-companion/assets/...`.

### 1b. `client/src/api/client.js` — Prefix API URLs with base
```js
const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

async function request(url, options = {}) {
  const res = await fetch(`${BASE}${url}`, { ... });
}

export const api = { /* all methods use BASE prefix */ };
export { BASE };
```
`import.meta.env.BASE_URL` is `/manifold-companion/` in production, `/` in dev. Stripping trailing slash gives us the prefix for API calls.

### 1c. `client/src/main.jsx` — React Router basename
```jsx
<BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
```

### 1d. Fix direct URL references in components
These files construct URLs outside the `api` client and need the `BASE` prefix:

- **`TextDetail.jsx`**: EventSource URL, image src attributes
- **`ProjectView.jsx`**: Direct fetch for export, image src attributes

Import `BASE` from `'../api/client'` in each file.

### 1e. `server/index.js` — Make DATA_DIR configurable
```js
const DATA_DIR = process.env.DATA_DIR || join(__dirname, '..', 'data');
```
This lets the production `.env` point to the storage drive.

---

## Part 2: Server Deployment

### 2a. SSH in, check drive layout
```bash
ssh smorello.adm@gc.cuny.edu@100.111.252.53
df -h          # identify storage vs install drives
ls /etc/nginx/sites-enabled/   # see existing nginx config
```

### 2b. Install Node.js 20 (if not present)
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt-get install -y nodejs
```

### 2c. Create directories
```bash
sudo mkdir -p /opt/manifold-companion
sudo mkdir -p /STORAGE_DRIVE/manifold-companion/data   # on storage drive
sudo chown -R www-data:www-data /opt/manifold-companion
sudo chown -R www-data:www-data /STORAGE_DRIVE/manifold-companion/data
```

### 2d. Copy project files to server
```bash
rsync -avz --exclude='node_modules' --exclude='data' --exclude='.env' \
  ./ smorello.adm@gc.cuny.edu@100.111.252.53:/opt/manifold-companion/
```

### 2e. Create production `.env` on server
```
PORT=3000
SESSION_SECRET=<generate-strong-random-secret>
AWS_REGION=us-east-1
BEDROCK_OCR_MODEL=qwen.qwen3-vl-235b-a22b
BEDROCK_TEXT_MODEL=openai.gpt-oss-120b-1:0
ADMIN_EMAIL=<your-admin-email>
ADMIN_PASSWORD=<strong-password>
DATA_DIR=/STORAGE_DRIVE/manifold-companion/data
```

### 2f. Install deps and build
```bash
cd /opt/manifold-companion
sudo -u www-data npm install --production
sudo -u www-data npm run build
```

### 2g. Install systemd service
```bash
sudo cp /opt/manifold-companion/deploy/manifold-companion.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable manifold-companion
sudo systemctl start manifold-companion
```

### 2h. Add nginx location block
Add to the existing `tools.ailab.gc.cuny.edu` server block:
```nginx
location /manifold-companion/ {
    proxy_pass http://127.0.0.1:3000/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_cache_bypass $http_upgrade;
    proxy_read_timeout 300s;
    client_max_body_size 50M;
}
```
```bash
sudo nginx -t && sudo systemctl reload nginx
```

### 2i. Clean `.env` locally
Remove server credentials from local `.env`.

---

## Verification
1. `curl -I https://tools.ailab.gc.cuny.edu/manifold-companion/` → 200 OK
2. Browser: login page loads, assets load (no 404s)
3. Login with admin credentials → dashboard renders
4. Create project, upload image → stored on storage drive
5. Run OCR → SSE stream works through nginx proxy
6. `systemctl status manifold-companion` → active (running)
