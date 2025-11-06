# Architecture

## Data Flow Diagram

1. Pointer events on client generate stroke operations:
   - `stroke:start` (append op)
   - `stroke:update` (stream points ~60Hz)
   - `stroke:end` (informational)
2. Client sends events via Socket.io to the room.
3. Server appends/patches operations in room state and broadcasts to all clients in the room.
4. Clients apply incremental updates; after global operations (undo/redo/clear), the server broadcasts a full state replacement to guarantee convergence.

```
[Pointer] → [Canvas Controller] → socket.emit ──► [Server Room State]
                                   ▲                         │
                                   │        io.to(room).emit ▼
                              [Peers Apply Incremental Updates] → [Offscreen Redraw] → [Blit to Screen]
```

## WebSocket Protocol

- join: { room, userId, color }
- presence -> [{ id, color }]
- ping:latency (ack)
- stroke:start -> StrokeOp
- stroke:update -> { id, points }
- stroke:end -> { id }
- cursor -> { x, y }
- state:init -> StrokeOp[] (on join)
- stroke:append -> StrokeOp (to peers)
- stroke:patch -> { id, points } (to peers)
- state:replace -> StrokeOp[] (after undo/redo/clear)
- debug:renderOrder -> { enabled } (room-wide debug overlay toggle)

`StrokeOp`:
```
{
  id: string,
  userId: string,
  type: 'stroke',
  mode: 'draw' | 'erase',
  color: string,
  width: number,
  points: { x:number, y:number, t:number }[],
  timestamp?: number,           // Client timestamp for conflict resolution
  serverTimestamp?: number,     // Server timestamp for conflict resolution
  isDeleted?: boolean
}
```

## Undo/Redo Strategy (Global)

- Server maintains a linear log of operations with tombstoning (`isDeleted`).
- Undo marks the last non-deleted op as deleted and pushes its id to a redo stack.
- Redo pops from the redo stack and re-activates the op.
- After undo/redo, server emits `state:replace` with the full operations array to ensure global convergence.
- This is simple and predictable, but does not support branching histories.

## Conflict Resolution

**Timestamp-Based Deterministic Ordering:**

When multiple users draw in overlapping areas simultaneously, conflicts are resolved using a deterministic timestamp-based ordering system:

1. **Client Timestamps**: Each stroke includes a client-side `timestamp` (milliseconds since epoch) when the stroke is initiated.

2. **Server Timestamps**: The server adds a `serverTimestamp` when it receives the stroke, providing a secondary ordering mechanism.

3. **Three-Tier Sorting**:
   - **Primary**: Client timestamp (earlier timestamp = drawn first)
   - **Secondary**: Server timestamp (if client timestamps are identical, earlier server receipt = drawn first)
   - **Tertiary**: User ID (lexicographic ordering for complete determinism when timestamps match)

4. **Consistent Rendering**: All clients sort strokes using the same algorithm before rendering, ensuring identical visual output across all users even when strokes arrive in different network orders.

5. **Eraser Behavior**: Eraser strokes use `destination-out` compositing, which applies to all underlying strokes regardless of order, ensuring consistent erasing behavior.

**Benefits:**
- Deterministic: Same strokes always render in the same order across all clients
- Fair: No user gets priority; ordering is based on timing
- Network-tolerant: Works correctly even with varying network latency
- Simple: No complex CRDT or operational transform needed

## Performance Decisions

- Points are streamed at ~60Hz to balance latency and bandwidth.
- Client renders to an offscreen canvas and blits to the visible canvas each frame.
- Redraw-once for full replacements to avoid repeated paints.
- Simple quadratic midpoint smoothing for strokes.
- Presence cursors rendered on a lightweight overlay each frame.
 - Render-order debug overlay drawn every frame to ensure visibility and consistency.

## Future Improvements

- Server state compaction: periodically flatten visible bitmap or segment strokes.
- Vector-level hit-testing for selective undo.
- CRDT/OT for more advanced collaborative semantics.
- Persistence (save/load), export to PNG.


