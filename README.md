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

- Bun installed
- PostgreSQL database running
- Node.js 18+ (for some dependencies)

## Setup

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

The server will start:
- REST API on port 3001
- WebSocket server on port 1234

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
```env
DATABASE_URL="postgresql://postgres:password@localhost:5432/sharecode?schema=public"
JWT_SECRET="your-super-secret-jwt-key-change-in-production"
PORT=3001
WS_PORT=1234
FRONTEND_URL="http://localhost:5173"
```

### Frontend (.env)
```env
VITE_API_URL=http://localhost:3001
VITE_WS_URL=ws://localhost:1234
```

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login
- `GET /api/auth/profile` - Get user profile (authenticated)

### Rooms
- `POST /api/rooms` - Create new room (authenticated)
- `GET /api/rooms` - Get user's rooms (authenticated)
- `GET /api/rooms/:roomId` - Get room details (authenticated)
- `PUT /api/rooms/:roomId` - Update room (owner only)
- `DELETE /api/rooms/:roomId` - Delete room (owner only)
- `POST /api/rooms/:roomId/join` - Join room (authenticated)
- `POST /api/rooms/:roomId/leave` - Leave room (authenticated)

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

- Room owner has full control (edit, delete, manage)
- Participants can edit if `allowEdit` is true
- Users must be authenticated to access rooms
- Hocuspocus verifies access on every WebSocket connection

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
