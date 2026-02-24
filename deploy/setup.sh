#!/bin/bash
# CAIL OCR Manifold Companion — Debian Setup Script
# Run as root on the target server

set -e

APP_DIR="/opt/manifold-companion"
DATA_DIR="${1:-$APP_DIR/data}"   # Pass storage path as arg, or default to $APP_DIR/data
APP_USER="www-data"

echo "=== CAIL OCR Manifold Companion Setup ==="
echo "App directory:  $APP_DIR"
echo "Data directory: $DATA_DIR"

# Install Node.js 20 if not present
if ! command -v node &> /dev/null; then
  echo "Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "Node.js version: $(node --version)"

# Create app directory and data directory (may be on different drives)
mkdir -p "$APP_DIR"
mkdir -p "$DATA_DIR"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
chown -R "$APP_USER:$APP_USER" "$DATA_DIR"

echo ""
echo "Setup complete. Next steps:"
echo ""
echo "1. Copy the project files to $APP_DIR"
echo "2. Create $APP_DIR/.env with:"
echo "   PORT=3000"
echo "   SESSION_SECRET=<generate-strong-random-secret>"
echo "   AWS_REGION=us-east-1"
echo "   BEDROCK_OCR_MODEL=qwen.qwen3-vl-235b-a22b"
echo "   BEDROCK_TEXT_MODEL=openai.gpt-oss-120b-1:0"
echo "   ADMIN_EMAIL=<admin-email>"
echo "   ADMIN_PASSWORD=<strong-password>"
echo "   DATA_DIR=$DATA_DIR"
echo "   TRUST_PROXY=true"
echo "   COOKIE_SECURE=true"
echo "3. Run: cd $APP_DIR && sudo -u $APP_USER npm install --production"
echo "4. Run: cd $APP_DIR && sudo -u $APP_USER npm run build"
echo "5. If DATA_DIR is not $APP_DIR/data, update ReadWritePaths in"
echo "   deploy/manifold-companion.service to include $DATA_DIR"
echo "6. Copy the service file:"
echo "   cp $APP_DIR/deploy/manifold-companion.service /etc/systemd/system/"
echo "7. Enable and start:"
echo "   systemctl daemon-reload"
echo "   systemctl enable manifold-companion"
echo "   systemctl start manifold-companion"
echo "8. Check status: systemctl status manifold-companion"
echo "9. View logs: journalctl -u manifold-companion -f"
echo ""
echo "For reverse proxy (Nginx), see deploy/nginx.conf"
