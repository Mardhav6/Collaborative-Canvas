# Architecture

This document describes the internal architecture of the Collaborative Canvas application, including data flow, WebSocket protocol, conflict resolution, and performance optimizations.

## Data Flow Diagram

### Drawing Event Flow

When a user draws on the canvas, the following flow occurs:

```
[User Pointer Event]
    ↓
[Canvas Controller]
    ↓ (captures coordinates in CSS pixel space)
[canvasPointFromEvent()]
    ↓ (creates Point: { x, y, t })
[Start/Move/End Stroke Handlers]
    ↓
[Network Client]
    ↓ (Socket.IO emit)
[Server Room State]
    ↓ (broadcasts to all clients in room)
[Peers Receive Event]
    ↓
[Apply Incremental Update]
    ↓
[Offscreen Canvas Redraw]
    ↓
[Blit to Main Canvas]
    ↓
[Visual Update on Screen]
```

### Detailed Flow Steps

1. **Pointer Event Capture**:
   - User moves mouse/finger on canvas
   - `canvasPointFromEvent()` calculates coordinates in CSS pixel space
   - Coordinates account for canvas bounding box and Device Pixel Ratio (DPR)

2. **Stroke Creation**:
   - `startStroke()`: Creates new `StrokeOp` with first point
   - `moveStroke()`: Appends points to active stroke (~60Hz streaming)
   - `endStroke()`: Commits stroke to local state and sends to server

3. **Network Transmission**:
   - Client sends `stroke:start` with initial stroke operation
   - Client sends `stroke:update` with new points as user draws
   - Client sends `stroke:end` when drawing completes

4. **Server Processing**:
   - Server receives stroke events and updates room state
   - Server adds `serverTimestamp` for conflict resolution
   - Server sorts operations by timestamp for deterministic ordering
   - Server broadcasts to all clients in the room (including sender)

5. **Client Synchronization**:
   - Clients receive `stroke:append` for new strokes
   - Clients receive `stroke:patch` for point updates
   - Clients receive `state:replace` for global operations (undo/redo/clear)

6. **Rendering**:
   - Strokes are rendered to offscreen canvas with DPR transform
   - Offscreen canvas is blitted to main canvas with identity transform
   - Active stroke is rendered on top for real-time feedback

### State Management Flow

```
[Local Stroke State]
    ↓ (optimistic update)
[Render Immediately]
    ↓ (send to server)
[Server State]
    ↓ (broadcast to peers)
[Peer State Update]
    ↓
[Reconcile with Local State]
    ↓ (protect locally committed strokes)
[Update Render]
```

## WebSocket Protocol

### Client → Server Messages

#### Connection & Presence

- **`join`**: Join a room
  ```typescript
  { room: string, userId: string, color: string }
  ```
  - Sent when client connects to join a specific room
  - Server responds with `state:init` and `presence`

#### Drawing Operations

- **`stroke:start`**: Start a new stroke
  ```typescript
  StrokeOp {
    id: string,
    userId: string,
    type: 'stroke',
    mode: 'draw' | 'erase',
    color: string,
    width: number,
    points: Point[],
    timestamp: number
  }
  ```
  - Sent when user starts drawing (pointer down)
  - Contains initial point and stroke metadata

- **`stroke:update`**: Update stroke with new points
  ```typescript
  { id: string, points: Point[] }
  ```
  - Sent during active drawing (~60Hz)
  - Contains accumulated points since last update

- **`stroke:end`**: End stroke drawing
  ```typescript
  { id: string }
  ```
  - Sent when user finishes drawing (pointer up)
  - Informational only; points already sent via updates

#### Shapes

- **`shape:add`**: Add a shape (rectangle, circle, text, image)
  ```typescript
  ShapeOp {
    id: string,
    userId: string,
    type: 'shape',
    shape: 'rect' | 'circle' | 'text' | 'image',
    // ... shape-specific properties
    timestamp: number
  }
  ```

#### Global Operations

- **`history:undo`**: Undo last operation
  - No parameters
  - Server marks last non-deleted operation as deleted

- **`history:redo`**: Redo last undone operation
  - No parameters
  - Server restores last deleted operation

- **`history:clear`**: Clear all operations
  - No parameters
  - Server clears all operations in room

#### Cursor & Debug

- **`cursor`**: Update cursor position
  ```typescript
  { x: number, y: number }
  ```
  - Sent periodically during mouse movement
  - Broadcast to all clients for presence indicators

- **`debug:renderOrder`**: Toggle render order debug overlay
  ```typescript
  { enabled: boolean }
  ```
  - Room-wide debug toggle
  - Broadcast to all clients in room

#### Latency

- **`ping:latency`**: Ping server for latency measurement
  - Uses Socket.IO acknowledgment for round-trip time
  - Sent every 2 seconds

### Server → Client Messages

#### Initial State

- **`state:init`**: Initial room state on join
  ```typescript
  StrokeOp[]
  ```
  - Sent immediately after `join` event
  - Contains all existing operations in room

- **`presence`**: List of users in room
  ```typescript
  Array<{ id: string, color: string }>
  ```
  - Sent after `join` and on user connect/disconnect
  - Updated in real-time as users join/leave

#### Stroke Updates

- **`stroke:append`**: New stroke added
  ```typescript
  StrokeOp
  ```
  - Broadcast to all clients when stroke starts
  - Includes server timestamp for conflict resolution

- **`stroke:patch`**: Stroke points updated
  ```typescript
  { id: string, points: Point[] }
  ```
  - Broadcast to all clients during active drawing
  - Contains latest accumulated points

#### State Replacement

- **`state:replace`**: Full state replacement
  ```typescript
  StrokeOp[]
  ```
  - Sent after global operations (undo/redo/clear)
  - Ensures all clients have identical state
  - Contains all operations in deterministic order

#### Shapes

- **`shape:append`**: New shape added
  ```typescript
  ShapeOp
  ```
  - Broadcast to all clients when shape is added

#### Cursor & Debug

- **`cursor`**: Cursor position update
  ```typescript
  { id: string, x: number, y: number, color: string }
  ```
  - Broadcast to all clients for presence indicators
  - Includes user ID and color for rendering

- **`debug:renderOrder`**: Debug overlay toggle
  ```typescript
  { enabled: boolean }
  ```
  - Broadcast to all clients in room
  - Synchronizes debug overlay state

### Message Flow Example

```
Client A: join { room: 'lobby', userId: 'user1', color: '#ff0000' }
Server:   state:init [all existing strokes]
Server:   presence [{ id: 'user1', color: '#ff0000' }]

Client A: stroke:start { id: 'stroke1', userId: 'user1', points: [...] }
Server:   stroke:append { id: 'stroke1', ... } → All clients

Client A: stroke:update { id: 'stroke1', points: [...] }
Server:   stroke:patch { id: 'stroke1', points: [...] } → All clients

Client A: stroke:end { id: 'stroke1' }
Server:   (no broadcast, points already sent)

Client B: history:undo
Server:   state:replace [all strokes with last one deleted] → All clients
```

## Undo/Redo Strategy

### Global Undo/Redo Implementation

The application implements a **global, linear undo/redo system** using tombstoning:

#### Server-Side State Management

```javascript
// Server maintains:
const ops = [];           // All operations (including deleted)
const redoStack = [];     // Stack of undone operation IDs
```

#### Undo Operation

1. **Find last non-deleted operation**:
   - Iterate through `ops` array in reverse order
   - Find first operation where `isDeleted === false`

2. **Mark as deleted**:
   - Set `isDeleted = true` on the operation
   - Push operation ID to `redoStack`

3. **Broadcast state replacement**:
   - Emit `state:replace` with full operations array
   - All clients receive updated state with deleted operation

#### Redo Operation

1. **Pop from redo stack**:
   - Pop operation ID from `redoStack`
   - If stack is empty, do nothing

2. **Restore operation**:
   - Find operation by ID in `ops` array
   - Set `isDeleted = false`

3. **Broadcast state replacement**:
   - Emit `state:replace` with full operations array
   - All clients receive updated state with restored operation

#### Clear Operation

1. **Clear all operations**:
   - Set `ops.length = 0`
   - Set `redoStack.length = 0`

2. **Broadcast state replacement**:
   - Emit `state:replace` with empty array
   - All clients receive empty state

### Key Design Decisions

1. **Tombstoning**: Operations are never deleted, only marked as `isDeleted`
   - Allows for redo functionality
   - Maintains operation history
   - Enables future features like selective undo

2. **State Replacement**: After undo/redo/clear, server sends full state
   - Ensures all clients have identical state
   - Guarantees convergence
   - Simpler than incremental updates for global operations

3. **Linear History**: Only supports linear undo/redo
   - No branching histories
   - No per-user undo
   - Simple and predictable behavior

4. **Redo Stack Invalidation**: New operations clear redo stack
   - Prevents inconsistent state
   - Standard undo/redo behavior
   - Clear user expectations

### Limitations

- **No per-user undo**: All users share the same undo/redo history
- **Linear only**: Cannot undo specific operations, only the most recent
- **Global operations**: Undo/redo affects all users simultaneously
- **No selective undo**: Cannot undo a specific user's strokes

### Future Improvements

- **Per-user undo**: Maintain separate undo stacks per user
- **Selective undo**: Allow undoing specific operations by ID
- **Branching history**: Support multiple undo/redo paths
- **Operation grouping**: Group related operations for atomic undo/redo

## Performance Decisions

### Rendering Pipeline

#### Offscreen Canvas Rendering

**Decision**: Render to offscreen canvas, then blit to main canvas

**Rationale**:
- **Separation of concerns**: Committed strokes rendered once to offscreen canvas
- **Performance**: Offscreen rendering doesn't trigger browser repaints
- **Efficiency**: Only blit when state changes, not on every frame
- **Smoother animation**: Active stroke rendered on top without redrawing all strokes

**Implementation**:
```typescript
// Offscreen canvas matches main canvas size
offscreen.width = canvas.width;   // Device pixels (CSS * DPR)
offscreen.height = canvas.height;

// Render all committed strokes to offscreen
// Blit offscreen to main canvas
ctx.drawImage(offscreen, 0, 0);
```

#### Device Pixel Ratio (DPR) Handling

**Decision**: Use CSS pixel coordinates with DPR transform

**Rationale**:
- **High-DPI support**: Crisp rendering on retina displays
- **Coordinate consistency**: Coordinates in CSS pixel space, transform handles scaling
- **Simplicity**: No need to convert between coordinate systems
- **Accuracy**: Precise coordinate calculation with 4 decimal precision

**Implementation**:
```typescript
// Canvas buffer: device pixels (CSS * DPR)
canvas.width = rect.width * dpr;
canvas.height = rect.height * dpr;

// Transform: scale CSS pixels to device pixels
ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

// Coordinates: CSS pixel space
const x = e.clientX - rect.left;  // CSS pixels
const y = e.clientY - rect.top;   // CSS pixels
```

#### Render Loop Optimization

**Decision**: 60fps render loop with conditional redraws

**Rationale**:
- **Smooth drawing**: 60fps ensures responsive user experience
- **Efficiency**: Only redraw when necessary (active drawing or state changes)
- **Performance**: Avoid unnecessary renders when idle
- **Battery friendly**: Reduced CPU usage when not drawing

**Implementation**:
```typescript
// Render loop: ~60fps
requestAnimationFrame(render);

// Conditional redraws:
// - Always render active stroke (real-time feedback)
// - Redraw offscreen only when state changes
// - Throttle full redraws to avoid flicker
```

### Point Streaming

#### Throttled Updates

**Decision**: Stream points at ~60Hz (every ~16ms)

**Rationale**:
- **Smooth drawing**: High enough frequency for smooth strokes
- **Network efficiency**: Balance between latency and bandwidth
- **Server load**: Reduce server processing overhead
- **Client performance**: Avoid overwhelming clients with updates

**Implementation**:
```typescript
const THROTTLE_MS = 8;  // ~120Hz internal, ~60Hz network

// Throttle network updates
if (now - lastSentAt > THROTTLE_MS) {
  network.sendStrokeUpdate(id, points);
  lastSentAt = now;
}
```

#### Point Accumulation

**Decision**: Accumulate points between network updates

**Rationale**:
- **Efficiency**: Send multiple points per update
- **Smoothness**: Maintain smooth rendering between updates
- **Bandwidth**: Reduce number of network messages
- **Latency**: Balance between update frequency and message size

### Curve Smoothing

#### Quadratic Curve Interpolation

**Decision**: Use quadratic curves for smooth stroke rendering

**Rationale**:
- **Smooth appearance**: Curves look more natural than straight lines
- **Performance**: Quadratic curves are faster than cubic curves
- **Simplicity**: Easier to implement and debug
- **Quality**: Good balance between smoothness and performance

**Implementation**:
```typescript
// Smooth curves through points
for (let i = 1; i < points.length; i++) {
  const prev = points[i - 1];
  const curr = points[i];
  const next = points[i + 1];
  
  // Control point for smooth curve
  const cpX = (prev.x + curr.x) / 2;
  const cpY = (prev.y + curr.y) / 2;
  
  target.quadraticCurveTo(cpX, cpY, curr.x, curr.y);
}
```

#### Point Smoothing Algorithm

**Decision**: Apply weighted average smoothing to committed strokes

**Rationale**:
- **Noise reduction**: Smooth out jittery input
- **Quality**: Improve stroke appearance
- **Performance**: Lightweight algorithm
- **Consistency**: Same smoothing for all strokes

### State Synchronization

#### Optimistic Updates

**Decision**: Render locally immediately, then sync with server

**Rationale**:
- **Responsiveness**: Immediate visual feedback
- **User experience**: No perceived latency
- **Network tolerance**: Works well with network delays
- **Conflict handling**: Server reconciliation handles conflicts

**Implementation**:
```typescript
// Local commit: render immediately
locallyCommittedStrokes.add(stroke.id);
committedStrokeCoordinates.set(stroke.id, points);
strokes.push(stroke);
redrawAll();

// Server sync: send to server
network.sendStrokeStart(stroke);
```

#### Local Stroke Protection

**Decision**: Protect locally committed strokes from server overwrites

**Rationale**:
- **Coordinate accuracy**: Prevent server from modifying local coordinates
- **Smooth drawing**: Avoid flickering during active drawing
- **User experience**: Maintain local state until drawing completes
- **Conflict resolution**: Server state used for peer strokes only

**Implementation**:
```typescript
// Block server updates for local strokes
if (locallyCommittedStrokes.has(stroke.id)) {
  return; // Ignore server update
}

// Use local coordinates as source of truth
const stored = committedStrokeCoordinates.get(stroke.id);
if (stored) {
  stroke.points = stored; // Restore local coordinates
}
```

## Conflict Resolution

### Timestamp-Based Deterministic Ordering

The application uses a **three-tier sorting system** to resolve conflicts when multiple users draw simultaneously:

#### Sorting Algorithm

```javascript
ops.sort((a, b) => {
  // Primary: Client timestamp (earlier = drawn first)
  if (a.timestamp !== b.timestamp) {
    return a.timestamp - b.timestamp;
  }
  
  // Secondary: Server timestamp (earlier server receipt = drawn first)
  if (a.serverTimestamp !== b.serverTimestamp) {
    return a.serverTimestamp - b.serverTimestamp;
  }
  
  // Tertiary: User ID (lexicographic ordering for determinism)
  return a.userId.localeCompare(b.userId);
});
```

#### Three-Tier Sorting

1. **Primary: Client Timestamp**
   - Each stroke includes `timestamp` when stroke is initiated
   - Earlier timestamp = drawn first (rendered below)
   - Handles most conflicts when strokes are drawn at different times

2. **Secondary: Server Timestamp**
   - Server adds `serverTimestamp` when stroke is received
   - Used when client timestamps are identical (rare but possible)
   - Earlier server receipt = drawn first
   - Handles network latency variations

3. **Tertiary: User ID**
   - Lexicographic string comparison of user IDs
   - Provides complete determinism when timestamps match exactly
   - Ensures consistent ordering across all clients
   - Handles edge cases (identical timestamps, clock skew)

#### Deterministic Rendering

**Key Principle**: All clients sort strokes using the same algorithm before rendering

**Benefits**:
- **Consistency**: Same strokes always render in the same order
- **Fairness**: No user gets priority; ordering based on timing
- **Network Tolerance**: Works correctly with varying network latency
- **Simplicity**: No complex CRDT or operational transform needed

#### Eraser Behavior

**Decision**: Eraser uses `destination-out` compositing mode

**Rationale**:
- **Consistent erasing**: Eraser affects all underlying strokes
- **Predictable behavior**: Users expect eraser to work regardless of stroke order
- **Simplicity**: No need to track which strokes are erased
- **Performance**: GPU-accelerated compositing

**Implementation**:
```typescript
if (s.mode === 'erase') {
  target.globalCompositeOperation = 'destination-out';
  target.strokeStyle = 'rgba(0,0,0,1)';
} else {
  target.globalCompositeOperation = 'source-over';
  target.strokeStyle = s.color;
}
```

### Conflict Resolution Examples

#### Example 1: Simultaneous Drawing

```
User A draws stroke at 10:00:00.100
User B draws stroke at 10:00:00.150

Result: User A's stroke rendered below User B's stroke
Reason: User A's timestamp (100) < User B's timestamp (150)
```

#### Example 2: Identical Timestamps

```
User A draws stroke at 10:00:00.100 (server receives at 10:00:00.105)
User B draws stroke at 10:00:00.100 (server receives at 10:00:00.110)

Result: User A's stroke rendered below User B's stroke
Reason: 
  - Primary: Timestamps equal (100 === 100)
  - Secondary: User A's serverTimestamp (105) < User B's serverTimestamp (110)
```

#### Example 3: Complete Tie

```
User A (userId: "user-a") draws at 10:00:00.100 (server: 10:00:00.105)
User B (userId: "user-b") draws at 10:00:00.100 (server: 10:00:00.105)

Result: User A's stroke rendered below User B's stroke
Reason:
  - Primary: Timestamps equal
  - Secondary: Server timestamps equal
  - Tertiary: "user-a" < "user-b" (lexicographic)
```

### Network Latency Handling

#### Optimistic Rendering

- **Local strokes**: Rendered immediately with local timestamp
- **Peer strokes**: Rendered when received from server
- **Conflict resolution**: Server timestamps ensure consistent ordering
- **State reconciliation**: Local strokes protected from server overwrites

#### Server Reconciliation

- **Server timestamps**: Added when stroke is received
- **Broadcast to all**: Including original sender for consistency
- **Deterministic sorting**: All clients sort using same algorithm
- **State convergence**: All clients eventually have identical state

### Limitations

1. **Clock Skew**: Assumes client clocks are reasonably synchronized
   - Server timestamps provide fallback
   - User ID provides final tiebreaker

2. **Network Delays**: Strokes may arrive in different order
   - Server timestamps account for network delays
   - Sorting ensures consistent final order

3. **Simultaneous Drawing**: Strokes drawn at exact same time may have arbitrary order
   - User ID provides deterministic tiebreaker
   - Rare in practice due to millisecond precision

### Future Improvements

- **Vector Clocks**: More sophisticated conflict resolution
- **CRDTs**: Conflict-free replicated data types
- **Operational Transform**: Transform operations for better conflict handling
- **Selective Conflict Resolution**: User-defined conflict resolution rules

---

## Summary

The Collaborative Canvas architecture prioritizes:
- **Simplicity**: Straightforward data flow and state management
- **Performance**: Optimized rendering and network communication
- **Consistency**: Deterministic conflict resolution
- **User Experience**: Smooth, responsive drawing with real-time sync

The system handles real-time collaboration through:
- WebSocket-based bidirectional communication
- Timestamp-based conflict resolution
- Optimistic local updates with server reconciliation
- Efficient rendering pipeline with offscreen canvas
- Global undo/redo with state replacement

Future improvements could include:
- More sophisticated conflict resolution (CRDTs, OT)
- Per-user undo/redo
- Selective undo/redo
- Database persistence
- Offline support with local caching
