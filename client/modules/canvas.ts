import { NetworkClient } from './websocket';

type Tool = 'brush' | 'eraser' | 'rect' | 'circle' | 'text' | 'image';

export type Point = { x: number; y: number; t: number };
export type StrokeOp = {
  id: string;
  userId: string;
  type: 'stroke';
  mode: 'draw' | 'erase';
  color: string;
  width: number;
  points: Point[];
  isDeleted?: boolean;
};

type ShapeRect = {
  id: string;
  userId: string;
  type: 'shape';
  shape: 'rect';
  color: string;
  width: number;
  x: number; y: number; w: number; h: number;
  fill?: boolean;
  timestamp?: number;
  serverTimestamp?: number;
  isDeleted?: boolean;
};

type ShapeCircle = {
  id: string;
  userId: string;
  type: 'shape';
  shape: 'circle';
  color: string;
  width: number;
  cx: number; cy: number; r: number;
  fill?: boolean;
  timestamp?: number;
  serverTimestamp?: number;
  isDeleted?: boolean;
};

type ShapeText = {
  id: string;
  userId: string;
  type: 'shape';
  shape: 'text';
  color: string;
  text: string;
  font: string;
  x: number; y: number;
  timestamp?: number;
  serverTimestamp?: number;
  isDeleted?: boolean;
};

type ShapeImage = {
  id: string;
  userId: string;
  type: 'shape';
  shape: 'image';
  url: string;
  x: number; y: number; w: number; h: number;
  timestamp?: number;
  serverTimestamp?: number;
  isDeleted?: boolean;
};

type AnyOp = StrokeOp | ShapeRect | ShapeCircle | ShapeText | ShapeImage;

export type CanvasController = {
  setTool(tool: Tool): void;
  redrawAll(): void;
  updateUserInfo(users: Array<{ id: string; color: string; name?: string }>): void;
  setDebugRenderOrder(enabled: boolean): void;
};

export function createCanvasController(params: {
  canvas: HTMLCanvasElement;
  getColor: () => string;
  getStrokeWidth: () => number;
  getTool: () => Tool;
  network: NetworkClient;
}): CanvasController {
  const { canvas, getColor, getStrokeWidth, getTool, network } = params;
  const ctx = canvas.getContext('2d')!;

  const offscreen = document.createElement('canvas');
  const octx = offscreen.getContext('2d')!;
  let isPointerDown = false;
  let activeStroke: StrokeOp | null = null;
  let strokes: StrokeOp[] = [];
  let shapes: Array<ShapeRect | ShapeCircle | ShapeText | ShapeImage> = [];
  let activeShape: (ShapeRect | ShapeCircle) | null = null;
  let needsRedraw = true;
  let debugRenderOrder = false;
  const imageCache = new Map<string, HTMLImageElement>();
  const imageLoading = new Set<string>();

  const dpr = Math.max(window.devicePixelRatio || 1, 1);

  function resizeOffscreen() {
    offscreen.width = canvas.width;
    offscreen.height = canvas.height;
    // match CSS pixel coordinates on offscreen too
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  resizeOffscreen();

  function clearCanvas(target: CanvasRenderingContext2D) {
    target.clearRect(0, 0, canvas.width, canvas.height);
  }

  // Simple but effective smoothing using running average
  function smoothPoints(points: Point[]): Point[] {
    if (points.length <= 2) return points;
    
    const smoothed: Point[] = [points[0]]; // Keep first point
    
    for (let i = 1; i < points.length - 1; i++) {
      const prev = points[i - 1];
      const curr = points[i];
      const next = points[i + 1];
      
      // Simple average for smoother curves
      const smoothedX = (prev.x + curr.x + next.x) / 3;
      const smoothedY = (prev.y + curr.y + next.y) / 3;
      
      smoothed.push({
        x: smoothedX,
        y: smoothedY,
        t: curr.t
      });
    }
    
    smoothed.push(points[points.length - 1]); // Keep last point
    return smoothed;
  }

  function drawStroke(target: CanvasRenderingContext2D, s: StrokeOp, applySmoothing = true) {
    if (!s || s.points.length < 1 || s.isDeleted) return;
    
    target.save();
    if (s.mode === 'erase') {
      target.globalCompositeOperation = 'destination-out';
      target.strokeStyle = 'rgba(0,0,0,1)';
    } else {
      target.globalCompositeOperation = 'source-over';
      target.strokeStyle = s.color;
    }
    target.lineWidth = s.width;
    target.lineJoin = 'round';
    target.lineCap = 'round';

    target.beginPath();
    let points = s.points;
    
    // Apply smoothing for better curve quality (but skip for active strokes during drawing)
    if (applySmoothing && points.length > 2) {
      points = smoothPoints(points);
    }
    
    if (points.length === 1) {
      // Single point - draw as filled circle
      target.arc(points[0].x, points[0].y, s.width / 2, 0, Math.PI * 2);
      target.fill();
    } else if (points.length === 2) {
      // Two points - simple line
      target.moveTo(points[0].x, points[0].y);
      target.lineTo(points[1].x, points[1].y);
      target.stroke();
    } else {
      // Multiple points - use simple smooth quadratic curves
      // This is a proven technique used in many drawing apps
      target.moveTo(points[0].x, points[0].y);
      
      for (let i = 1; i < points.length; i++) {
        const prev = points[i - 1];
        const curr = points[i];
        
        if (i === points.length - 1) {
          // Last point - draw directly to it
          target.lineTo(curr.x, curr.y);
        } else {
          // Middle points - use smooth quadratic curves
          const next = points[i + 1];
          // Control point is the current point
          // End point is midpoint between current and next for smooth transition
          const endX = (curr.x + next.x) / 2;
          const endY = (curr.y + next.y) / 2;
          target.quadraticCurveTo(curr.x, curr.y, endX, endY);
        }
      }
      
      target.stroke();
    }
    target.restore();
  }

  function drawShape(target: CanvasRenderingContext2D, s: ShapeRect | ShapeCircle | ShapeText | ShapeImage) {
    if (!s || (s as any).isDeleted) return;
    target.save();
    target.lineJoin = 'round';
    target.lineCap = 'round';
    if ((s as any).color) target.strokeStyle = (s as any).color;
    if ((s as any).width) target.lineWidth = (s as any).width;
    if (s.type === 'shape' && s.shape === 'rect') {
      const r = s as ShapeRect;
      if (r.fill) {
        target.fillStyle = r.color;
        target.fillRect(r.x, r.y, r.w, r.h);
      } else {
        target.strokeRect(r.x, r.y, r.w, r.h);
      }
    } else if (s.type === 'shape' && s.shape === 'circle') {
      const c = s as ShapeCircle;
      target.beginPath();
      target.arc(c.cx, c.cy, Math.max(0, c.r), 0, Math.PI * 2);
      if (c.fill) {
        target.fillStyle = c.color;
        target.fill();
      } else {
        target.stroke();
      }
    } else if (s.type === 'shape' && s.shape === 'text') {
      const t = s as ShapeText;
      target.font = t.font;
      target.fillStyle = t.color;
      target.textBaseline = 'top';
      target.fillText(t.text, t.x, t.y);
    } else if (s.type === 'shape' && s.shape === 'image') {
      const im = s as ShapeImage;
      const cached = imageCache.get(im.url);
      if (cached && cached.complete) {
        target.drawImage(cached, im.x, im.y, im.w, im.h);
      } else if (!imageLoading.has(im.url)) {
        imageLoading.add(im.url);
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          imageCache.set(im.url, img);
          imageLoading.delete(im.url);
          needsRedraw = true;
        };
        img.onerror = () => {
          imageLoading.delete(im.url);
        };
        img.src = im.url;
      }
    }
    target.restore();
  }

  function redrawAll() {
    resizeOffscreen();
    clearCanvas(octx);
    
    // Sort all ops by timestamp for consistent conflict resolution
    const sortedOps: AnyOp[] = [...strokes, ...shapes].sort((a: any, b: any) => {
      // Primary sort: timestamp (earlier = drawn first)
      const aTime = a.timestamp || 0;
      const bTime = b.timestamp || 0;
      if (aTime !== bTime) {
        return aTime - bTime;
      }
      // Secondary sort: server timestamp if available
      const aServerTime = (a as any).serverTimestamp || aTime;
      const bServerTime = (b as any).serverTimestamp || bTime;
      if (aServerTime !== bServerTime) {
        return aServerTime - bServerTime;
      }
      // Tertiary sort: user ID for complete determinism
      return a.userId.localeCompare(b.userId);
    });
    
    // Draw ops in sorted order
    for (const s of sortedOps) {
      if ((s as any).type === 'stroke') {
        if (!(s as any).isDeleted) drawStroke(octx, s as StrokeOp);
      } else {
        drawShape(octx, s as any);
      }
    }
    
    // blit
    clearCanvas(ctx);
    ctx.drawImage(offscreen, 0, 0);

    // Note: debug overlay is rendered per-frame in render()
    needsRedraw = false;
  }

  // Network -> apply
  network.onInitialState((opsAny) => {
    const list = opsAny as any[];
    strokes = list.filter(o => o.type === 'stroke');
    shapes = list.filter(o => o.type === 'shape');
    // Sort strokes by timestamp for consistent conflict resolution
    const sorter = (a: any, b: any) => {
      const aTime = a.timestamp || 0;
      const bTime = b.timestamp || 0;
      if (aTime !== bTime) return aTime - bTime;
      const aServerTime = (a as any).serverTimestamp || aTime;
      const bServerTime = (b as any).serverTimestamp || bTime;
      if (aServerTime !== bServerTime) return aServerTime - bServerTime;
      return a.userId.localeCompare(b.userId);
    };
    strokes.sort(sorter as any);
    shapes.sort(sorter as any);
    redrawAll();
  });

  network.onStrokeAppended((s) => {
    const stroke = s as StrokeOp;
    const existing = strokes.find(existing => existing.id === stroke.id);
    
    // If this is our active stroke, DON'T add it to strokes array yet
    // It will be added when the stroke ends to avoid duplicate rendering
    if (activeStroke && activeStroke.id === stroke.id) {
      // Just sync metadata, but don't add to strokes array
      // The active stroke is rendered separately in the render loop
      activeStroke.color = stroke.color;
      activeStroke.width = stroke.width;
      activeStroke.mode = stroke.mode;
      // Preserve server timestamp if provided
      if ((stroke as any).timestamp) {
        activeStroke.timestamp = (stroke as any).timestamp;
      }
      if ((stroke as any).serverTimestamp) {
        (activeStroke as any).serverTimestamp = (stroke as any).serverTimestamp;
      }
      // Don't add to strokes array - it's still active and rendered separately
      return;
    }
    
    // For other users' strokes or strokes not in active
    if (!existing) {
      strokes.push(stroke);
      // Re-sort after adding to maintain order
      strokes.sort((a, b) => {
        const aTime = a.timestamp || 0;
        const bTime = b.timestamp || 0;
        if (aTime !== bTime) return aTime - bTime;
        const aServerTime = (a as any).serverTimestamp || aTime;
        const bServerTime = (b as any).serverTimestamp || bTime;
        if (aServerTime !== bServerTime) return aServerTime - bServerTime;
        return a.userId.localeCompare(b.userId);
      });
      // Full redraw to maintain sorted order
      redrawAll();
    }
  });

  network.onStrokePatched(({ id, points }) => {
    // Update active stroke if it matches
    if (activeStroke && activeStroke.id === id) {
      activeStroke.points = points as Point[];
      // Update the stroke in array too
      const s = strokes.find(x => x.id === id);
      if (s) {
        s.points = points as Point[];
      }
      needsRedraw = true; // Always redraw for active stroke
      return;
    }
    
    // Update other strokes
    const s = strokes.find(x => x.id === id);
    if (!s) {
      // Stroke not found - might be from another user who started before we joined
      // Try to find it in server state or create a placeholder
      // For now, we'll just skip - stroke:append should have added it
      console.warn('Received patch for unknown stroke:', id);
      return;
    }
    const oldLength = s.points.length;
    s.points = points as Point[];
    // Only redraw if points actually changed
    if (s.points.length !== oldLength || needsRedraw) {
      needsRedraw = true;
    }
  });

  network.onWholeStateReplaced((opsAny) => {
    try {
      const list = opsAny as any[];
      const newStrokes = list.filter(o => o.type === 'stroke') as StrokeOp[];
      const newShapes = list.filter(o => o.type === 'shape') as (ShapeRect | ShapeCircle | ShapeText | ShapeImage)[];
      // Preserve active stroke if we're currently drawing
      if (activeStroke) {
        const activeInState = newStrokes.find(s => s.id === activeStroke!.id);
        if (!activeInState) {
          // Our active stroke isn't in server state yet - keep it
          strokes = [...newStrokes, activeStroke];
          shapes = newShapes;
        } else {
          // Server has it - use server version
          strokes = newStrokes;
          shapes = newShapes;
          activeStroke = activeInState; // Sync with server version
        }
      } else {
        strokes = newStrokes;
        shapes = newShapes;
      }
      // Sort by timestamp for consistent conflict resolution
      const sorter = (a: any, b: any) => {
        const aTime = a.timestamp || 0;
        const bTime = b.timestamp || 0;
        if (aTime !== bTime) return aTime - bTime;
        const aServerTime = (a as any).serverTimestamp || aTime;
        const bServerTime = (b as any).serverTimestamp || bTime;
        if (aServerTime !== bServerTime) return aServerTime - bServerTime;
        return a.userId.localeCompare(b.userId);
      };
      strokes.sort(sorter as any);
      shapes.sort(sorter as any);
      redrawAll();
    } catch (err) {
      console.error('Error handling state replacement:', err);
    }
  });

  function canvasPointFromEvent(e: PointerEvent): Point {
    const rect = canvas.getBoundingClientRect();
    // Store in CSS pixel coordinates (canvas transform handles DPR scaling)
    return { x: e.clientX - rect.left, y: e.clientY - rect.top, t: performance.now() };
  }

  let lastStrokeStartTime = 0;
  function startStroke(e: PointerEvent) {
    // Prevent rapid double-taps from interfering
    const now = performance.now();
    if (now - lastStrokeStartTime < 100 && isPointerDown) {
      return; // Ignore rapid successive starts
    }
    lastStrokeStartTime = now;
    
    // If already drawing, end the previous stroke first
    if (isPointerDown && activeStroke) {
      endStroke(e);
    }
    
    // Tool branching
    const tool = getTool();
    if (tool === 'rect' || tool === 'circle') {
      isPointerDown = true;
      try { (e.target as Element).setPointerCapture?.((e as unknown as PointerEvent).pointerId); } catch {}
      const p = canvasPointFromEvent(e);
      if (tool === 'rect') {
        activeShape = {
          id: network.newOpId(), userId: network.userId(), type: 'shape', shape: 'rect', color: getColor(), width: getStrokeWidth(),
          x: p.x, y: p.y, w: 0, h: 0, timestamp: Date.now(),
        } as ShapeRect;
      } else {
        activeShape = {
          id: network.newOpId(), userId: network.userId(), type: 'shape', shape: 'circle', color: getColor(), width: getStrokeWidth(),
          cx: p.x, cy: p.y, r: 0, timestamp: Date.now(),
        } as ShapeCircle;
      }
      needsRedraw = true;
      e.preventDefault();
      return;
    }

    if (tool === 'text') {
      const p = canvasPointFromEvent(e);
      const text = prompt('Enter text');
      if (text && text.length > 0) {
        const op: ShapeText = {
          id: network.newOpId(), userId: network.userId(), type: 'shape', shape: 'text',
          color: getColor(), text, font: 'bold 18px Inter, sans-serif', x: p.x, y: p.y, timestamp: Date.now(),
        };
        shapes.push(op);
        network.sendShapeAdd(op as any);
        redrawAll();
      }
      e.preventDefault();
      return;
    }

    if (tool === 'image') {
      const p = canvasPointFromEvent(e);
      const url = prompt('Enter image URL');
      if (url && url.length > 0) {
        const op: ShapeImage = {
          id: network.newOpId(), userId: network.userId(), type: 'shape', shape: 'image',
          url, x: p.x, y: p.y, w: 200, h: 200, timestamp: Date.now(),
        };
        shapes.push(op);
        network.sendShapeAdd(op as any);
        redrawAll();
      }
      e.preventDefault();
      return;
    }

    isPointerDown = true;
    try { (e.target as Element).setPointerCapture?.((e as unknown as PointerEvent).pointerId); } catch {}
    const p = canvasPointFromEvent(e);
    const mode = getTool() === 'eraser' ? 'erase' : 'draw';
    // Add client-side timestamp for conflict resolution
    const clientTimestamp = Date.now();
    activeStroke = {
      id: network.newOpId(),
      userId: network.userId(),
      type: 'stroke',
      mode,
      color: getColor(),
      width: getStrokeWidth(),
      points: [p],
      timestamp: clientTimestamp, // Client timestamp for conflict resolution
    };
    network.sendStrokeStart(activeStroke);
    e.preventDefault();
  }

  let lastSentAt = 0;
  const THROTTLE_MS = 8; // ~120Hz for smoother updates
  const MIN_DISTANCE = 0.5; // Very small threshold - capture almost all points for smoothness
  
  function moveStroke(e: PointerEvent) {
    if (!isPointerDown || !activeStroke) return;
    const p = canvasPointFromEvent(e);
    
    // Add point if it's far enough, or if we have very few points
    const lastPoint = activeStroke.points[activeStroke.points.length - 1];
    if (lastPoint) {
      const dx = p.x - lastPoint.x;
      const dy = p.y - lastPoint.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      
      // Only filter extremely close points (less than 0.5px) to reduce noise
      // But always add if we have fewer than 3 points to ensure smooth start
      if (distance < MIN_DISTANCE && activeStroke.points.length >= 3) {
        // Update the last point's time but keep position
        lastPoint.t = p.t;
        needsRedraw = true;
        e.preventDefault();
        return;
      }
    }
    
    // Always add the point for local rendering - smoothing will handle it
    activeStroke.points.push(p);
    needsRedraw = true;
    
    // Throttle stroke updates for network
    const now = performance.now();
    if (now - lastSentAt > THROTTLE_MS) {
      lastSentAt = now;
      try {
        network.sendStrokeUpdate(activeStroke.id, activeStroke.points);
      } catch (err) {
        console.error('Error sending stroke update:', err);
      }
    }
    e.preventDefault();
  }

  function endStroke(e: PointerEvent) {
    if (!activeStroke) return;
    isPointerDown = false;
    try { (e.target as Element).releasePointerCapture?.((e as unknown as PointerEvent).pointerId); } catch {}
    
    // Ensure we have at least one point
    if (activeStroke.points.length === 0) {
      activeStroke = null;
      return;
    }
    
    // Commit the active stroke to the strokes array if not already there
    const existing = strokes.find(s => s.id === activeStroke!.id);
    if (!existing) {
      strokes.push({ ...activeStroke }); // Copy to avoid reference issues
      // Sort strokes after adding to maintain order
      strokes.sort((a, b) => {
        const aTime = a.timestamp || 0;
        const bTime = b.timestamp || 0;
        if (aTime !== bTime) return aTime - bTime;
        const aServerTime = (a as any).serverTimestamp || aTime;
        const bServerTime = (b as any).serverTimestamp || bTime;
        if (aServerTime !== bServerTime) return aServerTime - bServerTime;
        return a.userId.localeCompare(b.userId);
      });
      redrawAll();
    } else {
      // Update existing stroke with final points
      existing.points = [...activeStroke.points];
      redrawAll();
    }
    
    network.sendStrokeEnd(activeStroke.id);
    activeStroke = null;
    needsRedraw = true;
    if (e) e.preventDefault();
  }

  // Shape dragging with pointermove/pointerup reuse

  const origEndStroke = endStroke;
  function endAny(e: PointerEvent) {
    const tool = getTool();
    if (isPointerDown && activeShape && (tool === 'rect' || tool === 'circle')) {
      isPointerDown = false;
      try { (e.target as Element).releasePointerCapture?.((e as unknown as PointerEvent).pointerId); } catch {}
      shapes.push(activeShape);
      network.sendShapeAdd(activeShape as any);
      activeShape = null;
      needsRedraw = true;
      e.preventDefault();
      return;
    }
    origEndStroke(e);
  }

  // Track mouse movement for cursor indicators (even when not drawing)
  let lastCursorSentAt = 0;
  function handlePointerMove(e: PointerEvent) {
    // If sizing a shape, update it and render
    const toolForShape = getTool();
    if (isPointerDown && activeShape && (toolForShape === 'rect' || toolForShape === 'circle')) {
      const p = canvasPointFromEvent(e);
      if ((activeShape as any).shape === 'rect') {
        const r = activeShape as ShapeRect;
        r.w = p.x - r.x;
        r.h = p.y - r.y;
      } else {
        const c = activeShape as ShapeCircle;
        c.r = Math.hypot(p.x - c.cx, p.y - c.cy);
      }
      needsRedraw = true;
      e.preventDefault();
      return;
    }
    // Always send cursor position when moving (not just when drawing)
    const now = performance.now();
    if (now - lastCursorSentAt > 50) { // Send cursor updates at ~20Hz
      const p = canvasPointFromEvent(e);
      network.sendCursor(p);
      lastCursorSentAt = now;
    }
    
    // Also handle drawing if pointer is down
    if (isPointerDown) {
      moveStroke(e);
    }
    e.preventDefault();
  }
  
  // pointer events
  canvas.addEventListener('pointerdown', startStroke);
  canvas.addEventListener('pointermove', handlePointerMove as any);
  canvas.addEventListener('pointerup', endAny as any);
  canvas.addEventListener('pointerleave', endAny as any);

  // Receive shapes from others
  network.onShapeAppended((op) => {
    const s = op as any;
    if (s && s.type === 'shape') {
      shapes.push(s);
      redrawAll();
    }
  });

  // cursors from others
  const cursorLayer = document.createElement('canvas');
  const cursorCtx = cursorLayer.getContext('2d')!;
  function resizeCursorLayer() {
    cursorLayer.width = canvas.width;
    cursorLayer.height = canvas.height;
    // Match the main canvas transform - cursors are in CSS pixel coordinates
    cursorCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resizeCursorLayer();
  
  // Resize cursor layer when canvas resizes
  const resizeObserver = new ResizeObserver(() => {
    resizeCursorLayer();
  });
  resizeObserver.observe(canvas);

  // Cursor state with smoothing
  type CursorState = {
    x: number;
    y: number;
    targetX: number;
    targetY: number;
    color: string;
    userId: string;
    last: number;
    velocityX: number;
    velocityY: number;
  };
  
  const cursors: Record<string, CursorState> = {};
  const userInfo: Record<string, { color: string; name?: string }> = {};
  
  network.onCursor((u) => {
    // Don't show our own cursor (we already see it)
    if (u.id === network.userId()) {
      return;
    }
    
    const now = performance.now();
    const existing = cursors[u.id];
    
    if (existing) {
      // Smooth interpolation - update target position
      existing.targetX = u.x;
      existing.targetY = u.y;
      existing.last = now;
      existing.color = u.color;
    } else {
      // Initialize cursor
      cursors[u.id] = {
        x: u.x,
        y: u.y,
        targetX: u.x,
        targetY: u.y,
        color: u.color,
        userId: u.id,
        last: now,
        velocityX: 0,
        velocityY: 0,
      };
    }
    
    // Store user info for labels
    if (!userInfo[u.id]) {
      userInfo[u.id] = { color: u.color };
    } else {
      userInfo[u.id].color = u.color;
    }
  });

  let lastCursorRender = 0;
  let lastFullRedraw = 0;
  function render() {
    const now = performance.now();
    
    // Always render drawing layer if we need redraw or are actively drawing
    // Also do periodic full redraws to catch any missed updates (every 100ms)
    const isActivelyDrawing = activeStroke && isPointerDown;
    
    // Always render when actively drawing for smooth 60fps
    if (isActivelyDrawing || needsRedraw || (now - lastFullRedraw > 100)) {
      // Redraw offscreen canvas if strokes changed
      if (needsRedraw && !isActivelyDrawing) {
        // Only full redraw when not actively drawing to avoid flicker
        redrawAll();
        lastFullRedraw = now;
      } else if (!isActivelyDrawing) {
        // Just blit existing offscreen when not drawing
        clearCanvas(ctx);
        ctx.drawImage(offscreen, 0, 0);
      } else {
        // When actively drawing, blit offscreen first, then draw active stroke
        clearCanvas(ctx);
        ctx.drawImage(offscreen, 0, 0);
      }
      
      // Always render active stroke preview above committed layer when drawing
      // Apply light smoothing for active strokes for smooth curves
      if (isActivelyDrawing && activeStroke && !activeStroke.isDeleted && activeStroke.points.length > 0) {
        // For active strokes with many points, apply smoothing for better curves
        if (activeStroke.points.length > 3) {
          drawStroke(ctx, activeStroke, true); // Apply smoothing for smooth curves
        } else {
          drawStroke(ctx, activeStroke, false); // No smoothing for very short strokes
        }
      }
      if (activeShape) {
        drawShape(ctx, activeShape);
      }
      needsRedraw = false;
    }
    
    // Render cursors every frame with smooth interpolation
    cursorCtx.clearRect(0, 0, canvas.width, canvas.height);
    const cursorKeys = Object.keys(cursors);
    const deltaTime = Math.min(now - lastCursorRender, 50) / 1000; // Cap at 50ms for stability
    
    // Always render cursor layer (even if empty) to ensure it's visible
    if (cursorKeys.length > 0) {
      for (const k of cursorKeys) {
        const c = cursors[k];
        // Remove stale cursors (inactive for >3 seconds)
        if (now - c.last > 3000) { 
          delete cursors[k]; 
          continue; 
        }
        
        // Smooth interpolation using exponential smoothing (easing)
        const smoothingFactor = 0.3; // Adjust for smoothness (0-1, lower = smoother)
        const dx = c.targetX - c.x;
        const dy = c.targetY - c.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        
        // Only smooth if distance is significant (reduces micro-jitter)
        if (distance > 0.1) {
          c.x += dx * smoothingFactor;
          c.y += dy * smoothingFactor;
        } else {
          // Snap to target if very close
          c.x = c.targetX;
          c.y = c.targetY;
        }
        
        const info = userInfo[c.userId];
        // Use stored name from presence updates, or fallback to ID
        let userName = info?.name;
        if (!userName) {
          // Fallback: use first 8 chars of ID
          userName = c.userId.slice(0, 8);
        }
        
        cursorCtx.save();
        
        // Calculate cursor age and fade
        const age = now - c.last;
        const fadeAlpha = age > 2000 ? Math.max(0, 1 - (age - 2000) / 1000) : 1;
        
        // Draw cursor trail/pulse effect for active cursors
        if (age < 1000) {
          const pulseRadius = 10 + (age < 500 ? Math.sin(age / 100) * 2 : 0);
          cursorCtx.globalAlpha = 0.2 * fadeAlpha;
          cursorCtx.fillStyle = c.color;
          cursorCtx.beginPath();
          cursorCtx.arc(c.x, c.y, pulseRadius, 0, Math.PI * 2);
          cursorCtx.fill();
        }
        
        // Main cursor circle with fade - make it larger and more visible
        cursorCtx.globalAlpha = fadeAlpha;
        cursorCtx.fillStyle = c.color;
        cursorCtx.beginPath();
        cursorCtx.arc(c.x, c.y, 10, 0, Math.PI * 2);
        cursorCtx.fill();
        
        // White border for visibility - thicker
        cursorCtx.strokeStyle = 'white';
        cursorCtx.lineWidth = 3;
        cursorCtx.stroke();
        
        // Inner white dot for better visibility - larger
        cursorCtx.fillStyle = 'white';
        cursorCtx.beginPath();
        cursorCtx.arc(c.x, c.y, 4, 0, Math.PI * 2);
        cursorCtx.fill();
        
        // Additional outer ring for visibility
        cursorCtx.strokeStyle = c.color;
        cursorCtx.lineWidth = 1;
        cursorCtx.globalAlpha = 0.5 * fadeAlpha;
        cursorCtx.beginPath();
        cursorCtx.arc(c.x, c.y, 14, 0, Math.PI * 2);
        cursorCtx.stroke();
        
        // Draw user name label (only if cursor is recent)
        if (age < 2000) {
          cursorCtx.font = 'bold 12px Inter, sans-serif';
          cursorCtx.textAlign = 'center';
          cursorCtx.textBaseline = 'bottom';
          
          const labelText = userName;
          const labelWidth = cursorCtx.measureText(labelText).width;
          const labelPadding = 8;
          const labelHeight = 20;
          const labelX = c.x;
          const labelY = c.y - 15;
          
          // Label background with rounded corners effect
          cursorCtx.fillStyle = c.color;
          cursorCtx.globalAlpha = 0.95 * fadeAlpha;
          cursorCtx.fillRect(
            labelX - labelWidth / 2 - labelPadding,
            labelY - labelHeight,
            labelWidth + labelPadding * 2,
            labelHeight
          );
          
          // Label border
          cursorCtx.strokeStyle = 'white';
          cursorCtx.lineWidth = 1.5;
          cursorCtx.strokeRect(
            labelX - labelWidth / 2 - labelPadding,
            labelY - labelHeight,
            labelWidth + labelPadding * 2,
            labelHeight
          );
          
          // Label text
          cursorCtx.globalAlpha = fadeAlpha;
          cursorCtx.fillStyle = 'white';
          cursorCtx.fillText(labelText, labelX, labelY - 3);
        }
        
        cursorCtx.restore();
      }
    }
    // Always draw cursor layer (even if empty) to ensure it's composited properly
    ctx.drawImage(cursorLayer, 0, 0);
    
    // Debug: draw render order overlay each frame so it persists
    if (debugRenderOrder) {
      // Compute sorted order for strokes + shapes
      const combined: AnyOp[] = [...strokes, ...shapes].sort((a: any, b: any) => {
        const aTime = a.timestamp || 0;
        const bTime = b.timestamp || 0;
        if (aTime !== bTime) return aTime - bTime;
        const aServerTime = (a as any).serverTimestamp || aTime;
        const bServerTime = (b as any).serverTimestamp || bTime;
        if (aServerTime !== bServerTime) return aServerTime - bServerTime;
        return a.userId.localeCompare(b.userId);
      });
      ctx.save();
      ctx.font = 'bold 11px Inter, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      for (let i = 0; i < combined.length; i++) {
        const op = combined[i] as any;
        let x = 0, y = 0;
        if (op.type === 'stroke') {
          if (!op.points || op.points.length === 0 || op.isDeleted) continue;
          x = op.points[0].x; y = op.points[0].y;
        } else if (op.type === 'shape') {
          if (op.shape === 'rect') { x = op.x; y = op.y; }
          else if (op.shape === 'circle') { x = op.cx; y = op.cy; }
          else if (op.shape === 'text') { x = op.x; y = op.y; }
          else if (op.shape === 'image') { x = op.x; y = op.y; }
        }
        const label = `${i + 1}`;
        const w = ctx.measureText(label).width + 6;
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(x - 2, y - 9, w, 14);
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 1;
        ctx.strokeRect(x - 2, y - 9, w, 14);
        ctx.fillStyle = 'white';
        ctx.fillText(label, x + 2, y);
      }
      ctx.restore();
    }
    lastCursorRender = now;
    
    network.tickFps();
    requestAnimationFrame(render);
  }
  requestAnimationFrame(render);

  return {
    setTool(tool: Tool) {
      // handled via getTool callback; no-op
    },
    redrawAll,
    updateUserInfo(users: Array<{ id: string; color: string; name?: string }>) {
      for (const u of users) {
        userInfo[u.id] = { color: u.color, name: u.name };
        // Update existing cursor color if present
        if (cursors[u.id]) {
          cursors[u.id].color = u.color;
        }
      }
    },
    setDebugRenderOrder(enabled: boolean) {
      debugRenderOrder = !!enabled;
      needsRedraw = true;
    },
  };
}


