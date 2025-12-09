# ShareCode Backend - Development Environment Setup

This guide will help you set up the backend development environment.

## Prerequisites

- Node.js 18+ or Bun
- Docker and Docker Compose (for database)

## Quick Start

### 1. Start the Database

```bash
# From project root
docker compose -f docker-compose.dev.yml up -d

# Verify database is running
docker compose -f docker-compose.dev.yml ps
```

### 2. Set Up Environment Variables

The `.env` file has been created for you with development-friendly defaults:

```bash
cd server
cat .env
```

**Key Configuration:**
- Database: PostgreSQL on localhost:5432
- Port: 3000 (backend API)
- Frontend: http://localhost:5173 (CORS allowed)
- Registration: Enabled for development
- Log Level: Debug (verbose logging)

### 3. Install Dependencies

```bash
cd server
npm install
# or
bun install
```

### 4. Set Up Database Schema

```bash
# Run Prisma migrations
npx prisma migrate dev

# Or generate Prisma client
npx prisma generate
```

### 5. Start the Backend

```bash
npm run dev
# or
bun run dev
```

The backend should now be running at **http://localhost:3000**

## Default Admin Credentials

For development, a default admin user is created:
- **Username**: admin
- **Password**: admin123
- **Email**: admin@sharecode.local

## Environment Variables Explained

| Variable | Value | Description |
|----------|-------|-------------|
| `DATABASE_URL` | `postgresql://sharecode:sharecode_dev_password@localhost:5432/sharecode` | Matches Docker Compose database |
| `JWT_SECRET` | `dev-jwt-secret-change-this-in-production-please` | Used to sign JWT tokens |
| `PORT` | `3000` | Backend server port |
| `FRONTEND_URL` | `http://localhost:5173` | Frontend URL for CORS |
| `LOG_LEVEL` | `debug` | Verbose logging for development |
| `ALLOW_REGISTRATION` | `true` | Allow new user registration |

## Testing the Backend

### 1. Health Check

```bash
curl http://localhost:3000/health
```

### 2. Register a User (via Frontend)

1. Open http://localhost:5173
2. Click "Register"
3. Create a new account

### 3. Test API Directly

```bash
# Login
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}'

# Get profile (replace TOKEN with JWT from login response)
curl http://localhost:3000/api/auth/profile \
  -H "Authorization: Bearer TOKEN"
```

## Database Management

### View Database with pgAdmin

1. Open http://localhost:5050
2. Login: `admin@example.com` / `admin`
3. Add server:
   - Name: ShareCode Local
   - Host: postgres
   - Port: 5432
   - Username: sharecode
   - Password: sharecode_dev_password

### Prisma Studio (Alternative)

```bash
cd server
npx prisma studio
```

Opens at http://localhost:5555

### Reset Database

```bash
# From project root
docker compose -f docker-compose.dev.yml down -v
rm -rf data/postgres

# Restart and re-migrate
docker compose -f docker-compose.dev.yml up -d
cd server
npx prisma migrate dev
```

## Common Issues

### Port 3000 Already in Use

Edit `server/.env` and change:
```env
PORT=3001
```

Don't forget to update frontend `.env`:
```env
VITE_API_URL=http://localhost:3001
VITE_WS_URL=ws://localhost:3001
```

### Database Connection Refused

Make sure Docker Compose is running:
```bash
docker compose -f docker-compose.dev.yml ps
docker compose -f docker-compose.dev.yml logs postgres
```

### Prisma Client Not Generated

```bash
cd server
npx prisma generate
```

## Full Development Stack

To run the complete development environment:

```bash
# Terminal 1: Database
docker compose -f docker-compose.dev.yml up

# Terminal 2: Backend
cd server
npm run dev

# Terminal 3: Frontend
cd frontend-v2
npm run dev
```

Access:
- **Frontend**: http://localhost:5173
- **Backend**: http://localhost:3000
- **pgAdmin**: http://localhost:5050
- **Database**: localhost:5432

## Production Notes

⚠️ **Before deploying to production:**

1. Change `JWT_SECRET` to a strong random string
2. Set `ALLOW_REGISTRATION="false"` (or manage carefully)
3. Use strong admin password
4. Set `LOG_LEVEL="warn"` or `"error"`
5. Use managed database service
6. Enable SSL/TLS
7. Set up proper CORS origins
8. Use environment variable secrets management

## Next Steps

1. ✅ Database running via Docker
2. ✅ Backend configured and running
3. ✅ Frontend running (see `frontend-v2/`)
4. 🎯 Start developing!

For frontend setup, see: [frontend-v2/README.md](../frontend-v2/README.md)
