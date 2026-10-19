# ShareCode - Collaborative Code Editor

A real-time collaborative code editing platform built with React, Monaco/CodeMirror, and Yjs.

## Features

- 🔐 User authentication with invite-only registration for techs
- 🏠 Room management (create, join, list rooms)
- 👥 Multi-user real-time collaboration
- 🎨 Syntax highlighting for multiple languages
- 👁️ See other users' cursors and selections in real-time
- 🔄 Follow mode - follow another user's viewport
- 💾 Persistent document storage with PostgreSQL
- 🔒 Room-based access control (including strict session locking for ended rooms)
- 🔑 Role-based access: admin (超级管理员, Super admin), agent (管理, Manager) and tech (技术) accounts; customers join through share links
- 🔗 Guest share links with configurable view/edit permissions
- 📅 Scheduling (排班): a work table per tech where 管理 book free time and clashes are refused, techs mark busy time and pin a note; behind it, a full calendar and a 场次 page of customers and their sessions; techs are notified and open the session's room from it

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
database integration suite, use `just test-integration`; it needs the `psql`
client, cached Rust dependencies from `just install`, and either local
PostgreSQL server binaries (`initdb`, `pg_ctl`, and `createdb`; set `PG_BIN` if
they are outside the paths the script detects) or Docker with the
`postgres:17-alpine` image, which it uses for a throwaway database otherwise.

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
- `POST /api/auth/register` - Register a tech account with an invite code (`{ username, password, inviteCode }`)
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
- `POST /api/share/:token/join` - Join a room as a guest by providing a display name
- `GET /api/share/session` - Refresh guest session details using the guest token

### Agents and Admins
- `GET /api/users` - Account list for the owner filter
- `PUT /api/rooms/:roomId/pin` - Pin or unpin a room
- `POST /api/invites` - Create a single-use registration code for a tech (valid 7 days, optional note)
- `GET /api/invites` - List invites (agents see their own; admins see all)
- `DELETE /api/invites/:id` - Withdraw an unused invite (its issuer or an admin)
- `GET /api/tours` - Guided tours the caller has seen (`{ seen: [...] }`)
- `PUT /api/tours/:id` - Mark a tour seen (`schedule`); unknown tours answer 404

### Scheduling
Techs get their own sessions only and every other scheduling endpoint answers
them 404; agents and admins plan everyone's.
- `GET /api/appointments?from=&to=` - Sessions overlapping a range of at most 100 days (RFC 3339 times; optional `techId`, `customerId`, `unassigned=true`, and `mine=true` for the caller's own: sessions of customers they created and sessions they planned)
- `GET /api/appointments/:id` - One session
- `POST /api/appointments` - Plan a session (`{ customerId, techId?, startsAt, durationMinutes?, company?, position?, notes?, allowConflicts? }`); the caller is its creator, and an overlap with the tech's other sessions answers 409 with the `conflicts` unless `allowConflicts` is set
- `PUT /api/appointments/:id` - Move, reassign or edit a session (any subset of the fields above)
- `DELETE /api/appointments/:id` - Delete a session planned by mistake or called off
- `POST /api/appointments/:id/room` - Open the session's room, creating it on first use (`{ language?, replace? }`; the assigned tech, agents and admins)
- `GET /api/customers?q=&page=&pageSize=&mine=` - The shared customer list, searched by name or contact; `mine=true` keeps the caller's own
- `POST /api/customers`, `GET/PUT/DELETE /api/customers/:id` - Add, view (with the customer's sessions), edit or remove a customer
- `POST /api/notifications/read` - Mark the given notifications read (`{ ids }`, 1-100)

### Admins Only
Every `/api/admin/*` endpoint answers 404 to agents and techs.
- `GET /api/admin/users` - List all active users
- `POST /api/admin/users` - Create a user with any role
- `PATCH /api/admin/users/:id` - Change a user's role
- `DELETE /api/admin/users/:id` - Soft delete a user (the last admin cannot be removed)
- `GET /api/admin/rooms` - List every room the admin can see
- `DELETE /api/admin/rooms/:id` - Delete a room
- `GET /api/admin/audit` - Audit log
- `GET /api/admin/users/:id/devices` - Device history for an account
- `POST /api/admin/notifications` - Publish a site-wide announcement
- `GET /api/admin/storage/db-size` - Database size summary
- `GET /api/admin/storage/playback` - Playback storage per room
- `POST /api/admin/rooms/:id/playback/compress` - Compress playback to 1s resolution

## Permission Matrix

The role alone decides what an account can do; there are no per-account
permission flags. Customers (客户) have no account: a share link decides whether
a guest can edit. Rules are enforced identically on the REST and WebSocket paths
(`server-rs/src/core/permissions.rs` and the SQL function `room_is_visible`).

| Capability | Tech (技术) | Agent (管理) | Admin (超级管理员) |
| --- | --- | --- | --- |
| See rooms | Own, pinned (while live), joined by link | All standard rooms | All standard rooms |
| Create rooms | Yes | Yes | Yes |
| Edit room content | Own; others if the link allows | All | All |
| Rename, change language, share, end | Own | All | All |
| Replay / export ended rooms | Own and joined by link | All | All |
| Pin rooms | No | Yes | Yes |
| Delete rooms | No | No | Yes |
| Create private rooms | No | No | Yes |
| Invite techs (registration codes) | No | Yes | Yes |
| Schedule: see sessions | Own, read-only | All | All |
| Schedule: plan, move, reassign, delete | No | Yes | Yes |
| Customer list (contacts, notes) | No | Yes | Yes |
| Admin dashboard: accounts, audit log, storage, devices, announcements | No | No | Yes |

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
- Registration is invite-only. Agents and admins create single-use codes from
  the account menu (**Invite techs**); a code is valid for 7 days, and an unused
  code stops working once its issuer is removed or is no longer an agent or admin.
  Registering with a code always creates a tech. Admins can also create accounts
  of any role in the admin dashboard.
- Everyone can rename themselves in **Settings**, once a week. No two accounts
  share a name, whatever the case.

### Scheduling (排班)

The **Schedule** button on the room list opens the **work tables** (工作表): one
table per tech with a week of their sessions, hours running down the page.
Phones show one day at a time under a week strip; wider screens show the week.

- 管理 and 超级管理员 pick a tech's table from the chip at the top, click free
  time (or **+**) and book it: date, start, end, company, position, the 管理 it
  belongs to (whoever books, unless they pick another) and notes. A time already taken on that table is refused, with
  who booked it. Cards show the 管理 who booked, the time, company and position.
- A tech sees only their own table and cannot book on it. With the 标记占用
  button at the top right turned on, clicks on free time mark busy time (占用),
  which keeps bookings out; they also pin a note above it (置顶说明) from the "···" menu. Busy time
  may cover a session already booked; both then turn red until someone moves one.
- Staff share a table with the share button at the top right, which copies its
  link (`/t/<link>`). Whoever opens it sees that table without signing in, with
  each session's 管理, time, company, position and notes but no customer and no
  rooms, and may only pin the note and mark busy time; 管理 already signed in
  get the table itself to edit, and 如要编辑请登录 signs in and comes back. 重置链接 in the "···" menu stops the old link
  and copies the new one.
- For a tech without an account, staff make a new table (新建工作表) from the
  chip; its link is copied at once. Once the tech registers, 合并到账号 moves its
  sessions, busy time, note and link into their account.
- A session's details hold its room buttons; staff edit or delete it there.
- 名单 in the "···" menu keeps two lists of names: the techs whose tables show
  and the 管理 sessions are booked for. A name can stand for an account or for
  someone without one, linked to their account later.
- The house at the top left goes back to the rooms; the "···" menu leads staff
  to the **full calendar** (完整排班) described below. The table chip has
  新建工作表 first, then a search and the tables a page at a time.

The full calendar (`/schedule/full`) is as wide as the room list
and has two tabs for agents and admins: **Calendar** and **场次 (Sessions)**.
Techs see only the calendar. Above the room list, **Today's sessions** shows the
sessions from two hours ago to ten hours ahead with their room buttons;
yesterday's and tomorrow's say so.

- Each customer belongs to the agent who created it. **Only mine** (只看我的),
  beside the tabs and on by default for agents, keeps the sessions of their own
  customers and the sessions they planned, in the calendar, the 场次 tab and
  Today's sessions. Admins see everything.

- For customers abroad, the calendar toolbar has a time zone switch: China
  Standard, Eastern, Pacific, United Kingdom or Central European Time. Only the
  calendar changes; the 场次 tab and the rest of the app keep China time. The
  session form opens in the calendar's zone and has its own switch, so a time can
  be entered in the customer's zone. Switching keeps the day view where it is
  (only the hours above it change) and shows the week in that zone's days. New rooms and new sessions share the same
  date, start and length fields. The legend above the calendar lists the agents
  whose customers have sessions in view, one color each.
- The person picker in the toolbar lists techs, 管理 and 超级管理员 together by
  name, since anyone can take a session. Choosing one shows that person's
  sessions, every agent's, so their free time is right; what is drawn or dropped
  on it is theirs, and the **Unassigned** strip above then lists every session
  waiting for a tech. In the day view a name opens that person's calendar.

- On their first visit, agents get a short guided tour of the page, on any
  device: adding a customer, planning a session, and moving and assigning
  sessions on the calendar, with Back, Next and Skip. It is shown once per
  account.

- The calendar shows a week, a day, a month or a two-week list; phones open the
  list. Week and day are timelines with the hours across: the week is days down
  the page without end and without a scrollbar (the wheel, dragging, a flick or
  the arrow keys move it; only the days in view are drawn), opening on the
  current week; the day has a row for each person with sessions that day (or
  in the hours shown) and one for unassigned sessions if there are any, or else
  a single unnamed row to plan on.
  Sessions at the same time in a row sit in lanes one under another, in tech
  order. Both show the whole day, 00:00 to 24:00, at first. Ctrl and the wheel
  (or a pinch) zoom in on as little as two hours around the pointer, and
  dragging free space (or swiping, Shift+wheel, the arrow keys) moves the
  hours: within the day in the week, on through the days without end in the
  day view, where a long dashed line marks where a day turns, with that day's
  date. A marker at a row's edge counts the sessions beyond the hours and
  brings them in. A red line for now runs down the whole calendar, and
  **Reset** at the bottom right brings back today and the whole day. The
  timelines load a week of sessions at a time around what is in view. Week,
  day and month fit the window's height.
- Sessions still waiting for a tech are striped wherever they appear.
- Session cards are four lines: the customer's 管理, the customer, the tech
  (week view) and the company and position, never the time: the hours above
  the rows give it. Month entries
  show the time, the customer and the tech (not on one tech's calendar). The list views
  print each time once per row of simultaneous sessions, which sit side by side
  where there is room. The UI does not repeat information shown nearby.
- A session has a customer, a tech (or none yet), a start, a duration (5 minutes
  to 24 hours), the company and position, and notes. Whoever plans it is its
  creator; there is no agent in charge to pick. It has no status to set: one
  planned by mistake or called off is deleted, and it reads as completed once
  its room has ended. Agents and admins plan any tech's sessions: press **Add**
  and click or drag on the timeline (in the month and list it opens the form),
  drag a session to move it (to another day in the week view,
  another tech's row in the day view), drag its right edge to change its length,
  or drop one from the **Unassigned** strip above the calendar, which lists
  sessions waiting for a tech that the calendar does not already show (and is
  hidden when there are none). Techs do not confirm sessions or give
  availability.
- **场次** lists customers on the left (search, **+** to add one) with a count of
  their upcoming sessions, and **All sessions** at the top. The right side shows
  the chosen customer's sessions, upcoming then past, or everyone's (the next
  100 days, and earlier ones a month at a time). From there agents edit or delete
  the customer and add a session for them with **New session**, which then does
  not ask for the customer again; phones show one side at a time. The customer
  search in the session form shows each customer's upcoming count.
- Overlapping a tech's other session needs a second click, **Save anyway**;
  back-to-back sessions are fine. Saves for the same tech are serialized, so two
  planners cannot double-book them unnoticed.
- Techs get a notice (a toast and the notifications page) when a session still
  to come is assigned to them, changed, given to someone else or deleted
  (shown as cancelled). These notices are personal; announcements stay
  site-wide.
- The first **Open room** or **Customer link** creates the session's room,
  owned by its tech (or by the agent opening it while it is unassigned) and
  carrying its time, company and position. It is named after the company and
  position (场次 without either), never the customer. While the room is live it
  follows the session: new times sync, the name follows the company and position
  unless someone renamed the room, and reassigning the session hands the room to
  the new tech, while the previous tech stays a member who can still edit it and
  replay it after it ends. A session that is over without a room offers no room
  buttons. Customer links fill in the customer's name and stay valid
  until the session ends (at least 6 hours). A session's room is never ended for
  inactivity, even after the session: it is ended by hand. Once the room ends,
  the session reads as completed with replay and download; **New room** starts
  over.
- Customers are one list shared by agents and admins (each still belongs to the
  agent who created it, for **Only mine**). Techs see a session's
  customer name, never the contact or profile notes. A customer with sessions
  still to come cannot be removed; past sessions keep the name. Removing a tech's
  account returns their upcoming sessions to the unassigned list.
- The audit log records `customer.*` and `appointment.*` actions with IDs,
  times and changed field names only, never names, contacts or notes.

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
  - **Admin (超级管理员)** — manages every account and room, including deletion and private rooms
  - **Agent (管理)** — sees, edits, shares, pins and ends every standard room; invites techs
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
