# CodeMirror + Yjs Integration Guide

## Overview

The `y-codemirror.next` library provides seamless integration between CodeMirror 6 editor and Yjs CRDT for real-time collaborative editing.

## Core Concepts

### 1. Y.Text Binding

CodeMirror's document content is bound to a Yjs `Y.Text` type, which provides:
- Automatic synchronization of local edits to the Y.Doc
- Automatic application of remote changes to the editor
- Conflict-free merging using CRDT algorithms

```javascript
const ydoc = new Y.Doc()
const ytext = ydoc.getText('codemirror')
```

### 2. Main Plugin: yCollab

The `yCollab` function is the main entry point that combines all necessary plugins:

```javascript
import { yCollab } from 'y-codemirror.next'

const extensions = [
  basicSetup,
  javascript(),
  yCollab(ytext, provider.awareness, { undoManager })
]
```

**Parameters:**
- `ytext`: Y.Text instance bound to the document
- `awareness`: Awareness instance for sharing user presence
- `options.undoManager`: Optional Y.UndoManager (or false to disable)

## Architecture Components

### 1. ySync Plugin

**Purpose:** Synchronizes editor content with Y.Text bidirectionally

**How it works:**
- **Local → Remote:** Listens to CodeMirror transactions and converts them to Y.Text operations
- **Remote → Local:** Observes Y.Text changes and dispatches CodeMirror transactions

**Key Implementation Details:**

```javascript
// YSyncPluginValue observes ytext changes
this._observer = (event, tr) => {
  if (tr.origin !== this.conf) {
    const delta = event.delta
    const changes = []
    let pos = 0
    
    for (let i = 0; i < delta.length; i++) {
      const d = delta[i]
      if (d.insert != null) {
        changes.push({ from: pos, to: pos, insert: d.insert })
      } else if (d.delete != null) {
        changes.push({ from: pos, to: pos + d.delete, insert: '' })
        pos += d.delete
      } else {
        pos += d.retain
      }
    }
    
    view.dispatch({ changes, annotations: [ySyncAnnotation.of(this.conf)] })
  }
}
```

**Transaction Annotations:** Uses `ySyncAnnotation` to mark transactions originating from Y.Text changes, preventing infinite loops.

### 2. yRemoteSelections Plugin

**Purpose:** Renders remote user cursors and text selections

**Features:**
- Color-coded cursors for each user
- User name labels on hover
- Selection highlights
- Multi-line selection support

**Awareness Integration:**

```javascript
provider.awareness.setLocalStateField('user', {
  name: 'Anonymous ' + Math.floor(Math.random() * 100),
  color: userColor.color,
  colorLight: userColor.light
})
```

**Selection Updates:**
- Automatically tracks local cursor/selection changes
- Broadcasts via awareness when user has focus
- Clears cursor info when editor loses focus

**Remote Selection Rendering:**
```javascript
// Creates decorations for each remote user
const start = math.min(anchor.index, head.index)
const end = math.max(anchor.index, head.index)

decorations.push({
  from: start,
  to: end,
  value: Decoration.mark({
    attributes: { style: `background-color: ${colorLight}` },
    class: 'cm-ySelection'
  })
})

// Cursor widget with user info
decorations.push({
  from: head.index,
  to: head.index,
  value: Decoration.widget({
    widget: new YRemoteCaretWidget(color, name)
  })
})
```

### 3. yUndoManager Plugin

**Purpose:** Provides collaborative undo/redo functionality

**Key Features:**
- Each client has independent undo/redo history
- Only tracks local changes (not remote changes)
- Integrates with browser's native undo/redo

**Usage:**
```javascript
import { yUndoManagerKeymap } from 'y-codemirror.next'

keymap.of([...yUndoManagerKeymap])
```

**Default Keybindings:**
- Ctrl/Cmd+Z: Undo
- Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y: Redo

## Position Handling

### Relative Positions

**Why Relative Positions?**
Absolute index positions (e.g., character 42) become invalid when the document changes. Yjs provides relative positions that remain valid:

```javascript
// YSyncConfig methods
toYPos(pos, assoc = 0) {
  return Y.createRelativePositionFromTypeIndex(this.ytext, pos, assoc)
}

fromYPos(rpos) {
  const pos = Y.createAbsolutePositionFromRelativePosition(
    Y.createRelativePositionFromJSON(rpos), 
    this.ytext.doc
  )
  return { pos: pos.index, assoc: pos.assoc }
}
```

**Use Cases:**
- Storing cursor positions across document changes
- Implementing comment threads
- Bookmark functionality
- Any feature requiring persistent positions

### YRange

Wrapper for selection ranges using relative positions:

```javascript
toYRange(range) {
  const yanchor = this.toYPos(range.anchor, range.assoc)
  const yhead = this.toYPos(range.head, range.assoc)
  return new YRange(yanchor, yhead)
}

fromYRange(yrange) {
  const anchor = this.fromYPos(yrange.yanchor)
  const head = this.fromYPos(yrange.yhead)
  
  if (anchor.pos === head.pos) {
    return EditorSelection.cursor(head.pos, head.assoc)
  }
  return EditorSelection.range(anchor.pos, head.pos)
}
```

## Awareness Protocol

### What is Awareness?

Awareness is a separate CRDT (without history) for sharing ephemeral user presence data:
- User info (name, color, avatar)
- Cursor positions
- Selection ranges
- Custom data (scroll position, viewport, etc.)

### Setting Local State

```javascript
const awareness = provider.awareness

// Set user info
awareness.setLocalStateField('user', {
  name: 'John Doe',
  color: '#30bced',
  colorLight: '#30bced33'
})

// Set cursor position
awareness.setLocalStateField('cursor', {
  anchor: yAnchorPosition,
  head: yHeadPosition
})
```

### Listening to Awareness Changes

```javascript
awareness.on('change', ({ added, updated, removed }) => {
  // added: array of client IDs that joined
  // updated: array of client IDs with state changes
  // removed: array of client IDs that left
  
  awareness.getStates().forEach((state, clientId) => {
    console.log(`Client ${clientId}:`, state.user)
  })
})
```

## Complete Implementation Example

```javascript
import * as Y from 'yjs'
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import { WebrtcProvider } from 'y-webrtc'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { EditorView, basicSetup } from 'codemirror'
import { EditorState } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { javascript } from '@codemirror/lang-javascript'

// User color palette
const usercolors = [
  { color: '#30bced', light: '#30bced33' },
  { color: '#6eeb83', light: '#6eeb8333' },
  { color: '#ffbc42', light: '#ffbc4233' },
  { color: '#ecd444', light: '#ecd44433' },
  { color: '#ee6352', light: '#ee635233' },
]

const userColor = usercolors[Math.floor(Math.random() * usercolors.length)]

// Initialize Yjs document
const ydoc = new Y.Doc()
const ytext = ydoc.getText('codemirror')

// Connect to collaboration backend
const provider = new HocuspocusProvider({
  url: 'ws://localhost:1234',
  name: 'my-document',
  document: ydoc,
  token: 'user-auth-token'
})

// Set user awareness state
provider.awareness.setLocalStateField('user', {
  name: 'John Doe',
  color: userColor.color,
  colorLight: userColor.light
})

// Create CodeMirror editor
const state = EditorState.create({
  doc: ytext.toString(),
  extensions: [
    keymap.of([...yUndoManagerKeymap]),
    basicSetup,
    javascript(),
    EditorView.lineWrapping,
    yCollab(ytext, provider.awareness)
  ]
})

const view = new EditorView({
  state,
  parent: document.querySelector('#editor')
})
```

## Best Practices

### 1. Provider Selection

**For Production:**
- Use `HocuspocusProvider` (WebSocket-based)
- Provides authentication, persistence, and scalability
- Supports multiple documents over single connection (multiplexing)

**For Development/Testing:**
- Use `WebrtcProvider` for peer-to-peer without server
- Good for prototyping and local testing

### 2. Document Initialization

```javascript
// Initialize with existing content
const ytext = ydoc.getText('codemirror')
if (ytext.toString().length === 0) {
  ytext.insert(0, '// Start coding here\n')
}
```

### 3. Cleanup

```javascript
// Clean up when component unmounts
view.destroy()
provider.destroy()
```

### 4. Error Handling

```javascript
provider.on('status', ({ status }) => {
  console.log('Connection status:', status) // 'connecting' | 'connected' | 'disconnected'
})

provider.on('synced', ({ synced }) => {
  console.log('Initial sync complete:', synced)
})
```

## Language Support

CodeMirror 6 provides language support through extensions:

```javascript
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { rust } from '@codemirror/lang-rust'
import { cpp } from '@codemirror/lang-cpp'
import { java } from '@codemirror/lang-java'
import { php } from '@codemirror/lang-php'
import { go } from '@codemirror/lang-go'

// Dynamically switch language
const languageExtensions = {
  javascript: javascript(),
  python: python(),
  rust: rust(),
  cpp: cpp(),
  java: java(),
  php: php(),
  go: go()
}

function setLanguage(view, lang) {
  view.dispatch({
    effects: StateEffect.reconfigure.of([
      basicSetup,
      languageExtensions[lang],
      yCollab(ytext, provider.awareness)
    ])
  })
}
```

## Advanced Features

### Follow Mode Implementation

To implement "follow user" feature:

```javascript
// Track remote user's viewport
provider.awareness.setLocalStateField('viewport', {
  scrollTop: view.scrollDOM.scrollTop,
  scrollLeft: view.scrollDOM.scrollLeft
})

// Follow another user
function followUser(clientId) {
  const states = provider.awareness.getStates()
  const userState = states.get(clientId)
  
  if (userState && userState.viewport) {
    view.scrollDOM.scrollTop = userState.viewport.scrollTop
    view.scrollDOM.scrollLeft = userState.viewport.scrollLeft
  }
  
  // Continue following on cursor changes
  if (userState && userState.cursor) {
    const pos = ysyncConfig.fromYPos(userState.cursor.head)
    view.dispatch({
      selection: { anchor: pos.pos },
      scrollIntoView: true
    })
  }
}
```

## Key Takeaways

1. **Three Main Plugins:** ySync (content sync), yRemoteSelections (cursors), yUndoManager (undo/redo)
2. **Y.Text is Central:** All content changes go through Y.Text CRDT
3. **Awareness for Presence:** Use awareness for ephemeral data (cursors, user info)
4. **Relative Positions:** Always use relative positions for features requiring persistent positions
5. **Provider Flexibility:** Can use WebRTC, WebSocket, or custom providers
6. **Language Extensions:** CodeMirror 6 supports many programming languages out of the box
