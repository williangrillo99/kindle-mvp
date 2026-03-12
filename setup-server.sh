#!/bin/bash
# Setup para DigitalOcean Droplet (Ubuntu 22.04+)
# Rodar como root: bash setup-server.sh

set -e

echo "=== Atualizando sistema ==="
apt update && apt upgrade -y

echo "=== Instalando Node.js 20 ==="
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

echo "=== Instalando dependencias do Chromium ==="
npx playwright install-deps chromium

echo "=== Instalando Xvfb (display virtual) ==="
apt install -y xvfb

echo "=== Instalando PM2 (process manager) ==="
npm install -g pm2

echo "=== Clonando projeto ==="
cd /root
git clone https://github.com/SEU_USUARIO/kindle-mvp.git || echo "Repo ja existe"
cd kindle-mvp

echo "=== Instalando dependencias ==="
npm install
cd backend && npm install && npx playwright install chromium && cd ..

echo "=== Configurando PM2 com Xvfb ==="
cat > /root/start-kindle.sh << 'EOF'
#!/bin/bash
export DISPLAY=:99
Xvfb :99 -screen 0 1280x720x24 &
sleep 1
cd /root/kindle-mvp
node backend/server.js
EOF
chmod +x /root/start-kindle.sh

pm2 start /root/start-kindle.sh --name kindle-mvp
pm2 save
pm2 startup

echo ""
echo "=== PRONTO ==="
echo "App rodando em http://$(curl -s ifconfig.me):3001"
echo ""
echo "Comandos uteis:"
echo "  pm2 logs kindle-mvp    # ver logs"
echo "  pm2 restart kindle-mvp # reiniciar"
echo "  pm2 stop kindle-mvp    # parar"
