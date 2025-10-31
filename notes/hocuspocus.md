# Hocuspocus - WebSocket Backend for Yjs

## Overview

Hocuspocus is a WebSocket server for Yjs that provides real-time collaboration infrastructure with built-in authentication, persistence, and scaling capabilities.

## Core Concepts

### 1. Provider (Client-Side)

`HocuspocusProvider` connects the client to the WebSocket server:

```javascript
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'

const ydoc = new Y.Doc()

const provider = new HocuspocusProvider({
  url: 'ws://127.0.0.1:1234',
  name: 'my-document-name',
  document: ydoc,
  token: 'user-auth-token', // Optional JWT or auth token
  onAuthenticate: (data) => {
    // Called when authentication is needed
  },
  onAuthenticationFailed: (data) => {
    // Called when authentication fails
  },
  onSynced: ({ state }) => {
    // Called when initial sync is complete
  },
  onStatus: ({ status }) => {
    // 'connecting' | 'connected' | 'disconnected'
  }
})
```

### 2. Server Setup

```javascript
import { Server } from '@hocuspocus/server'

const server = new Server({
  port: 1234,
  
  async onAuthenticate(data) {
    // Verify user token
    const { token } = data
    
    if (!isValidToken(token)) {
      throw new Error('Not authorized!')
    }
    
    // Return context data for other hooks
    return {
      user: {
        id: 1234,
        name: 'John Doe',
        color: '#30bced'
      }
    }
  },
  
  async onLoadDocument(data) {
    // Load document from database
    const doc = await loadFromDatabase(data.documentName)
    return doc // Return Uint8Array or null
  },
  
  async onStoreDocument(data) {
    // Save document to database (debounced)
    await saveToDatabase(data.documentName, data.document)
  }
})

server.listen()
```

## Key Features

### 1. Authentication & Authorization

**Purpose:** Verify users and control document access

**onAuthenticate Hook:**
```javascript
async onAuthenticate(data) {
  const { token, documentName, requestParameters, connection } = data
  
  // Verify JWT token
  const user = await verifyJWT(token)
  
  if (!user) {
    throw new Error('Invalid token')
  }
  
  // Check if user has access to this document
  const hasAccess = await checkDocumentAccess(user.id, documentName)
  
  if (!hasAccess) {
    throw new Error('No access to this document')
  }
  
  // Return user context (available in all other hooks)
  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      color: user.color
    }
  }
}
```

**Read-Only Mode:**
```javascript
async onAuthenticate(data) {
  const user = await getUser(data.token)
  
  // Set connection to read-only if user doesn't have write access
  if (!user.canEdit) {
    data.connection.readOnly = true
  }
  
  return { user }
}
```

### 2. Document Persistence

**Two Approaches:**

#### A. Using Hooks (Manual)

```javascript
import { Server } from '@hocuspocus/server'
import { Database } from './database'

const db = new Database()

const server = new Server({
  async onLoadDocument(data) {
    const { documentName } = data
    
    // Load Y.Doc binary from database
    const doc = await db.getDocument(documentName)
    
    // Return Uint8Array or null for new document
    return doc?.data || null
  },
  
  async onStoreDocument(data) {
    const { documentName, document } = data
    
    // document is a Uint8Array (Y.Doc encoded)
    await db.saveDocument(documentName, document)
  }
})
```

#### B. Using Database Extension (Recommended)

```javascript
import { Server } from '@hocuspocus/server'
import { Database } from '@hocuspocus/extension-database'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const server = new Server({
  extensions: [
    new Database({
      // Fetch document from database
      fetch: async ({ documentName }) => {
        const doc = await prisma.document.findUnique({
          where: { name: documentName }
        })
        
        // Return Uint8Array or null
        return doc?.data || null
      },
      
      // Store document to database
      store: async ({ documentName, state }) => {
        await prisma.document.upsert({
          where: { name: documentName },
          update: { data: state },
          create: { name: documentName, data: state }
        })
      }
    })
  ]
})
```

**Important Notes:**
- Store documents as **Uint8Array (binary)**, not JSON
- Do NOT recreate Y.Doc from JSON - this causes duplication issues
- The binary format preserves the CRDT structure correctly

### 3. Awareness Protocol

**What is Awareness?**
- Separate CRDT for ephemeral user presence data
- No history, auto-cleans when users disconnect
- Perfect for cursors, selections, user info

**Client-Side Usage:**

```javascript
// Set local awareness state
provider.awareness.setLocalStateField('user', {
  name: 'John Doe',
  color: '#30bced',
  colorLight: '#30bced33'
})

// Listen for awareness changes
provider.on('awarenessUpdate', ({ states }) => {
  states.forEach((state, clientId) => {
    console.log(`User ${clientId}:`, state.user)
  })
})

provider.on('awarenessChange', ({ added, updated, removed }) => {
  console.log('Added:', added)
  console.log('Updated:', updated)
  console.log('Removed:', removed)
})

// Get all awareness states
const allStates = provider.awareness.getStates()
```

**Server-Side Access:**

```javascript
async onConnect(data) {
  const { documentName, awareness } = data
  
  // Get all connected users
  const users = []
  awareness.getStates().forEach((state, clientId) => {
    if (state.user) {
      users.push({ clientId, ...state.user })
    }
  })
  
  console.log(`Connected users to ${documentName}:`, users)
}
```

### 4. Multiplexing

**Multiple documents over single WebSocket connection:**

```javascript
import { 
  HocuspocusProvider, 
  HocuspocusProviderWebsocket 
} from '@hocuspocus/provider'

// Create shared WebSocket
const websocket = new HocuspocusProviderWebsocket({
  url: 'ws://localhost:1234'
})

// Create multiple providers using same socket
const provider1 = new HocuspocusProvider({
  websocketProvider: websocket,
  name: 'document-1',
  document: ydoc1,
  token: 'user-token'
})

const provider2 = new HocuspocusProvider({
  websocketProvider: websocket,
  name: 'document-2',
  document: ydoc2,
  token: 'user-token'
})

// Must explicitly attach when using manual socket
provider1.attach()
provider2.attach()
```

**Benefits:**
- Single WebSocket connection for all documents
- Reduced connection overhead
- Better performance with many documents

## Server Hooks Lifecycle

### Connection Hooks

```javascript
const server = new Server({
  // 1. First: Authenticate user
  async onAuthenticate(data) {
    const { token, documentName, requestParameters, connection } = data
    // Return context or throw error
    return { user: { id: 1, name: 'John' } }
  },
  
  // 2. Load document from storage
  async onLoadDocument(data) {
    const { documentName, context } = data
    // context contains data returned from onAuthenticate
    return documentBinary // Uint8Array or null
  },
  
  // 3. User connected successfully
  async onConnect(data) {
    const { documentName, context, connection } = data
    console.log(`${context.user.name} connected to ${documentName}`)
  },
  
  // 4. Document changed (debounced)
  async onStoreDocument(data) {
    const { documentName, document, context } = data
    await saveToDatabase(documentName, document)
  },
  
  // 5. User disconnected
  async onDisconnect(data) {
    const { documentName, context } = data
    console.log(`${context.user.name} disconnected`)
  },
  
  // 6. Document destroyed (all users disconnected)
  async onDestroy(data) {
    const { documentName } = data
    console.log(`Document ${documentName} destroyed`)
  }
})
```

### Change Hooks

```javascript
const server = new Server({
  // Called on every update (not debounced)
  async onChange(data) {
    const { documentName, document, context } = data
    // Good for: Real-time logging, webhooks
  },
  
  // Called on document store (debounced)
  async onStoreDocument(data) {
    const { documentName, document, context } = data
    // Good for: Database saves
  }
})
```

## Extensions

### Database Extension

```javascript
import { Database } from '@hocuspocus/extension-database'

new Database({
  fetch: async ({ documentName }) => {
    // Return Uint8Array or null
    return await loadFromDB(documentName)
  },
  
  store: async ({ documentName, state }) => {
    // state is Uint8Array
    await saveToDB(documentName, state)
  }
})
```

### SQLite Extension

```javascript
import { SQLite } from '@hocuspocus/extension-sqlite'

new SQLite({
  database: 'database.sqlite'
})
```

### Redis Extension

```javascript
import { Redis } from '@hocuspocus/extension-redis'

new Redis({
  host: 'localhost',
  port: 6379
})
```

### Throttle Extension

```javascript
import { Throttle } from '@hocuspocus/extension-throttle'

new Throttle({
  throttle: 100, // ms between updates
  banTime: 60000 // ban time for rate limit violations
})
```

### Webhook Extension

```javascript
import { Webhook } from '@hocuspocus/extension-webhook'

new Webhook({
  url: 'https://api.example.com/webhook',
  events: ['onChange', 'onConnect', 'onDisconnect']
})
```

## Complete Server Example with Prisma

```javascript
import { Server } from '@hocuspocus/server'
import { Database } from '@hocuspocus/extension-database'
import { PrismaClient } from '@prisma/client'
import jwt from 'jsonwebtoken'

const prisma = new PrismaClient()
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key'

const server = new Server({
  port: 1234,
  
  extensions: [
    new Database({
      fetch: async ({ documentName }) => {
        const doc = await prisma.document.findUnique({
          where: { name: documentName },
          select: { data: true }
        })
        return doc?.data || null
      },
      
      store: async ({ documentName, state }) => {
        await prisma.document.upsert({
          where: { name: documentName },
          update: { 
            data: state,
            updatedAt: new Date()
          },
          create: { 
            name: documentName, 
            data: state 
          }
        })
      }
    })
  ],
  
  async onAuthenticate(data) {
    const { token, documentName } = data
    
    if (!token) {
      throw new Error('No token provided')
    }
    
    try {
      // Verify JWT token
      const decoded = jwt.verify(token, JWT_SECRET)
      
      // Get user from database
      const user = await prisma.user.findUnique({
        where: { id: decoded.userId }
      })
      
      if (!user) {
        throw new Error('User not found')
      }
      
      // Check document access
      const room = await prisma.room.findFirst({
        where: {
          documentId: documentName,
          OR: [
            { ownerId: user.id },
            { participants: { some: { id: user.id } } }
          ]
        }
      })
      
      if (!room) {
        throw new Error('No access to this document')
      }
      
      // Set read-only if user is not owner
      if (room.ownerId !== user.id && !room.allowEdit) {
        data.connection.readOnly = true
      }
      
      // Return context for other hooks
      return {
        user: {
          id: user.id,
          name: user.username,
          email: user.email,
          color: user.color
        },
        room: {
          id: room.id,
          name: room.name
        }
      }
      
    } catch (error) {
      throw new Error('Authentication failed: ' + error.message)
    }
  },
  
  async onConnect(data) {
    const { context, documentName } = data
    console.log(`${context.user.name} connected to ${documentName}`)
    
    // Update last seen
    await prisma.user.update({
      where: { id: context.user.id },
      data: { lastSeen: new Date() }
    })
  },
  
  async onDisconnect(data) {
    const { context, documentName } = data
    console.log(`${context.user.name} disconnected from ${documentName}`)
  },
  
  async onDestroy(data) {
    const { documentName } = data
    console.log(`Document ${documentName} destroyed (no active connections)`)
  }
})

server.listen()
console.log('Hocuspocus server running on port 1234')
```

## Client-Side Complete Example

```javascript
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'

class CollaborativeEditor {
  constructor(documentId, token) {
    this.ydoc = new Y.Doc()
    this.ytext = this.ydoc.getText('codemirror')
    
    this.provider = new HocuspocusProvider({
      url: 'ws://localhost:1234',
      name: documentId,
      document: this.ydoc,
      token: token,
      
      onStatus: ({ status }) => {
        console.log('Status:', status)
        this.updateConnectionIndicator(status)
      },
      
      onSynced: ({ state }) => {
        console.log('Synced:', state)
        if (state) {
          this.onInitialSync()
        }
      },
      
      onAuthenticationFailed: ({ reason }) => {
        console.error('Auth failed:', reason)
        this.showAuthError(reason)
      },
      
      onAwarenessUpdate: ({ states }) => {
        this.updateUserList(states)
      },
      
      onAwarenessChange: ({ added, updated, removed }) => {
        console.log('Awareness changed:', { added, updated, removed })
      }
    })
    
    this.setupAwareness()
  }
  
  setupAwareness() {
    // Set user info
    this.provider.awareness.setLocalStateField('user', {
      name: this.userName,
      color: this.userColor,
      colorLight: this.userColor + '33'
    })
    
    // Update cursor position
    this.editor.on('cursorActivity', () => {
      const cursor = this.editor.getCursor()
      this.provider.awareness.setLocalStateField('cursor', {
        line: cursor.line,
        ch: cursor.ch
      })
    })
  }
  
  updateUserList(states) {
    const users = []
    states.forEach((state, clientId) => {
      if (state.user && clientId !== this.provider.awareness.clientID) {
        users.push({
          id: clientId,
          ...state.user,
          cursor: state.cursor
        })
      }
    })
    this.renderUserList(users)
  }
  
  destroy() {
    this.provider.destroy()
  }
}
```

## Best Practices

### 1. Document Naming

Use unique, deterministic document names:
- Room-based: `room-${roomId}`
- User-based: `user-${userId}-notes`
- Hybrid: `room-${roomId}-doc-${docId}`

### 2. Authentication

```javascript
// Generate JWT token on login
const token = jwt.sign(
  { 
    userId: user.id,
    exp: Math.floor(Date.now() / 1000) + (60 * 60 * 24) // 24h
  },
  JWT_SECRET
)

// Pass to provider
const provider = new HocuspocusProvider({
  url: 'ws://localhost:1234',
  name: documentId,
  document: ydoc,
  token: token
})
```

### 3. Error Handling

```javascript
// Server
async onAuthenticate(data) {
  try {
    const user = await verifyUser(data.token)
    return { user }
  } catch (error) {
    console.error('Auth error:', error)
    throw new Error('Authentication failed')
  }
}

// Client
provider.on('status', ({ status }) => {
  if (status === 'disconnected') {
    showReconnectingMessage()
  } else if (status === 'connected') {
    hideReconnectingMessage()
  }
})

provider.on('authenticationFailed', ({ reason }) => {
  showError('Please log in again')
  redirectToLogin()
})
```

### 4. Graceful Shutdown

```javascript
// Server
process.on('SIGTERM', async () => {
  await server.destroy()
  await prisma.$disconnect()
  process.exit(0)
})

// Client (React)
useEffect(() => {
  return () => {
    provider.destroy()
  }
}, [])
```

### 5. Performance Optimization

```javascript
import { Throttle } from '@hocuspocus/extension-throttle'

const server = new Server({
  extensions: [
    // Limit update frequency
    new Throttle({
      throttle: 50 // ms
    }),
    
    // Database with connection pooling
    new Database({
      fetch: async ({ documentName }) => {
        // Use connection pooling
        return await prisma.document.findUnique(...)
      },
      store: async ({ documentName, state }) => {
        // Batch writes if possible
        await prisma.document.upsert(...)
      }
    })
  ],
  
  // Debounce document saves
  debounce: 2000, // Wait 2s after last change before saving
  maxDebounce: 10000 // Force save after 10s regardless
})
```

## Key Takeaways

1. **Authentication First:** Always verify users in `onAuthenticate` hook
2. **Binary Storage:** Store Y.Doc as Uint8Array (binary), never JSON
3. **Database Extension:** Use for simple persistence, hooks for complex logic
4. **Awareness for Presence:** Perfect for cursors, user lists, ephemeral data
5. **Multiplexing:** Share WebSocket for multiple documents
6. **Context Propagation:** Return data from `onAuthenticate` to use in other hooks
7. **Read-Only Mode:** Control write access per connection
8. **Graceful Shutdown:** Clean up resources properly
9. **Error Handling:** Handle auth failures, disconnections gracefully
10. **Performance:** Use throttling, debouncing, and connection pooling

## Common Patterns

### Multi-Room Support

```javascript
// Room-based document naming
const roomId = 'abc123'
const provider = new HocuspocusProvider({
  url: 'ws://localhost:1234',
  name: `room-${roomId}`,
  document: ydoc,
  token: userToken
})
```

### User Permissions

```javascript
async onAuthenticate(data) {
  const user = await getUser(data.token)
  const room = await getRoom(data.documentName)
  
  // Check permission
  const permission = await getUserRoomPermission(user.id, room.id)
  
  if (permission === 'none') {
    throw new Error('No access')
  }
  
  if (permission === 'read') {
    data.connection.readOnly = true
  }
  
  return { user, room, permission }
}
```

### Document Versioning

```javascript
async onStoreDocument(data) {
  const { documentName, document } = data
  
  // Save current version
  await prisma.document.update({
    where: { name: documentName },
    data: { data: document }
  })
  
  // Create version snapshot
  await prisma.documentVersion.create({
    data: {
      documentName,
      data: document,
      createdAt: new Date()
    }
  })
}
