#!/bin/bash
# CAIL OCR Manifold Companion — Debian Setup Script
# Run as root on the target server

set -e

APP_DIR="/opt/manifold-companion"
APP_USER="www-data"

echo "=== CAIL OCR Manifold Companion Setup ==="

# Install Node.js 20 if not present
if ! command -v node &> /dev/null; then
  echo "Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "Node.js version: $(node --version)"

# Create app directory
mkdir -p "$APP_DIR/data"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

echo ""
echo "Setup complete. Next steps:"
echo ""
echo "1. Copy the project files to $APP_DIR"
echo "2. Copy .env to $APP_DIR/.env and fill in credentials"
echo "3. Run: cd $APP_DIR && npm install --production"
echo "4. Run: cd $APP_DIR && npm run build"
echo "5. Copy the service file:"
echo "   cp $APP_DIR/deploy/manifold-companion.service /etc/systemd/system/"
echo "6. Enable and start:"
echo "   systemctl daemon-reload"
echo "   systemctl enable manifold-companion"
echo "   systemctl start manifold-companion"
echo "7. Check status: systemctl status manifold-companion"
echo "8. View logs: journalctl -u manifold-companion -f"
echo ""
echo "For reverse proxy (Nginx), add to your server block:"
echo "  location /manifold-companion/ {"
echo "    proxy_pass http://127.0.0.1:3000/;"
echo "    proxy_http_version 1.1;"
echo "    proxy_set_header Upgrade \$http_upgrade;"
echo "    proxy_set_header Connection 'upgrade';"
echo "    proxy_set_header Host \$host;"
echo "    proxy_set_header X-Real-IP \$remote_addr;"
echo "    proxy_cache_bypass \$http_upgrade;"
echo "  }"
