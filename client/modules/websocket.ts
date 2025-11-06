import type { Point, StrokeOp } from './canvas';

export type PresenceUser = { id: string; name?: string; color: string };

export type NetworkClient = {
  userId(): string;
  newOpId(): string;
  sendStrokeStart(op: StrokeOp): void;
  sendStrokeUpdate(id: string, points: Point[]): void;
  sendStrokeEnd(id: string): void;
  sendShapeAdd(op: any): void;
  sendUndo(): void;
  sendRedo(): void;
  sendClear(): void;
  sendCursor(p: { x: number; y: number }): void;
  sendDebugRenderOrder(enabled: boolean): void;
  onInitialState(cb: (ops: StrokeOp[]) => void): void;
  onStrokeAppended(cb: (op: StrokeOp) => void): void;
  onStrokePatched(cb: (payload: { id: string; points: Point[] }) => void): void;
  onWholeStateReplaced(cb: (ops: StrokeOp[]) => void): void;
  onCursor(cb: (u: { id: string; x: number; y: number; color: string }) => void): void;
  onDebugRenderOrder(cb: (enabled: boolean) => void): void;
  onShapeAppended(cb: (op: any) => void): void;
  tickFps(): void;
};

export function createSocketClient(serverUrl: string, room: string, hooks: {
  onPresence(users: PresenceUser[]): void;
  onLatency(ms: number): void;
  onFps(fps: number): void;
}): NetworkClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  // Allow default transports (polling + websockets) for better cross-origin reliability
  const socket: any = (window as any).io(serverUrl, { path: '/socket.io' });
  const myId = crypto.randomUUID();
  let myColor = randomColorFromId(myId);
  let fpsSamples = 0; let fpsLast = performance.now(); let fps = 0;

  let hasJoined = false;
  function joinRoom() {
    if (socket.connected && !hasJoined) {
      console.log('[socket] emitting join', { room, userId: myId, color: myColor });
      socket.emit('join', { room, userId: myId, color: myColor });
      hasJoined = true;
    }
  }

  // Join on initial connect and on any reconnects
  socket.on('connect', () => {
    console.log('[socket] connected', { id: socket.id, url: serverUrl });
    hasJoined = false; // Reset on reconnect
    // Use setTimeout to ensure socket is fully ready
    setTimeout(() => {
      joinRoom();
    }, 100);
    hooks.onLatency(0); // Reset latency on reconnect
  });

  socket.on('disconnect', () => {
    console.warn('[socket] disconnected');
    hasJoined = false; // Reset on disconnect
    hooks.onLatency(-1); // Indicate disconnected
  });

  socket.on('connect_error', (err: Error) => {
    console.error('[socket] connect_error', err);
    hasJoined = false;
  });

  // Join immediately if already connected
  if (socket.connected) {
    setTimeout(() => {
      joinRoom();
    }, 100);
  } else {
    socket.once('connect', () => {
      setTimeout(() => {
        joinRoom();
      }, 100);
    });
  }

  socket.on('presence', (users: PresenceUser[]) => {
    console.log('[socket] presence', users?.length);
    hooks.onPresence(users);
  });

  // Latency Ping
  setInterval(() => {
    const start = performance.now();
    socket.timeout(5000).emit('ping:latency', (err: unknown) => {
      const ms = performance.now() - start;
      hooks.onLatency(ms);
    });
  }, 2000);

  function userId() { return myId; }
  function newOpId() { return `${myId}-${crypto.randomUUID()}`; }

  function sendStrokeStart(op: StrokeOp) { socket.emit('stroke:start', op); }
  function sendStrokeUpdate(id: string, points: Point[]) { socket.emit('stroke:update', { id, points }); }
  function sendStrokeEnd(id: string) { socket.emit('stroke:end', { id }); }
  function sendShapeAdd(op: any) { socket.emit('shape:add', op); }
  function sendUndo() { socket.emit('history:undo'); }
  function sendRedo() { socket.emit('history:redo'); }
  function sendClear() { socket.emit('history:clear'); }
  function sendCursor(p: { x: number; y: number }) { socket.emit('cursor', { x: p.x, y: p.y }); }
  function sendDebugRenderOrder(enabled: boolean) { socket.emit('debug:renderOrder', { enabled }); }

  function onInitialState(cb: (ops: StrokeOp[]) => void) { socket.on('state:init', cb); }
  function onStrokeAppended(cb: (op: StrokeOp) => void) { socket.on('stroke:append', cb); }
  function onStrokePatched(cb: (payload: { id: string; points: Point[] }) => void) { socket.on('stroke:patch', cb); }
  function onWholeStateReplaced(cb: (ops: StrokeOp[]) => void) { socket.on('state:replace', cb); }
  function onCursor(cb: (u: { id: string; x: number; y: number; color: string }) => void) { socket.on('cursor', cb); }
  function onDebugRenderOrder(cb: (enabled: boolean) => void) { socket.on('debug:renderOrder', ({ enabled }: { enabled: boolean }) => cb(enabled)); }
  function onShapeAppended(cb: (op: any) => void) { socket.on('shape:append', cb); }

  function tickFps() {
    fpsSamples++;
    const now = performance.now();
    if (now - fpsLast > 1000) {
      fps = fpsSamples * 1000 / (now - fpsLast);
      fpsSamples = 0; fpsLast = now;
      hooks.onFps(fps);
    }
  }

  return {
    userId, newOpId,
    sendStrokeStart, sendStrokeUpdate, sendStrokeEnd, sendShapeAdd, sendUndo, sendRedo, sendClear, sendCursor, sendDebugRenderOrder,
    onInitialState, onStrokeAppended, onStrokePatched, onWholeStateReplaced, onCursor, onDebugRenderOrder, onShapeAppended,
    tickFps,
  };
}

function randomColorFromId(id: string) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 85% 45%)`;
}


