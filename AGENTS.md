# ShareCode - AI Agent Development Log

## Project Overview

**ShareCode** is a real-time collaborative code editing platform built with modern web technologies. The project enables multiple users to simultaneously edit code with real-time synchronization, complete with session playback capabilities.

## Technology Stack

### Frontend
- **Framework**: React 19 + Vite
- **Language**: TypeScript
- **Editor**: CodeMirror 6
- **Collaboration**: Yjs + y-codemirror.next
- **Routing**: React Router v6 (HashRouter for desktop)
- **Styling**: CSS Variables (Light/Dark themes)
- **Internationalization**: react-i18next (English & Chinese)
- **HTTP Client**: Fetch API
- **Compression**: pako (gzip)
- **Desktop**: Tauri 2.0 (Rust backend)

### Backend
- **Runtime**: Bun
- **Framework**: Express
- **WebSocket**: Hocuspocus (Y.js WebSocket provider)
- **Database**: PostgreSQL
- **ORM**: Prisma
- **Authentication**: JWT + bcrypt
- **Deployment**: Docker + Docker Compose

## Core Features

### 1. Real-Time Collaborative Editing
- **Multi-user editing**: Multiple users can edit the same document simultaneously
- **CRDT-based sync**: Uses Yjs for conflict-free replicated data types
- **Cursor tracking**: See other users' selections and cursors in real-time
- **Follow mode**: Click on a user to follow their cursor position
- **Live language switching**: Change syntax highlighting without page reload

### 2. User Management
- **Username-based authentication**: Login with username (email optional)
- **Role-based access control**: Admin and regular user roles
- **JWT tokens**: Secure authentication with 7-day expiration
- **User profiles**: Color-coded users for easy identification

### 3. Room Management
- **Public rooms**: All authenticated users can see and join any room
- **Room ownership**: Creators maintain admin rights (delete, end session)
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

### 5. Admin Dashboard
- **User management**: View all users, soft delete non-admin users
- **Room management**: View all rooms with details, delete any room
- **Protected routes**: Admin-only access with middleware verification

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

## Architecture Highlights

### Unified Server Architecture
```
Single HTTP Server (Port 3001)
├── REST API (Express routes)
│   ├── /api/auth/* - Authentication
│   ├── /api/rooms/* - Room CRUD
│   ├── /api/admin/* - Admin operations
│   └── /api/rooms/:id/playback/* - Playback data
└── WebSocket Server (Hocuspocus at /ws)
    ├── Document sync
    ├── Awareness protocol
    └── Update capture
```

### Database Schema
```
User
├── id, username, email?, password, color, role
├── isDeleted (soft delete)
└── Relations: ownedRooms, rooms (participants)

Room
├── id, name, language, documentId
├── scheduledTime?, duration?
├── isEnded, endedAt, isDeleted
└── Relations: owner, participants

DocumentUpdate (playback data)
├── id, documentId, update (Bytes)
├── timestamp, userId
└── Index: (documentId, timestamp)

Document (Y.js persistence)
├── id, name (documentId), data (Bytes)
└── Stores compiled Y.Doc state
```

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
- Read Hocuspocus documentation and examples
- Created comprehensive notes in `notes/` directory

### 2. Core Implementation
- Set up project structure (frontend + server folders)
- Implemented authentication and room management
- Integrated CodeMirror with Yjs
- Established WebSocket connection via Hocuspocus

### 3. Feature Additions
- Admin role and dashboard
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

### 1. CodeMirror + Yjs Integration
```typescript
// Create Y.js provider
const provider = new HocuspocusProvider({
  url: wsUrl,
  name: documentId,
  token: authToken,
})

// Bind to CodeMirror
const ytext = ydoc.getText('codemirror')
const state = EditorState.create({
  extensions: [
    basicSetup,
    languageExt,
    yCollab(ytext, provider.awareness)
  ]
})
```

### 2. Theme-Safe Editor Updates
```typescript
// Create once
useEffect(() => {
  const view = new EditorView({ state, parent: container })
  viewRef.current = view
  return () => view.destroy()
}, [provider, room, ytext])  // NO theme dependency

// Reconfigure on theme change
useEffect(() => {
  viewRef.current?.dispatch({
    effects: StateEffect.reconfigure.of([...extensions])
  })
}, [theme])  // Only theme
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

const content = ytext.toString()
```

## Challenges and Solutions

### Challenge 1: Concurrent Update Conflicts
**Problem**: Multiple users typing simultaneously could lose updates
**Solution**: Atomic database inserts (one row per update) instead of array append operations

### Challenge 2: Editor Disappearing on Theme Change
**Problem**: Editor destroyed and recreated on theme toggle
**Solution**: Separate editor creation from theme updates using StateEffect.reconfigure

### Challenge 3: Follow Mode Cursor Position
**Problem**: Y.js uses relative positions, not absolute numbers
**Solution**: YSyncConfig utility to convert Y.js positions to CodeMirror positions

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

## Best Practices Applied

### Security
- JWT-based authentication with secure secret
- Password hashing with bcrypt (10 rounds)
- Admin middleware for protected routes
- CORS configuration for multiple origins
- Soft deletes for data retention

### Performance
- Client-side playback reconstruction
- Gzip compression for data transfer
- Database indexes on critical fields
- Connection pooling via Prisma
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

### Development
```bash
# Terminal 1: Start PostgreSQL
docker-compose up postgres

# Terminal 2: Start server
cd server
bun install
bunx prisma migrate dev
bun src/index.ts

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
   - CodeMirror + Yjs integration
   - Hocuspocus WebSocket server
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
2. **React + CodeMirror**: Careful lifecycle management prevents memory leaks
3. **WebSocket + HTTP**: Single-server architecture simplifies deployment
4. **Theme Switching**: Use reconfigure instead of recreation for complex components
5. **Database Design**: Event sourcing patterns work well for collaborative systems
6. **Compression**: Always consider data transfer size for real-time applications
7. **Desktop Packaging**: Tauri provides excellent DX for turning React apps into native desktop apps
8. **Environment Detection**: Runtime feature flags enable seamless web/desktop code sharing
9. **HashRouter**: Required for desktop apps; navigate(-1) provides smart back navigation
10. **i18n**: Comprehensive translation coverage from the start prevents technical debt

## Credits

Built with assistance from AI (Cline/Claude), leveraging:
- [Yjs](https://docs.yjs.dev/) - CRDT framework
- [CodeMirror](https://codemirror.net/) - Code editor
- [Hocuspocus](https://tiptap.dev/hocuspocus) - WebSocket provider
- [Prisma](https://www.prisma.io/) - Database ORM
- [Bun](https://bun.sh/) - JavaScript runtime

## License

[Specify your license here]

## Contributing

[Specify contribution guidelines if needed]

---

**Last Updated**: November 2, 2025
**Version**: 1.2.0 (Desktop App Release)
**Status**: Production Ready (Web + Desktop)
