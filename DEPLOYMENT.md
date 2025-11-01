# ShareCode - HTTPS Deployment Guide

This guide explains how to deploy ShareCode with HTTPS/SSL support using Docker on a remote server.

## Prerequisites

- A domain name pointing to your server's IP address (e.g., `sharecode.example.com`)
- Docker and Docker Compose installed on your server
- Ports 80 and 443 open on your firewall
- SSH access to your server

## Option 1: Using Nginx Reverse Proxy with Let's Encrypt (Recommended)

This approach uses a separate Nginx reverse proxy container with automatic SSL certificate management via Certbot.

### Step 1: Update docker-compose.yml

Replace your existing `docker-compose.yml` with this HTTPS-enabled version:

```yaml
version: "3.9"

services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: sharecode
      POSTGRES_USER: sharecode_app
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-sharecode}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U sharecode_app -d sharecode"]
      interval: 10s
      timeout: 5s
      retries: 5
    networks:
      - backend

  server:
    build:
      context: ./server
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      DATABASE_URL: postgresql://sharecode_app:${POSTGRES_PASSWORD:-sharecode}@postgres:5432/sharecode?schema=public
      JWT_SECRET: ${JWT_SECRET}
      PORT: 3001
      FRONTEND_URL: https://${DOMAIN}
      LOG_LEVEL: info
      ADMIN_USERNAME: ${ADMIN_USERNAME:-admin}
      ADMIN_PASSWORD: ${ADMIN_PASSWORD}
      ADMIN_EMAIL: ${ADMIN_EMAIL:-admin@sharecode.local}
    expose:
      - "3001"
    networks:
      - backend

  frontend:
    build:
      context: ./frontend
    restart: unless-stopped
    depends_on:
      - server
    expose:
      - "80"
    networks:
      - backend

  nginx:
    image: nginx:alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro
      - ./nginx/conf.d:/etc/nginx/conf.d:ro
      - ./certbot/conf:/etc/letsencrypt:ro
      - ./certbot/www:/var/www/certbot:ro
    depends_on:
      - frontend
      - server
    networks:
      - backend
    command: "/bin/sh -c 'while :; do sleep 6h & wait $${!}; nginx -s reload; done & nginx -g \"daemon off;\"'"

  certbot:
    image: certbot/certbot
    restart: unless-stopped
    volumes:
      - ./certbot/conf:/etc/letsencrypt
      - ./certbot/www:/var/www/certbot
    entrypoint: "/bin/sh -c 'trap exit TERM; while :; do certbot renew; sleep 12h & wait $${!}; done;'"

volumes:
  pgdata:

networks:
  backend:
    driver: bridge
```

### Step 2: Create Nginx Configuration Directory

Create the necessary directory structure:

```bash
mkdir -p nginx/conf.d
mkdir -p certbot/conf
mkdir -p certbot/www
```

### Step 3: Create Initial Nginx Configuration

Create `nginx/nginx.conf`:

```nginx
user nginx;
worker_processes auto;
error_log /var/log/nginx/error.log warn;
pid /var/run/nginx.pid;

events {
    worker_connections 1024;
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    log_format main '$remote_addr - $remote_user [$time_local] "$request" '
                    '$status $body_bytes_sent "$http_referer" '
                    '"$http_user_agent" "$http_x_forwarded_for"';

    access_log /var/log/nginx/access.log main;

    sendfile on;
    tcp_nopush on;
    keepalive_timeout 65;
    gzip on;

    include /etc/nginx/conf.d/*.conf;
}
```

### Step 4: Create HTTP-only Configuration (Initial Setup)

Create `nginx/conf.d/sharecode.conf`:

```nginx
# HTTP - for Let's Encrypt challenge
server {
    listen 80;
    server_name YOUR_DOMAIN;  # Replace with your domain

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://$server_name$request_uri;
    }
}
```

### Step 5: Create Environment File

Create `.env` in the project root:

```bash
# Domain Configuration
DOMAIN=your-domain.com

# Database
POSTGRES_PASSWORD=your-secure-postgres-password

# JWT Secret (generate with: openssl rand -base64 32)
JWT_SECRET=your-secure-jwt-secret

# Admin Credentials
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your-secure-admin-password
ADMIN_EMAIL=admin@your-domain.com
```

**Important**: Replace all placeholder values with your actual configuration!

### Step 6: Start Services (HTTP Only First)

```bash
# Start services
docker-compose up -d

# Verify nginx is running
docker-compose logs nginx
```

### Step 7: Obtain SSL Certificate

Run Certbot to get your SSL certificate:

```bash
# Replace YOUR_EMAIL and YOUR_DOMAIN with your actual values
docker-compose run --rm certbot certonly --webroot \
  --webroot-path=/var/www/certbot \
  --email YOUR_EMAIL \
  --agree-tos \
  --no-eff-email \
  -d YOUR_DOMAIN
```

### Step 8: Update Nginx Configuration for HTTPS

Update `nginx/conf.d/sharecode.conf` with full HTTPS configuration:

```nginx
# HTTP - redirect to HTTPS
server {
    listen 80;
    server_name YOUR_DOMAIN;  # Replace with your domain

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://$server_name$request_uri;
    }
}

# HTTPS
server {
    listen 443 ssl http2;
    server_name YOUR_DOMAIN;  # Replace with your domain

    # SSL Configuration
    ssl_certificate /etc/letsencrypt/live/YOUR_DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/YOUR_DOMAIN/privkey.pem;
    
    # SSL Security Settings
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;

    # Security Headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;

    # Proxy to Frontend (Nginx serving React app)
    location / {
        proxy_pass http://frontend:80;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
    }

    # API Proxy (to backend server)
    location /api/ {
        proxy_pass http://server:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
    }

    # WebSocket Proxy (for collaborative editing)
    location /api/ws {
        proxy_pass http://server:3001/api/ws;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # WebSocket timeout settings
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
    }

    # Increase upload size if needed
    client_max_body_size 10M;
}
```

### Step 9: Reload Nginx

```bash
docker-compose exec nginx nginx -s reload
```

### Step 10: Verify HTTPS is Working

Visit `https://YOUR_DOMAIN` in your browser. You should see:
- 🔒 Secure connection (padlock icon)
- Your ShareCode application running
- HTTP automatically redirects to HTTPS

## Option 2: Using Caddy (Automatic HTTPS)

Caddy automatically obtains and renews SSL certificates. Update `docker-compose.yml`:

```yaml
version: "3.9"

services:
  postgres:
    # ... (same as above)

  server:
    # ... (same as above)

  frontend:
    # ... (same as above)

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - frontend
      - server
    networks:
      - backend

volumes:
  pgdata:
  caddy_data:
  caddy_config:

networks:
  backend:
    driver: bridge
```

Create `Caddyfile`:

```
YOUR_DOMAIN {
    # Proxy to frontend
    reverse_proxy frontend:80

    # API endpoints
    handle /api/* {
        reverse_proxy server:3001
    }

    # WebSocket support
    @websocket {
        path /api/ws
        header Connection *Upgrade*
        header Upgrade websocket
    }
    reverse_proxy @websocket server:3001
}
```

Then simply run:

```bash
docker-compose up -d
```

Caddy will automatically obtain SSL certificates!

## Security Checklist

- [ ] Change all default passwords in `.env`
- [ ] Use strong JWT_SECRET (generate with `openssl rand -base64 32`)
- [ ] Set secure POSTGRES_PASSWORD
- [ ] Update ADMIN_PASSWORD
- [ ] Configure firewall to only allow ports 80, 443, and SSH
- [ ] Regularly update Docker images
- [ ] Monitor SSL certificate expiration (auto-renewed by certbot)
- [ ] Set up automatic backups for database volume

## Troubleshooting

### Certificate Not Working

```bash
# Check certbot logs
docker-compose logs certbot

# Manually test certificate renewal
docker-compose run --rm certbot renew --dry-run
```

### WebSocket Connection Issues

Ensure your nginx configuration has:
- `proxy_http_version 1.1`
- `proxy_set_header Upgrade $http_upgrade`
- `proxy_set_header Connection "upgrade"`
- Long timeouts for persistent connections

### Mixed Content Errors

Update frontend `.env` to use HTTPS URLs:

```bash
VITE_API_URL=https://YOUR_DOMAIN/api
VITE_WS_URL=wss://YOUR_DOMAIN/api/ws
```

Rebuild frontend:

```bash
docker-compose up -d --build frontend
```

## Maintenance

### Renewing Certificates

Certbot automatically renews certificates. To manually renew:

```bash
docker-compose run --rm certbot renew
docker-compose exec nginx nginx -s reload
```

### Viewing Logs

```bash
# All services
docker-compose logs -f

# Specific service
docker-compose logs -f nginx
docker-compose logs -f server
```

### Backup Database

```bash
# Backup
docker-compose exec postgres pg_dump -U sharecode_app sharecode > backup.sql

# Restore
cat backup.sql | docker-compose exec -T postgres psql -U sharecode_app sharecode
```

## Production Recommendations

1. **Use a reverse proxy** (Nginx or Caddy) for SSL termination
2. **Enable HTTP/2** for better performance
3. **Set up monitoring** (e.g., UptimeRobot, Prometheus)
4. **Configure log rotation** to prevent disk space issues
5. **Use Docker secrets** for sensitive data instead of environment variables
6. **Set up automated backups** for the database
7. **Enable rate limiting** in Nginx to prevent abuse
8. **Use a CDN** for static assets if needed

## Quick Deployment Script

Save this as `deploy.sh`:

```bash
#!/bin/bash

set -e

echo "🚀 Deploying ShareCode with HTTPS..."

# Check if .env exists
if [ ! -f .env ]; then
    echo "❌ .env file not found. Please create it first!"
    exit 1
fi

# Source environment variables
source .env

# Validate required variables
if [ -z "$DOMAIN" ]; then
    echo "❌ DOMAIN not set in .env"
    exit 1
fi

echo "📦 Building and starting services..."
docker-compose up -d --build

echo "✅ Services started!"
echo "📝 Access your application at: https://$DOMAIN"
echo "🔐 Admin credentials: $ADMIN_USERNAME / [check .env]"
```

Make it executable and run:

```bash
chmod +x deploy.sh
./deploy.sh
```

## Support

For issues or questions:
- Check `docker-compose logs` for errors
- Verify domain DNS is pointing to your server
- Ensure ports 80 and 443 are accessible
- Review nginx error logs: `docker-compose logs nginx`

---

**Security Note**: Always use HTTPS in production. Never expose credentials in git repositories. Use strong, unique passwords for all services.
