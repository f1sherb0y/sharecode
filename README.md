# ShareCode - Collaborative Code Editor

A real-time collaborative code editing platform built with React, CodeMirror, Yjs, and Hocuspocus.

## Features

- 🔐 User authentication (register/login)
- 🏠 Room management (create, join, list rooms)
- 👥 Multi-user real-time collaboration
- 🎨 Syntax highlighting for multiple languages
- 👁️ See other users' cursors and selections in real-time
- 🔄 Follow mode - follow another user's viewport
- 💾 Persistent document storage with PostgreSQL
- 🔒 Room-based access control
- 🔑 Fine-grained room permissions (read/write/delete all) with superuser, admin, and user roles
- 🔗 Guest share links with configurable view/edit permissions

## Tech Stack

### Frontend
- React 19 + TypeScript
- Vite (with Rolldown)
- CodeMirror 6
- Yjs (CRDT for collaboration)
- Hocuspocus Provider (WebSocket client)
- React Router for navigation

### Backend
- Bun runtime
- Hocuspocus Server (WebSocket server for Yjs)
- Express (REST API)
- Prisma ORM
- PostgreSQL database
- JWT authentication
- bcrypt for password hashing

## Prerequisites

### For Local Development
- Bun installed
- PostgreSQL database running
- Node.js 18+ (for some dependencies)

### For Docker Deployment
- Docker and Docker Compose installed

## Setup

### Option 1: Docker Deployment (Recommended)

The easiest way to run ShareCode is using Docker Compose:

```bash
# Clone the repository
git clone <repository-url>
cd sharecode

# Start all services (PostgreSQL, server, frontend)
docker compose up -d

# View logs
docker compose logs -f

# Stop all services
docker compose down
```

The application will be available at **http://localhost**

**Architecture:** 
- All requests go through nginx reverse proxy on port 80
- nginx routes `/api/*` requests to the backend server (port 3001)
- nginx serves frontend static files for other paths
- WebSocket connections use `/api/ws`

**Default Superuser Credentials:**
- Username: `admin`
- Password: `admin123`
- Email: `admin@sharecode.local`

**⚠️ IMPORTANT:** Change these credentials in `docker-compose.yml` before deploying to production! This account boots as the first **superuser** and can manage every other account.

#### Docker Environment Configuration

Edit `docker-compose.yml` to customize the server environment:

```yaml
environment:
  DATABASE_URL: postgresql://sharecode_app:sharecode@postgres:5432/sharecode?schema=public
  JWT_SECRET: change-me-in-production  # ⚠️ Change this!
  PORT: 3001
  LOG_LEVEL: info  # Options: debug, info, warn, error
  
  # Superuser credentials - CHANGE THESE IN PRODUCTION
  ADMIN_USERNAME: admin
  ADMIN_PASSWORD: admin123
  ADMIN_EMAIL: admin@sharecode.local
  # ADMIN_UPDATE_PASSWORD: true  # Uncomment to update password on restart
```

#### Rebuild Docker Images

After code changes, rebuild the images:

```bash
# Rebuild and restart all services
docker compose up -d --build

# Rebuild only specific service
docker compose build server
docker compose up -d server
```

#### Access Database

```bash
# Enter PostgreSQL container
docker compose exec postgres psql -U sharecode_app -d sharecode
```

### Option 2: Local Development

### 1. Database Setup

Make sure PostgreSQL is running. Update the connection string in `server/.env`:

```env
DATABASE_URL="postgresql://postgres:password@localhost:5432/sharecode?schema=public"
```

### 2. Server Setup

```bash
cd server

# Install dependencies
bun install

# Generate Prisma client
bun run db:generate

# Run database migrations
bun run db:migrate

# Start the server
bun run dev
```

The server will start on port 3001:
- REST API at `/api/*`
- WebSocket server at `/api/ws`

### 3. Frontend Setup

```bash
cd frontend

# Install dependencies
bun install

# Start dev server
bun run dev
```

The frontend will be available at http://localhost:5173

## Environment Variables

### Server (.env)

For local development, create `server/.env` based on `server/.env.example`:

```env
# Database
DATABASE_URL="postgresql://sharecode_app:sharecode@localhost:5432/sharecode?schema=public"

# JWT Secret - CHANGE THIS IN PRODUCTION
JWT_SECRET="your-super-secret-jwt-key-change-in-production"

# Server
PORT=3001

# Frontend URL (for CORS)
FRONTEND_URL="http://localhost:5173"

# Logging - Options: debug, info, warn, error (default: info)
LOG_LEVEL="info"

# Superuser credentials - CHANGE THESE IN PRODUCTION
ADMIN_USERNAME="admin"
ADMIN_PASSWORD="admin123"
ADMIN_EMAIL="admin@sharecode.local"
# Set to 'true' to update admin password on restart (optional)
# ADMIN_UPDATE_PASSWORD="false"
```

### Frontend (.env)

```env
# For local development without Docker (separate ports)
VITE_API_URL=http://localhost:3001
VITE_WS_URL=ws://localhost:3001/api/ws

# For Docker deployment - comment out the above and nginx will handle routing
# VITE_API_URL=
# VITE_WS_URL=
```

**Note:** The WebSocket server runs on the same port as the REST API at path `/api/ws`.

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login
- `GET /api/auth/profile` - Get user profile (authenticated)

### Rooms
- `POST /api/rooms` - Create new room (authenticated)
- `GET /api/rooms` - Get user's rooms (authenticated)
- `GET /api/rooms/:roomId` - Get room details (authenticated)
- `PUT /api/rooms/:roomId` - Update room (owner or users with write-all permission)
- `POST /api/rooms/:roomId/end` - End an active room (owner or users with delete-all permission)
- `DELETE /api/rooms/:roomId` - Delete room (owner or users with delete-all permission)
- `POST /api/rooms/:roomId/join` - Join room (authenticated)
- `POST /api/rooms/:roomId/leave` - Leave room (authenticated)
- `POST /api/rooms/:roomId/share-links` - Create a guest share link with view/edit permissions (owner)
- `GET /api/rooms/:roomId/share-links` - List share links for the room (owner)
- `DELETE /api/rooms/:roomId/share-links/:shareLinkId` - Delete an existing share link (owner)

### Share Links (Public)
- `GET /api/share/:token` - Inspect share link details for a guest invite
- `POST /api/share/:token/join` - Join a room as a guest by providing display name/email
- `GET /api/share/session` - Refresh guest session details using the guest token

### Admin / Superuser
- `GET /api/admin/users` - List all active users (admin/superuser)
- `POST /api/admin/users` - Create a new user with role + global permissions (admin limited to normal users, superuser for all)
- `PATCH /api/admin/users/:id` - Update role or global permissions
- `DELETE /api/admin/users/:id` - Soft delete a user (admins can only remove normal users)
- `GET /api/admin/rooms` - List all rooms
- `DELETE /api/admin/rooms/:id` - Force-delete a room (requires delete-all permission or superuser)

## Supported Languages

- JavaScript/TypeScript
- Python
- Java
- C/C++
- Rust
- Go
- PHP

## Project Structure

```
sharecode/
├── notes/                     # Learning notes
│   ├── codemirror.md         # CodeMirror + Yjs integration guide
│   └── hocuspocus.md         # Hocuspocus server guide
├── frontend/                  # React frontend
│   ├── src/
│   │   ├── components/       # React components
│   │   ├── hooks/            # Custom hooks
│   │   ├── lib/              # Utilities and API client
│   │   ├── App.tsx
│   │   └── main.tsx
│   └── package.json
├── server/                    # Backend server
│   ├── src/
│   │   ├── api/              # REST API endpoints
│   │   ├── hocuspocus/       # WebSocket server
│   │   ├── middleware/       # Express middleware
│   │   ├── utils/            # Utilities
│   │   └── index.ts
│   ├── prisma/
│   │   └── schema.prisma     # Database schema
│   └── package.json
└── README.md
```

## How It Works

### Collaborative Editing

1. **Y.Doc**: Each document is represented as a Yjs document (Y.Doc)
2. **HocuspocusProvider**: Connects to the WebSocket server and syncs the Y.Doc
3. **CodeMirror Binding**: y-codemirror.next binds the editor to the Y.Doc
4. **Awareness**: Tracks user presence (cursor position, selection, user info)
5. **Database**: Documents are persisted as binary (Uint8Array) in PostgreSQL

### Authentication Flow

1. User registers/logs in via REST API
2. Server returns JWT token
3. Token is stored in localStorage
4. Token is passed to Hocuspocus for WebSocket authentication
5. Token is included in REST API requests

### Room Access Control

- Room owner has full control over their room (edit, delete, manage participants)
- Participants can edit if `canEdit` is true, otherwise they are read-only
- Optional fine-grained permissions allow any user to be granted:
  - **Read all rooms** — view every active/ended room
  - **Write all rooms** — edit any room (implies read-all)
  - **Delete all rooms** — delete or end any room (implies read/write)
- Three role tiers ship out-of-the-box:
  - **Superuser** — manages admins, toggles all permissions, full room control
  - **Admin** — manages regular users and can write all rooms
  - **User** — controls personal rooms and any room the owner explicitly shares
- Users must be authenticated to access rooms and their permission flags are validated on every REST/WebSocket request
- Hocuspocus verifies access on every WebSocket connection and auto-adds participants with read-only or read/write access based on their permissions

## Development

### Run Database Migrations

```bash
cd server
bun run db:migrate
```

### View Database in Prisma Studio

```bash
cd server
bun run db:studio
```

### Generate Prisma Client

```bash
cd server
bun run db:generate
```

## License

MIT
