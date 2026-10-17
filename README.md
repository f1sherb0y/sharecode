# ShareCode - Collaborative Code Editor

A real-time collaborative code editing platform built with React, Monaco/CodeMirror, and Yjs.

## Features

- 🔐 User authentication (register/login)
- 🏠 Room management (create, join, list rooms)
- 👥 Multi-user real-time collaboration
- 🎨 Syntax highlighting for multiple languages
- 👁️ See other users' cursors and selections in real-time
- 🔄 Follow mode - follow another user's viewport
- 💾 Persistent document storage with PostgreSQL
- 🔒 Room-based access control (including strict session locking for ended rooms)
- 🔑 Role-based access: admin (管理员), agent (中介) and tech (技术) accounts; customers join through share links
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
- Rust (Tokio)
- Axum (REST API)
- Custom Yjs sync server (yrs)
- SQLx
- PostgreSQL database
- JWT authentication
- bcrypt for password hashing

## Prerequisites

### For Local Development
- Bun installed (frontend)
- Rust toolchain (backend)
- PostgreSQL database running

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

**Default Admin Credentials:**
- Username: `admin`
- Password: `admin123`
- Email: `admin@sharecode.local`

**⚠️ IMPORTANT:** Change these credentials in `docker-compose.yml` before deploying to production! This account boots as the first **admin** and can manage every other account.

#### Docker Environment Configuration

Edit `docker-compose.yml` to customize the server environment:

```yaml
environment:
  DATABASE_URL: postgresql://sharecode_app:sharecode@postgres:5432/sharecode?schema=public
  JWT_SECRET: change-me-in-production  # ⚠️ Change this!
  PORT: 3001
  LOG_LEVEL: info  # Options: debug, info, warn, error
  
  # Admin credentials - CHANGE THESE IN PRODUCTION
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

With [just](https://github.com/casey/just), Docker Compose, Rust, Bun, and Node.js installed:

```bash
just install
just up      # Start PostgreSQL, the API, and the frontend in one terminal
```

For separate terminals, use `just server` and `just dev` instead. `just up`
uses `concurrently` to stream labeled application logs and stop both process trees on Ctrl+C or if
either application exits. PostgreSQL stays running; use `just db-stop` to stop it.

Open http://localhost:5173. On a fresh development database, sign in with
`local_admin` / `LocalTest#2026Strong`. Override these local defaults using
`SHARECODE_DEV_ADMIN_USERNAME`, `SHARECODE_DEV_ADMIN_PASSWORD`, and
`SHARECODE_DEV_DATABASE_URL`. The database URL defaults to the credentials in
`docker-compose.dev.yml`. `just` does not load `.env` files; the server still reads
`server-rs/.env` for settings not explicitly supplied by the recipe.

```bash
just                     # List commands
just browsers            # Install test browsers and system dependencies
just test-ui             # Chromium UI tests; no backend required
just test-ui firefox      # Firefox UI tests
just test-ui-all          # Chromium, Firefox, and WebKit
just test-editor          # Collaboration and Markdown regression tests
just test-i18n            # Translation keys, parameters, and untranslated labels
just test-server          # Rust unit tests
just check               # TypeScript and Rust checks
just build               # Production frontend build
just predeploy           # Required release checks; failure blocks deployment
just postdeploy          # Public read-only smoke checks after deployment
just db-stop             # Stop PostgreSQL and keep its data
```

Stop the API and frontend with Ctrl+C in their terminals. UI test screenshots
are written to `/tmp/sharecode-ui-review/<browser>/`. For the full disposable
database integration suite, use `just test-integration`; it requires local
PostgreSQL server binaries (`initdb`, `pg_ctl`, and `createdb`) and cached Rust
dependencies from `just install`. Set `PG_BIN` if the PostgreSQL binaries are
outside the paths detected by the script.

Alternatively, start each service manually:

### 1. Database Setup

Make sure PostgreSQL is running. Update the connection string in `server-rs/.env`:

```env
DATABASE_URL="postgresql://postgres:password@localhost:5432/sharecode?schema=public"
```

### 2. Server Setup

```bash
cd server-rs

# Build (optional)
cargo build

# Start the server
cargo run
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

For local development, create `server-rs/.env` with the following values:

```env
# Database
DATABASE_URL="postgresql://sharecode_app:sharecode@localhost:5432/sharecode?schema=public"

# JWT Secret - CHANGE THIS IN PRODUCTION
JWT_SECRET="your-super-secret-jwt-key-change-in-production"

# Server
PORT=3001

# Frontend URL (for CORS)
FRONTEND_URL="http://localhost:5173"

# App URL (optional, for absolute links)
APP_URL="http://localhost:5173"

# Extra origins serving the same app (other domains, public IP), comma separated.
# Login and session renewal are rejected from any origin not listed here.
# ALLOWED_ORIGINS="https://kode666.com,https://64.186.229.171"

# WebSocket router mode for desktop apps (HashRouter)
FRONTEND_HASH_ROUTER=false

# Logging - Options: debug, info, warn, error (default: info)
LOG_LEVEL="info"

# Allow self-registration as a tech account (default false)
ALLOW_REGISTRATION=false

# Code execution (Piston)
PISTON_URL="http://localhost:2000"

# Admin credentials - CHANGE THESE IN PRODUCTION
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
- `PUT /api/rooms/:roomId` - Rename or change the language (owner, agents and admins)
- `POST /api/rooms/:roomId/end` - End an active room (owner, agents and admins)
- `DELETE /api/rooms/:roomId` - Delete room (admins)
- `POST /api/rooms/:roomId/join` - Join room (authenticated)
- `POST /api/rooms/:roomId/leave` - Leave room (authenticated)
- `POST /api/rooms/:roomId/share-links` - Create a guest share link with view/edit permissions (owner, agents and admins)
- `GET /api/rooms/:roomId/share-links` - List share links for the room (owner, agents and admins)
- `DELETE /api/rooms/:roomId/share-links/:shareLinkId` - Delete an existing share link (owner, agents and admins)

### Share Links (Public)
- `GET /api/share/:token` - Inspect share link details for a guest invite
- `POST /api/share/:token/join` - Join a room as a guest by providing display name/email
- `GET /api/share/session` - Refresh guest session details using the guest token

### Agents and Admins
- `GET /api/admin/users` - List all active users
- `POST /api/admin/users` - Create a user with a role (agents create tech accounts only)
- `PATCH /api/admin/users/:id` - Change a user's role (admins only)
- `DELETE /api/admin/users/:id` - Soft delete a user (agents can only remove tech accounts; the last admin cannot be removed)
- `GET /api/admin/rooms` - List every room the caller can see
- `GET /api/users` - Account list for the owner filter

### Admins Only
- `DELETE /api/admin/rooms/:id` - Delete a room
- `GET /api/admin/storage/db-size` - Database size summary
- `GET /api/admin/storage/playback` - Playback storage per room
- `POST /api/admin/rooms/:id/playback/compress` - Compress playback to 1s resolution

## Permission Matrix

The role alone decides what an account can do; there are no per-account
permission flags. Customers (客户) have no account: a share link decides whether
a guest can edit. Rules are enforced identically on the REST and WebSocket paths
(`server-rs/src/core/permissions.rs` and the SQL function `room_is_visible`).

| Capability | Tech (技术) | Agent (中介) | Admin (管理员) |
| --- | --- | --- | --- |
| See rooms | Own, pinned (while live), joined by link | All standard rooms | All standard rooms |
| Create rooms | Yes | Yes | Yes |
| Edit room content | Own; others if the link allows | All | All |
| Rename, change language, share, end | Own | All | All |
| Replay / export ended rooms | Own and joined by link | All | All |
| Pin rooms | No | Yes | Yes |
| Delete rooms | No | No | Yes |
| Create private rooms | No | No | Yes |
| Manage accounts | No | Create/remove techs | All, including roles |
| Audit log | No | Yes (device data hidden) | Yes |
| Storage, devices, notifications | No | No | Yes |

Notes:

- Pinned rooms are visible to every tech while live, but read-only unless the
  tech owns the room or joined it through an editing link.
- When a tech joins someone else's room through a share link, the link they
  **last** joined through decides whether they can edit; the room stays in their
  list and can be replayed after it ends. Owners and staff who can already see
  the room keep their own access and leave the link unused.
- Members who joined by link edit content only: renaming, the language, share
  links and ending the room stay with the owner, agents and admins.
- Only admins create private rooms. A private room is hidden from everyone except
  its owner, its members and roles ranked above the owner (this covers rooms made
  private before the role change).
- Self-registration is off by default (`ALLOW_REGISTRATION=false`); admins and
  agents create accounts.

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
├── server-rs/                 # Backend server (Rust/Axum)
│   ├── src/
│   │   ├── routes/           # REST API routes
│   │   ├── ws/               # WebSocket protocol + sync
│   │   ├── core/             # Auth/config/state
│   │   └── main.rs
│   └── Cargo.toml
└── README.md
```

## How It Works

### Collaborative Editing

1. **Y.Doc**: Each document is represented as a Yjs document (Y.Doc)
2. **HocuspocusProvider**: Connects to the WebSocket server and syncs the Y.Doc
3. **CodeMirror Binding**: y-codemirror.next binds the editor to the Y.Doc
4. **Awareness**: Tracks user presence (cursor position, selection, user info)
5. **Database**: Documents are persisted as binary (Uint8Array) in PostgreSQL

**Architecture Note**: As of November 2025, `room.id` (UUID) serves as both the database primary key and the Yjs document identifier. This unified architecture simplifies routing and eliminates the need for separate documentId tracking. When you create a room, its UUID becomes the WebSocket document name for collaboration.

### Authentication Flow

1. User registers/logs in via REST API
2. Server returns JWT token
3. Token is stored in localStorage
4. Token is passed to the WebSocket server for authentication
5. Token is included in REST API requests

### Room Access Control

- Room owners manage their own rooms (edit, share, end); only admins delete rooms
- Members who joined through a share link edit only if the link they last used allows it
- Three account roles ship out-of-the-box:
  - **Admin (管理员)** — manages every account and room, including deletion and private rooms
  - **Agent (中介)** — sees, edits, shares, pins and ends every standard room; manages tech accounts
  - **Tech (技术)** — controls personal rooms, sees pinned rooms read-only, and joins others' rooms by link
- Users must be authenticated to access rooms and their current role is validated on every REST/WebSocket request
- The WebSocket server verifies access on every connection and disconnects sessions whose access is revoked (role change, unpinned room, ended room or revoked link)

## License

MIT

## Code runner setup

For local development, run `just runner-up` once to install the required runtimes, then use `just up` as usual. Runtime packages persist across container restarts. `just test-runner` tests execution and stdin for Python, Java, C, C++, JavaScript and TypeScript, error/timeout handling, and administrator room-language permissions with a disposable local database.

For production, from the deployment checkout:

```bash
docker compose -f docker-compose.production.yml --env-file .env.production up -d piston
docker compose -f docker-compose.production.yml --env-file .env.production exec -T piston node < scripts/setup-piston.cjs
```

The installer is idempotent and uses the persistent Piston packages volume. An empty Piston container does not include language runtimes. `/api/code/health` returns 503 if any required language is missing; `/api/code/languages` lists installed languages. Piston's package-management API must remain internal to the deployment network.
