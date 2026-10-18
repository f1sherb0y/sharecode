# ShareCode - AI Agent Development Log

## Project Overview

**ShareCode** is a real-time collaborative code editing platform built with modern web technologies. The project enables multiple users to simultaneously edit code with real-time synchronization, complete with session playback capabilities.

## Technology Stack

### Frontend
- **Framework**: React 19 + Vite
- **Language**: TypeScript
- **Editor**: Monaco Editor
- **Collaboration**: Yjs + custom Monaco binding
- **Routing**: React Router v6 (HashRouter for desktop)
- **Styling**: CSS Variables (Light/Dark themes)
- **Internationalization**: react-i18next (English & Chinese)
- **HTTP Client**: Fetch API
- **Compression**: pako (gzip)
- **Desktop**: Tauri 2.0 (Rust backend)

### Backend
- **Runtime**: Rust (Tokio)
- **Framework**: Axum
- **WebSocket**: Custom Yjs sync (yrs)
- **Database**: PostgreSQL
- **ORM**: SQLx (query builder)
- **Authentication**: JWT + bcrypt
- **Deployment**: Docker + Docker Compose

## Core Features

### 1. Real-Time Collaborative Editing
- **Multi-user editing**: Multiple users can edit the same document simultaneously
- **CRDT-based sync**: Uses Yjs for conflict-free replicated data types
- **Cursor tracking**: See other users' selections and cursors in real-time
- **Follow mode**: Click on a user (users menu or Canvas avatar) to follow their cursor, view and Canvas camera. One follow state spans code, Markdown and Canvas; only the follower ends it (stop button, menu, or switching views by hand). It pauses while the presenter opts out or is offline, resumes by itself, and survives the follower reloading the tab
- **Live language switching**: Change syntax highlighting without page reload

### 2. User Management
- **Username-based authentication**: Login with username (email optional)
- **Role-based access control**: Three account roles: admin (管理员), agent (中介) and tech (技术). Customers (客户) join through share links without an account
- **Role-only permissions**: No per-account flags; rules live in `server-rs/src/core/permissions.rs` and the SQL function `room_is_visible`
- **Invite-only registration**: Agents and admins issue single-use codes (valid 7 days) from the account menu; registering with one always creates a tech. Admins also create accounts of any role directly
- **JWT tokens**: Secure authentication with 7-day expiration
- **User profiles**: Color-coded users for easy identification

### 3. Room Management
- **Room visibility**: Techs see their own rooms, live pinned rooms (read-only) and rooms they joined by share link; agents and admins see and edit every standard room
- **Share-link membership**: The link a tech last joined through decides whether they can edit; the room stays in their list for replay after it ends
- **Room ownership**: Owners rename, share and end their rooms; only admins delete rooms or create private ones
- **Language support**: 8 programming languages with syntax highlighting
  - JavaScript, TypeScript, Python, Java, C++, Rust, Go, PHP
- **Scheduled sessions**: Optional start time and duration
- **Smart sorting**: Expired rooms shown last, active rooms by schedule

### 4. Session Playback
- **Complete history**: Every keystroke captured as Y.js update
- **Client-side reconstruction**: Fast seeking without server load
- **Gzip compression**: Efficient data transfer (~60-80% reduction)
- **Video-style controls**: Play, pause, skip, speed control (0.5x-10x)
- **Real-world timestamps**: Timeline shows actual clock time
- **Role-aware access**: Owners, staff and link members auto-redirect to playback for ended rooms; guests see an ended-room notice

### 5. Admin Dashboard
- **User management**: View all users, edit roles/permissions, soft delete accounts
- **Room management**: View all rooms with details, delete rooms when permitted
- **Admin-only**: The dashboard, audit log, storage, devices and announcements (`AdminUser` extractor); agents and techs get 404

### 6. Internationalization (i18n)
- **Multi-language support**: English and Chinese translations
- **Language switcher**: Toggle button in toolbar (🌐 EN / 🌐 中文)
- **Comprehensive coverage**: All UI text translatable
- **Persistent preference**: Language stored in localStorage
- **Auto-detection**: Falls back to browser language on first visit

### 7. Responsive Design
- **Desktop-first approach**: Desktop layout (>1024px) preserved unchanged
- **Tablet optimization**: 768px-1024px with moderate spacing adjustments
- **Mobile optimization**: <768px with aggressive space saving
- **Touch-friendly**: Minimum 44px tap targets for buttons
- **Adaptive layouts**: Topbar stacks on mobile, full-width room cards
- **Horizontal scrolling**: User badges scroll horizontally on mobile
- **Compact UI**: Smaller fonts, reduced padding, icon-only badges on very small screens

### 8. Desktop Application (Tauri)
- **Cross-platform packaging**: Native desktop apps for Linux, Windows, and macOS
- **Server configuration**: Configurable HTTP and WebSocket endpoints
- **Connection testing**: Test server connectivity before login
- **Persistent settings**: Server URLs stored in localStorage
- **Conditional features**: Settings page only accessible in desktop environment
- **Native performance**: Rust-based Tauri backend for optimal performance
- **Auto-updates ready**: Infrastructure for seamless app updates

### 9. Scheduling (排班)
- **Calendar page** (`/schedule`): week (default) and day are timelines with hours across, a row per weekday (week) or per tech plus unassigned (day); simultaneous sessions take lanes in legend order; also month and a two-week list (default on phones). Week/day/month fit the window; entry on the room list plus a "Today's sessions" card above it
- **No repeated information**: cards on the timelines show no time (the hour scale gives it); lists print the time once per row of simultaneous sessions, shown side by side when wide enough
- **Agents plan every tech's sessions**: click or drag free time, drag to move (another weekday or another tech's row), stretch the right edge, drop from the unassigned strip above the calendar (it skips sessions the calendar shows); overlaps per tech need "Save anyway", and saves per tech are serialized with advisory locks
- **场次 tab** (staff): customers on the left with "All sessions" first and **+** to add; the right side lists the chosen customer's (or everyone's) sessions with edit/delete for the customer and **New session**; phones show one side at a time
- **Book another** (再约一场): from a session's dialog or the "created" toast, prefills the same customer, tech, agent, company, position and length the next day at the same time
- **Techs**: their own sessions only, read-only; personal notices when a session still to come is assigned, changed, reassigned away or cancelled; no confirmation or availability
- **Session rooms**: created on first "Open room"/"Customer link", owned by the tech, synced with the session while live (time, company/position, owner on reassignment; the previous tech stays a member with edit and replay); never ended for inactivity, only by hand; customer links carry the name and last until the session ends; ending the room completes the session
- **Customers**: one shared list for agents and admins (contact and notes never reach techs); removal waits for upcoming sessions
- **Privacy**: audit events for `customer.*`/`appointment.*` hold IDs, times and changed field names only

## Architecture Highlights

### Unified Server Architecture
```
Single HTTP Server (Port 3001)
├── REST API (Axum routes)
│   ├── /api/auth/* - Authentication
│   ├── /api/rooms/* - Room CRUD
│   ├── /api/admin/* - Admin operations
│   ├── /api/customers/*, /api/appointments/* - Scheduling
│   └── /api/rooms/:id/playback/* - Playback data
└── WebSocket Server (Yjs sync at /api/ws)
    ├── Document sync
    ├── Awareness protocol
    └── Update capture
```

### Database Schema
```
User
├── id, username, email?, password, color, role (admin | agent | tech)
├── isDeleted (soft delete), lastSeen
└── Relations: ownedRooms, rooms (participants)

Room
├── id (UUID - also serves as documentId for Yjs)
├── name, language
├── scheduledTime?, duration?
├── isPrivate, isPinned, isEnded, endedAt, isDeleted
└── Relations: owner, participants

RoomParticipant (share-link and reassignment memberships)
├── roomId, userId
└── canEdit, shareLinkId (last link joined through), canReplay

RegistrationInvite (single-use tech registration codes)
├── id, code, note?, createdBy, createdAt, expiresAt
└── usedAt?, usedBy? (kept as the record of who invited whom)

DocumentUpdate (playback data)
├── id, documentId (references Room.id)
├── update (Bytes)
├── timestamp, userId
└── Index: (documentId, timestamp)

Document (Y.js persistence)
├── id, name (references Room.id)
├── data (Bytes)
└── Stores compiled Y.Doc state

Customer (shared by agents and admins)
├── id, name, contact?, notes?, createdBy
└── isDeleted (soft delete; sessions keep the name)

Appointment (a scheduled session)
├── id, customerId, techId? (null = unassigned), agentId?
├── startsAt, durationMinutes (5-1440), company?, position?, notes?
├── status (scheduled | completed | cancelled; reads completed once its room ends)
├── roomId? (unique; the session's room), createdBy
└── Index: (techId, startsAt), (customerId, startsAt), startsAt

Notification
├── recipientId? (null = site-wide announcement), kind?, data? (JSONB)
└── Schedule notices are personal: kind = schedule.assigned/updated/unassigned/cancelled
```

**Architecture Note**: As of November 2025, `Room.id` is unified with `documentId`. Previously, these were separate fields, which caused routing confusion and API errors. Now `room.id` serves as both the database primary key and the Yjs document identifier, simplifying the architecture.

### Key Technical Decisions

#### 1. Update Storage Strategy
**Decision**: One row per update (not single JSONB array)
**Reason**:
- Atomic operations prevent data loss during concurrent edits
- Efficient timestamp-based queries with database indexes
- Simple cleanup of old sessions
- Standard event-sourcing pattern

#### 2. Playback Reconstruction
**Decision**: Client-side reconstruction (not server-side)
**Reason**:
- Instant seeking without network latency
- Smooth scrubbing experience
- Reduced server CPU load
- Better user experience for timeline navigation

#### 3. Compression Pipeline
**Decision**: Gzip compression before base64 encoding
**Reason**:
- Reduces typical 1-hour session from ~2MB to ~400-800KB
- Transparent to application logic
- Industry-standard compression (pako library)
- Minimal performance overhead

#### 4. Theme Switching
**Decision**: CSS variables + StateEffect.reconfigure
**Reason**:
- No page reload required
- Instant theme changes
- Preserves editor state and history
- No performance impact

#### 5. Internationalization Architecture
**Decision**: react-i18next with separate JSON locale files
**Reason**:
- Industry-standard i18n library for React
- Easy to add new languages (just add JSON file)
- Browser language detection built-in
- Translation keys organized by feature (auth, rooms, editor, etc.)
- No performance overhead (translations loaded once)

## Development Workflow

### 1. Study Phase
- Analyzed y-codemirror.next integration patterns
- Read Yjs/yrs sync protocol documentation and examples
- Created comprehensive notes in `notes/` directory

### 2. Core Implementation
- Set up project structure (frontend + server folders)
- Implemented authentication and room management
- Integrated Monaco Editor with Yjs (custom awareness + selection bridge)
- Established WebSocket sync via custom yrs protocol

### 3. Feature Additions
- Role hierarchy, since October 2026 admin/agent/tech (replacing superuser/admin/user and per-user room flags)
- Admin dashboard
- Room scheduling with expiration
- Session playback system
- Username-based authentication

### 4. UX Improvements
- Unified server on single port
- Theme system (light/dark)
- Smart room sorting
- Real-world time display in playback
- SVG icons for better UI

## Key Implementation Patterns

### 1. Monaco + Yjs Integration
```typescript
const { provider, ytext } = useYjsProvider(documentId, token)

useEffect(() => {
  if (!editorRef.current || !provider || monacoEditorRef.current) return

  loadMonaco().then(monaco => {
    monacoRef.current = monaco
    const model = monaco.editor.createModel(ytext.toString(), resolveLanguage(room.language))
    monacoModelRef.current = model

    const editor = monaco.editor.create(editorRef.current, {
      model,
      automaticLayout: true,
      theme: theme === 'dark' ? 'vs-dark' : 'vs',
      minimap: { enabled: false },
      readOnly: isGuestMode && !canEdit,
    })
    monacoEditorRef.current = editor

    monacoBindingRef.current = new MonacoBinding(
      monaco,
      ytext,
      model,
      new Set([editor]),
      provider.awareness ?? null
    )
  })
}, [provider, ytext, room?.language, theme])
```

### 2. Theme & Language Reconfiguration
```typescript
useEffect(() => {
  monacoRef.current?.editor.setTheme(theme === 'dark' ? 'vs-dark' : 'vs')
}, [theme])

useEffect(() => {
  if (!monacoRef.current || !monacoModelRef.current || !room) return
  monacoRef.current.editor.setModelLanguage(
    monacoModelRef.current,
    resolveLanguage(room.language)
  )
}, [room?.language])
```

### 3. Tauri Desktop Environment Detection
```typescript
// Check if running in Tauri desktop app
const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

// Conditionally render desktop-only features
{isTauri && (
  <button onClick={() => navigate('/settings')}>
    {t('common.settings')}
  </button>
)}
```

### 4. Settings Page with Server Configuration
```typescript
// Load and save server settings
const DEFAULT_SERVER_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000'
const DEFAULT_WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:3000'

// Test server connectivity
const testConnection = async () => {
  const response = await fetch(`${serverUrl}/api/rooms`)
  // 401 = server reachable but not authenticated (success!)
  if (response.ok || response.status === 401) {
    setTestResult({ success: true, message: t('settings.connectionSuccess') })
  }
}

// Persist to localStorage
localStorage.setItem('sharecode_settings', JSON.stringify({ serverUrl, wsUrl }))
```

### 5. Session Playback Reconstruction
```typescript
// Load compressed updates from server
const updates = data.updates.map(u => ({
  ...u,
  update: pako.ungzip(base64ToUint8Array(u.update))
}))

// Reconstruct at any point
const tempDoc = new Y.Doc()
const ytext = tempDoc.getText('codemirror')
updates
  .filter(u => u.timestampMs <= currentTimestamp)
  .forEach(u => Y.applyUpdate(tempDoc, u.update))

monacoModelRef.current?.setValue(ytext.toString())
```

## Challenges and Solutions

### Challenge 1: Concurrent Update Conflicts
**Problem**: Multiple users typing simultaneously could lose updates
**Solution**: Atomic database inserts (one row per update) instead of array append operations

### Challenge 2: Editor Disappearing on Theme Change
**Problem**: Monaco editor re-created on every theme toggle, dropping focus and awareness state
**Solution**: Keep a single Monaco instance and switch `editor.setTheme` / `setModelLanguage` dynamically

### Challenge 3: Follow Mode Cursor Position
**Problem**: Y.js uses relative positions, not absolute numbers
**Solution**: Custom Monaco binding converts Y.RelativePosition to absolute offsets before calling `revealPositionInCenter`

### Challenge 4: Large Playback Data Transfer
**Problem**: Hour-long sessions generate 5000+ updates (~2MB)
**Solution**: Gzip compression reduces to ~400-800KB

### Challenge 5: Room/Document Schema Complexity
**Problem**: Foreign key conflicts during room creation
**Solution**: Simplified to independent document storage by documentId

### Challenge 6: Desktop App Settings UX
**Problem**: Settings button showing in web app, causing confusion
**Solution**: Tauri environment detection with conditional rendering

### Challenge 7: Settings Navigation Context
**Problem**: "Back to Login" button incorrect when accessed from Rooms
**Solution**: Use `navigate(-1)` for smart browser history-based navigation

### Challenge 8: Sorting Stability & Stale UI
**Problem**: Users seeing different UI versions or incorrect sorting order on deployment.
**Solution**: 
- Sorting algorithm fixed to copy array before sorting (avoid in-place mutations).
- Nginx configured to *never* cache `index.html` while caching assets aggressively (cache busting).
- Added `Cache-Control` meta tags to `index.html` as a fail-safe.

## Best Practices Applied

### Security
- **Strict Session Locking**: Ended rooms are read-only for everyone. Private-room and pinned-only access ends with the session; link members of standard rooms keep replay.
- JWT-based authentication with secure secret
- Password hashing with bcrypt (10 rounds)
- Role extractors (`StaffUser`, `AdminUser`) for protected routes; access changes revoke live WebSocket sessions
- CORS configuration for multiple origins
- Soft deletes for data retention

### Performance
- Client-side playback reconstruction
- Gzip compression for data transfer
- Database indexes on critical fields
- Connection pooling via SQLx
- Smart component re-rendering

### Code Quality
- TypeScript throughout for type safety
- Consistent naming conventions
- Separation of concerns (API, middleware, utils)
- Error handling at all levels
- Comprehensive logging

### User Experience
- Instant theme switching
- Real-time language updates
- Smart room sorting
- Visual feedback (connection status, sync status)
- Keyboard shortcuts in editor

## Deployment

### Mandatory release checks

- Before every deployment, run `just predeploy` against the exact source being
  released. A failing check blocks deployment; fix the cause and rerun affected
  checks. Do not silently skip a browser or replace assertions with weaker ones.
- The gate is maintained in `scripts/predeploy.sh`: Rust tests, production
  frontend build, real Chromium/Firefox/WebKit process-restart login tests,
  session renewal while editing, three-browser reconnect/durability recovery,
  all three workspace UI suites (including mobile
  and DPI layouts), admin/agent/tech role permissions, invite-only registration and
  share-link membership rules,
  notes read/write permissions and reader/manager exports, scheduling (customer
  and session API rules, notices, session rooms, and the three-browser calendar
  on desktop and phone), three-browser
  follow opt-out pause/resume and reload persistence across code/Markdown/Canvas rooms,
  Sarasa font/CDN fallback checks, and standalone replay export.
- Prerequisites: `just install`, `just browsers`, Docker running, and the
  `postgres:17-alpine` image available. Font/export checks require network access
  to the pinned CDN dependencies. Session tests use disposable databases only;
  never substitute the development or production database.
- Logs are retained under the printed `/tmp/sharecode-predeploy.*` directory;
  `SHARECODE_PREDEPLOY_LOG_DIR` can select a durable artifact directory. Keep the
  result with the deployment's source manifest. Source changes after validation
  require rerunning the checks they affect before releasing those changes.
- After switching the services, run `just postdeploy` (or supply the target URL),
  verify service health and migrations, and compare public assets to the built
  image. The public smoke suite uses no account and makes no data changes.
- These commands test only; they do not grant permission to deploy. Continue to
  respect the user's current deployment authorization.

### Development
```bash
# Terminal 1: Start PostgreSQL
docker-compose up postgres

# Terminal 2: Start server
cd server-rs
cargo run

# Terminal 3: Start frontend
cd frontend
bun install
bun dev
```

### Production (Web)
```bash
# Build and run all services
docker-compose up --build

# Access application at http://localhost:4173
```

### Desktop Application
```bash
# Install Tauri CLI
cargo install tauri-cli

# Development mode
cd frontend
bun tauri dev

# Build for production
bun tauri build

# Outputs:
# - Linux: .deb and .rpm packages in src-tauri/target/release/bundle/deb/ and src-tauri/target/release/bundle/rpm/
# - Windows: .msi installer in src-tauri/target/release/bundle/msi/ and .exe installer in src-tauri/target/release/bundle/nsis/
# - macOS: .dmg and .app bundles in src-tauri/target/release/bundle/dmg/ and src-tauri/target/release/bundle/macos/

**Windows Build Notes:**
- NSIS installer (.exe) supports both English and Chinese with language selector
- WiX installer (.msi) uses English by default
- Both installers support "current user" installation (no admin required)
- Windows icons (icon.ico) are automatically included
```

### Environment Variables

**Server** (`.env`):
```
DATABASE_URL=postgresql://user:password@localhost:5432/sharecode
JWT_SECRET=your-secret-key
PORT=3001
WS_PATH=/ws
FRONTEND_URL=http://localhost:5173
```

**Frontend** (`.env`):
```
VITE_API_URL=http://localhost:3001
VITE_WS_URL=ws://localhost:3001/ws
```

## Future Enhancements

### Potential Features
- [ ] Code execution/preview for supported languages
- [ ] File tree for multi-file projects
- [ ] Chat system for room participants
- [ ] Screen sharing/video chat integration
- [ ] Git integration for version control
- [ ] Code snippets and templates
- [ ] Collaborative debugging tools
- [ ] Analytics and usage tracking
- [ ] Room invitations and permissions
- [ ] Export session as file/video

### Technical Improvements
- [ ] Horizontal scaling with Redis for awareness
- [ ] CDN for static assets
- [ ] WebSocket reconnection improvements
- [ ] Optimistic UI updates
- [ ] Progressive Web App (PWA) support
- [ ] Mobile responsive design
- [ ] Accessibility improvements (WCAG compliance)
- [ ] Performance monitoring and APM
- [ ] Automated testing (unit, integration, e2e)
- [ ] CI/CD pipeline

## Development Timeline

1. **Phase 1**: Core Infrastructure (Day 1)
   - Project structure setup
   - Database schema design
   - Authentication system
   - Basic room management

2. **Phase 2**: Collaboration Features (Day 1-2)
   - Monaco + Yjs integration (custom binding)
   - Custom Yjs sync server (yrs)
   - Real-time cursor tracking
   - Follow mode implementation

3. **Phase 3**: Advanced Features (Day 2)
   - Admin dashboard
   - Room scheduling
   - Session playback system
   - Update capture and storage

4. **Phase 4**: Polish and Fixes (Day 2-3)
   - Theme system refinement
   - UI/UX improvements
   - Bug fixes (editor visibility, button styling)
   - Room sorting optimization
   - Username-based authentication

5. **Phase 5**: Internationalization (Day 3)
   - i18n infrastructure setup with react-i18next
   - English and Chinese translations for all UI text
   - Language switcher component with consistent styling
   - Translation coverage for Editor, RoomList, and other components
   - Removed unnecessary UI animations for cleaner experience

6. **Phase 6**: Desktop Application (Day 4)
   - Tauri 2.0 integration with Rust backend
   - HashRouter for desktop app compatibility
   - Settings page for server configuration
   - Connection testing functionality
   - Tauri environment detection
   - Conditional feature rendering (desktop-only)
   - Built packages for Linux (.deb and .rpm)
   - i18n support for Settings page

## Lessons Learned

1. **Y.js Integration**: Understanding CRDT principles is crucial for debugging sync issues
2. **React + Monaco**: Careful lifecycle management prevents memory leaks
3. **WebSocket + HTTP**: Single-server architecture simplifies deployment
4. **Theme Switching**: Change Monaco theme/config in place instead of recreating the editor
5. **Database Design**: Event sourcing patterns work well for collaborative systems
6. **Compression**: Always consider data transfer size for real-time applications
7. **Desktop Packaging**: Tauri provides excellent DX for turning React apps into native desktop apps
8. **Environment Detection**: Runtime feature flags enable seamless web/desktop code sharing
9. **HashRouter**: Required for desktop apps; navigate(-1) provides smart back navigation
10. **i18n**: Comprehensive translation coverage from the start prevents technical debt

## Credits

Built with assistance from AI (Cline/Claude), leveraging:
- [Yjs](https://docs.yjs.dev/) - CRDT framework
- [Monaco Editor](https://microsoft.github.io/monaco-editor/) - Code editor
- [Axum](https://github.com/tokio-rs/axum) - Rust web framework
- [SQLx](https://github.com/launchbadge/sqlx) - Async SQL toolkit
- [Tokio](https://tokio.rs/) - Async runtime
- [Bun](https://bun.sh/) - Frontend tooling/runtime

## License

[Specify your license here]

## Contributing

[Specify contribution guidelines if needed]

---

**Last Updated**: November 2, 2025
**Version**: 1.2.0 (Desktop App Release)
**Status**: Production Ready (Web + Desktop)
