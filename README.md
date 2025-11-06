# Collaborative Canvas

Vanilla JS/TS + HTML5 Canvas on the client, Node.js + Socket.io on the server. Multiple users draw together with real-time sync, presence cursors, and global undo/redo.

## Quick Start

Prereqs: Node 18+.

```bash
npm install
npm start
```

- Open `http://localhost:3001` in two or more browser windows (or use `?room=anyname` to split rooms).
- A prebuilt client bundle is included. For active development, see Dev Mode below.

For live dev with auto-reload:
```bash
npm run dev
```

## Features
- Brush and eraser, color and stroke width
- Real-time stroke streaming (60Hz) and live cursor indicators
- Global undo/redo (affects last active operation regardless of author)
- Room support via `?room=`
- Basic metrics: latency and FPS

## Known Limitations/Bugs
- Global undo/redo is linear and affects the most recent visible op (no per-user undo).
- Long sessions can accumulate many strokes; no persistence or compaction yet.
- Eraser uses `destination-out` blending; subtle differences may appear across browsers.
- No authentication; user identity is ephemeral per session.

## How to Test with Multiple Users
1. Start the server: `npm start`.
2. Open two browser windows to the same room, e.g. `http://localhost:3001/?room=test`.
3. Draw overlapping strokes with different colors.
4. To verify deterministic conflict resolution, enable the sidebar Debug option “Show render order” (numbers indicate render order; higher numbers are on top). The toggle syncs across the room.

## Scripts
- `npm start` serves the static client and Socket.io server (uses the prebuilt bundle).
- `npm run build` bundles the client via esbuild.
- `npm run dev` runs esbuild in watch mode and nodemon for the server.

## Time Spent
- Core scaffold (client/server/socket plumbing): ~3 hours
- Drawing pipeline, smoothing, eraser, cursors: ~3 hours
- Undo/redo, conflict resolution, debug overlay: ~2 hours
- Documentation and polish: ~1 hour

See ARCHITECTURE.md for detailed internals.


