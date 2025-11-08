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
  // Track locally committed strokes - never allow server to overwrite these
  const locallyCommittedStrokes = new Set<string>();
  // Store original coordinates for committed strokes - these are the source of truth
  const committedStrokeCoordinates = new Map<string, Point[]>();
  // Store canvas dimensions at commit time to detect resizing issues
  const committedStrokeCanvasSize = new Map<string, { width: number; height: number }>();
  // Store normalized coordinates (0-1 range) as backup to handle canvas resizing
  const committedStrokeNormalizedCoordinates = new Map<string, Point[]>();

  const dpr = Math.max(window.devicePixelRatio || 1, 1);

  // Ensure main canvas context has correct transform for CSS pixel coordinates
  // The canvas is sized with DPR, but we draw in CSS pixels
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  function resizeOffscreen() {
    offscreen.width = canvas.width;
    offscreen.height = canvas.height;
    // CRITICAL: Always use current DPR, not cached dpr variable
    // This ensures transforms match between main and offscreen canvas
    const currentDpr = Math.max(window.devicePixelRatio || 1, 1);
    octx.setTransform(currentDpr, 0, 0, currentDpr, 0, 0);
    // Reapply transform to main context after resize to ensure consistency
    ctx.setTransform(currentDpr, 0, 0, currentDpr, 0, 0);
  }

  resizeOffscreen();

  function clearCanvas(target: CanvasRenderingContext2D) {
    target.clearRect(0, 0, canvas.width, canvas.height);
  }

  // Effective smoothing using weighted average
  function smoothPoints(points: Point[]): Point[] {
    if (points.length <= 2) return points;
    
    const smoothed: Point[] = [points[0]]; // Keep first point
    
    for (let i = 1; i < points.length - 1; i++) {
      const prev = points[i - 1];
      const curr = points[i];
      const next = points[i + 1];
      
      // Weighted average - more weight on current point for accuracy
      // This reduces jitter while maintaining accuracy
      const smoothedX = prev.x * 0.25 + curr.x * 0.5 + next.x * 0.25;
      const smoothedY = prev.y * 0.25 + curr.y * 0.5 + next.y * 0.25;
      
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
    if (!s || s.isDeleted) return;
    
    // CRITICAL: For committed strokes, ALWAYS use coordinates from Map
    // Never trust the stroke object's points - they might have been modified by server
    let pointsToRender: Point[];
    if (locallyCommittedStrokes.has(s.id)) {
      // First, try to get stored coordinates
      let storedPoints = committedStrokeCoordinates.get(s.id);
      const storedSize = committedStrokeCanvasSize.get(s.id);
      const normalizedPoints = committedStrokeNormalizedCoordinates.get(s.id);
      
      // DEBUG: Always log what we retrieve from Map - CRITICAL for debugging
      if (storedPoints && storedPoints.length > 0) {
        const mapFirst = storedPoints[0];
        const strokeFirst = s.points[0];
        console.log(`[canvas] drawStroke committed ${s.id.substring(0, 12)}: Map(${mapFirst.x.toFixed(1)},${mapFirst.y.toFixed(1)}) vs Stroke(${strokeFirst?.x.toFixed(1) || 'N/A'},${strokeFirst?.y.toFixed(1) || 'N/A'})`);
        
        // CRITICAL: If coordinates don't match, this is the problem!
        if (strokeFirst && (Math.abs(mapFirst.x - strokeFirst.x) > 1 || Math.abs(mapFirst.y - strokeFirst.y) > 1)) {
          console.error(`[canvas] MISMATCH DETECTED! Stroke ${s.id.substring(0, 12)} coordinates differ by more than 1px!`);
        }
      } else {
        console.error(`[canvas] ERROR: Committed stroke ${s.id.substring(0, 16)} has NO stored coordinates in Map!`);
      }
      
      // Check if canvas has resized - if so, recalculate from normalized coordinates
      if (storedPoints && storedSize && normalizedPoints) {
        const currentRect = canvas.getBoundingClientRect();
        const sizeDiff = Math.abs(currentRect.width - storedSize.width) + Math.abs(currentRect.height - storedSize.height);
        
        // If canvas resized significantly, recalculate coordinates from normalized values
        if (sizeDiff > 1 && currentRect.width > 0 && currentRect.height > 0) {
          console.log(`[canvas] Canvas resized after commit for stroke ${s.id.substring(0, 8)}. Recalculating from normalized coordinates. Old: ${storedSize.width}x${storedSize.height}, New: ${currentRect.width.toFixed(2)}x${currentRect.height.toFixed(2)}`);
          // Recalculate from normalized coordinates
          storedPoints = normalizedPoints.map(p => ({
            x: Number((p.x * currentRect.width).toFixed(4)),
            y: Number((p.y * currentRect.height).toFixed(4)),
            t: p.t
          }));
          // Update stored coordinates for next render
          committedStrokeCoordinates.set(s.id, storedPoints);
          committedStrokeCanvasSize.set(s.id, { width: currentRect.width, height: currentRect.height });
        }
      }
      
      if (storedPoints && storedPoints.length > 0) {
        // Use stored coordinates directly - these are the source of truth
        // Create a fresh array to ensure no reference sharing
        pointsToRender = storedPoints.map(p => ({ x: p.x, y: p.y, t: p.t }));
        
        // CRITICAL: Also update the stroke object's points array to match
        // This ensures the stroke object in the array always has correct coordinates
        // Do this every time we render to prevent any drift
        const firstStoredPoint = storedPoints[0];
        const firstStrokePoint = s.points[0];
        
        // ALWAYS log for debugging - this is the critical issue
        if (Math.random() < 0.1) { // 10% sampling
          console.log(`[canvas] Rendering committed stroke ${s.id.substring(0, 16)}...`);
          console.log(`  - Retrieved from Map: first point (${firstStoredPoint.x.toFixed(4)}, ${firstStoredPoint.y.toFixed(4)})`);
          console.log(`  - Stroke object points[0]: (${firstStrokePoint?.x.toFixed(4) || 'undefined'}, ${firstStrokePoint?.y.toFixed(4) || 'undefined'})`);
          console.log(`  - Will render using: (${pointsToRender[0].x.toFixed(4)}, ${pointsToRender[0].y.toFixed(4)})`);
        }
        
        if (!firstStrokePoint || 
            Math.abs(firstStrokePoint.x - firstStoredPoint.x) > 0.01 || 
            Math.abs(firstStrokePoint.y - firstStoredPoint.y) > 0.01) {
          // Coordinates don't match - this means something modified the stroke object
          // Log a warning and restore from stored coordinates
          console.warn(`[canvas] Stroke ${s.id.substring(0, 16)} coordinates were modified! Stored: (${firstStoredPoint.x.toFixed(4)}, ${firstStoredPoint.y.toFixed(4)}), Stroke object: (${firstStrokePoint?.x.toFixed(4) || 'undefined'}, ${firstStrokePoint?.y.toFixed(4) || 'undefined'}). Restoring.`);
          // Replace the entire points array to ensure consistency
          s.points = pointsToRender.map(p => ({ x: p.x, y: p.y, t: p.t }));
        }
      } else {
        // Fallback: if no stored coordinates, use stroke points but log warning
        console.warn(`[canvas] Committed stroke ${s.id} has no stored coordinates, using stroke points`);
        pointsToRender = s.points;
      }
    } else {
      // For non-committed strokes, use the stroke's points
      pointsToRender = s.points;
    }
    
    // Early return if no points to render
    if (!pointsToRender || pointsToRender.length < 1) return;
    
    // CRITICAL: Ensure transform is set correctly before drawing
    // The target context (octx or ctx) should already have the transform set,
    // but we ensure it here for safety
    const currentDpr = Math.max(window.devicePixelRatio || 1, 1);
    target.save();
    // Ensure transform matches - this is critical for coordinate accuracy
    target.setTransform(currentDpr, 0, 0, currentDpr, 0, 0);
    
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
    
    // Use the points we determined above (either from Map or stroke object)
    let points: Point[] = pointsToRender;
    
    // Apply smoothing for better curve quality
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
      // Multiple points - use simple, smooth quadratic curves
      // This is the most reliable approach for smooth strokes
      target.moveTo(points[0].x, points[0].y);
      
      // Draw smooth curves through all points
      for (let i = 1; i < points.length; i++) {
        const prev = points[i - 1];
        const curr = points[i];
        
        if (i === 1 && points.length === 2) {
          // Only 2 points total - simple line
          target.lineTo(curr.x, curr.y);
        } else if (i === points.length - 1) {
          // Last point - ensure we reach it with a smooth curve
          if (points.length > 2) {
            const prev2 = points[i - 2];
            // Control point based on previous segment for smooth finish
            const cpX = prev.x + (curr.x - prev2.x) * 0.5;
            const cpY = prev.y + (curr.y - prev2.y) * 0.5;
            target.quadraticCurveTo(cpX, cpY, curr.x, curr.y);
          } else {
            target.lineTo(curr.x, curr.y);
          }
        } else {
          // Middle points - use smooth quadratic curves
          const next = points[i + 1];
          // Control point is current point
          // End point is midpoint to next for continuous smooth curves
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
    // CRITICAL: Ensure transform is correct on BOTH contexts before rendering
    // Both main canvas and offscreen canvas must use the exact same transform
    const currentDpr = Math.max(window.devicePixelRatio || 1, 1);
    ctx.setTransform(currentDpr, 0, 0, currentDpr, 0, 0);
    
    resizeOffscreen();
    
    // CRITICAL: Ensure offscreen context has the exact same transform as main context
    // This ensures coordinates render at the same positions on both canvases
    const verifyDpr = Math.max(window.devicePixelRatio || 1, 1);
    octx.setTransform(verifyDpr, 0, 0, verifyDpr, 0, 0);
    
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
    // Always apply smoothing to all committed strokes for smooth rendering
    for (const s of sortedOps) {
      if ((s as any).type === 'stroke') {
        if (!(s as any).isDeleted) {
          // CRITICAL: For committed strokes, verify stored coordinates before rendering
          if (locallyCommittedStrokes.has(s.id)) {
            const stored = committedStrokeCoordinates.get(s.id);
            if (stored && stored.length > 0) {
              // Verify stored coordinates match what we expect
              const strokeFirst = s.points[0];
              const storedFirst = stored[0];
              if (strokeFirst && storedFirst && 
                  (Math.abs(strokeFirst.x - storedFirst.x) > 0.01 || 
                   Math.abs(strokeFirst.y - storedFirst.y) > 0.01)) {
                console.warn(`[canvas] Before redrawAll: Stroke ${s.id.substring(0, 16)} has mismatched coordinates. Stroke: (${strokeFirst.x.toFixed(2)}, ${strokeFirst.y.toFixed(2)}), Stored: (${storedFirst.x.toFixed(2)}, ${storedFirst.y.toFixed(2)}). Fixing...`);
                // Fix it before rendering
                s.points = stored.map(p => ({ x: p.x, y: p.y, t: p.t }));
              }
            }
          }
          drawStroke(octx, s as StrokeOp, true); // Always smooth committed strokes
        }
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
    const serverStrokes = list.filter(o => o.type === 'stroke') as StrokeOp[];
    const myUserId = network.userId();
    
    // CRITICAL: Preserve ALL locally committed strokes - never overwrite them
    // These have the correct local coordinates and must be preserved
    const committedStrokes = strokes.filter(s => locallyCommittedStrokes.has(s.id));
    
    // For each committed stroke, ensure its coordinates in the Map are preserved
    // and restore the stroke's points from the Map if they were modified
    committedStrokes.forEach(stroke => {
      const storedCoords = committedStrokeCoordinates.get(stroke.id);
      if (storedCoords) {
        // Restore points from stored coordinates - these are the source of truth
        stroke.points = storedCoords.map(p => ({ x: p.x, y: p.y, t: p.t }));
      }
    });
    
    // Merge server strokes with our committed strokes
    // Remove server versions of strokes we've committed locally
    const mergedStrokes = [
      ...serverStrokes.filter(s => !locallyCommittedStrokes.has(s.id)),
      ...committedStrokes
    ];
    
    strokes = mergedStrokes;
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
    
    // ABSOLUTE BLOCK: If this stroke is locally committed, IGNORE completely
    if (locallyCommittedStrokes.has(stroke.id)) {
      // This stroke was committed locally with correct coordinates
      // Never allow server to overwrite it
      return;
    }
    
    const existing = strokes.find(existing => existing.id === stroke.id);
    
    // If this is our active stroke, IGNORE server updates completely while drawing
    // This prevents server sync from interfering with smooth local rendering
    if (activeStroke && activeStroke.id === stroke.id && isPointerDown) {
      // Completely ignore server updates for active strokes while drawing
      // This keeps the smooth local rendering uninterrupted
      return;
    }
    
    // If stroke is already committed (exists in strokes array), DON'T overwrite it
    // The local version has the correct, smooth coordinates
    if (existing && existing.userId === network.userId()) {
      // This is our own committed stroke - preserve local points, only sync metadata
      existing.color = stroke.color;
      existing.width = stroke.width;
      existing.mode = stroke.mode;
      if ((stroke as any).timestamp) {
        existing.timestamp = (stroke as any).timestamp;
      }
      if ((stroke as any).serverTimestamp) {
        (existing as any).serverTimestamp = (stroke as any).serverTimestamp;
      }
      // DON'T overwrite points - local version is more accurate
      return;
    }
    
    // If this was our active stroke but we're done drawing, ignore it
    // It's already been committed with local points in endStroke
    if (activeStroke && activeStroke.id === stroke.id && !isPointerDown) {
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
      // Only redraw if not actively drawing to avoid interference
      if (!isPointerDown) {
        redrawAll();
      } else {
        needsRedraw = true;
      }
    }
  });

  network.onStrokePatched(({ id, points }) => {
    // ABSOLUTE BLOCK: If this stroke is locally committed, IGNORE completely
    if (locallyCommittedStrokes.has(id)) {
      // This stroke was committed locally with correct coordinates
      // Never allow server to overwrite it
      return;
    }
    
    // IGNORE server patches for active strokes while drawing
    // This prevents server updates from interfering with smooth local rendering
    if (activeStroke && activeStroke.id === id && isPointerDown) {
      // Completely ignore server patches while actively drawing
      // Local rendering is smoother with all points captured
      return;
    }
    
    // Find the stroke in the array
    const s = strokes.find(x => x.id === id);
    
    // If this is our own committed stroke, DON'T overwrite points
    // Local version has the correct, smooth coordinates
    if (s && s.userId === network.userId()) {
      // This is our own stroke - preserve local points, ignore server patches
      // Server might have fewer points or different coordinates
      return;
    }
    
    // Update active stroke if it matches (but only if not actively drawing)
    if (activeStroke && activeStroke.id === id && !isPointerDown) {
      // Don't overwrite local points - they're smoother
      // Only update if server has more points (shouldn't happen, but just in case)
      if (points.length > activeStroke.points.length) {
        activeStroke.points = points as Point[];
      }
      needsRedraw = true;
      return;
    }
    
    // Update other users' strokes
    if (!s) {
      // Stroke not found - might be from another user who started before we joined
      // Try to find it in server state or create a placeholder
      // For now, we'll just skip - stroke:append should have added it
      console.warn('Received patch for unknown stroke:', id);
      return;
    }
    const oldLength = s.points.length;
    s.points = points as Point[];
    // Only redraw if points actually changed and not actively drawing
    if (s.points.length !== oldLength) {
      if (!isPointerDown) {
        needsRedraw = true;
      }
    }
  });

  network.onWholeStateReplaced((opsAny) => {
    try {
      const list = opsAny as any[];
      const newStrokes = list.filter(o => o.type === 'stroke') as StrokeOp[];
      const newShapes = list.filter(o => o.type === 'shape') as (ShapeRect | ShapeCircle | ShapeText | ShapeImage)[];
      const myUserId = network.userId();
      
      // CRITICAL: Preserve ALL locally committed strokes - never overwrite them
      // These have the correct local coordinates and must be preserved
      const ourCommittedStrokes = strokes.filter(s => 
        locallyCommittedStrokes.has(s.id) || (s.userId === myUserId && s.id !== activeStroke?.id)
      );
      
      // For each committed stroke, restore coordinates from the Map
      ourCommittedStrokes.forEach(stroke => {
        if (locallyCommittedStrokes.has(stroke.id)) {
          const storedCoords = committedStrokeCoordinates.get(stroke.id);
          if (storedCoords) {
            // Restore points from stored coordinates - these are the source of truth
            stroke.points = storedCoords.map(p => ({ x: p.x, y: p.y, t: p.t }));
          }
        }
      });
      
      // Preserve active stroke if we're currently drawing
      if (activeStroke) {
        const activeInState = newStrokes.find(s => s.id === activeStroke!.id);
        if (!activeInState) {
          // Our active stroke isn't in server state yet - keep it
          strokes = [
            ...newStrokes.filter(s => !locallyCommittedStrokes.has(s.id) && s.userId !== myUserId), 
            ...ourCommittedStrokes, 
            activeStroke
          ];
          shapes = newShapes;
        } else {
          // Server has it - but keep our local version if we're drawing or committed
          if (isPointerDown || locallyCommittedStrokes.has(activeStroke.id)) {
            strokes = [
              ...newStrokes.filter(s => !locallyCommittedStrokes.has(s.id) && s.userId !== myUserId), 
              ...ourCommittedStrokes, 
              activeStroke
            ];
          } else {
            strokes = [
              ...newStrokes.filter(s => !locallyCommittedStrokes.has(s.id) && s.userId !== myUserId), 
              ...ourCommittedStrokes
            ];
          }
          shapes = newShapes;
          if (!isPointerDown && !locallyCommittedStrokes.has(activeStroke.id)) {
            activeStroke = activeInState; // Only sync if not drawing and not committed
          }
        }
      } else {
        // Merge server strokes with our local committed strokes
        // NEVER overwrite locally committed strokes
        strokes = [
          ...newStrokes.filter(s => !locallyCommittedStrokes.has(s.id) && s.userId !== myUserId), 
          ...ourCommittedStrokes
        ];
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
    // Ensure transform is correct - always use current DPR
    const currentDpr = Math.max(window.devicePixelRatio || 1, 1);
    ctx.setTransform(currentDpr, 0, 0, currentDpr, 0, 0);
    
    // CRITICAL: Always use getBoundingClientRect() - it's the most reliable
    // offsetX/offsetY can be unreliable with pointer capture or nested elements
    // getBoundingClientRect() always gives accurate element-relative coordinates
    const rect = canvas.getBoundingClientRect();
    
    // Calculate coordinates relative to canvas element's top-left corner
    // clientX/clientY are viewport coordinates, subtract element position
    // getBoundingClientRect() already accounts for CSS transforms and scroll
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    // Validate coordinates are within canvas bounds (use CSS size, not buffer size)
    if (x < 0 || x > rect.width || y < 0 || y > rect.height) {
      console.warn(`[canvas] Coordinates out of bounds: (${x.toFixed(2)}, ${y.toFixed(2)}), canvas CSS size: ${rect.width.toFixed(2)}x${rect.height.toFixed(2)}`);
    }
    
    // Debug: Log coordinates to verify accuracy
    if (Math.random() < 0.05) {
      const offsetX = (e as any).offsetX;
      const offsetY = (e as any).offsetY;
      console.log(`[canvas] Coordinate capture:`);
      console.log(`  - clientX=${e.clientX.toFixed(1)}, clientY=${e.clientY.toFixed(1)}`);
      console.log(`  - rect: left=${rect.left.toFixed(1)}, top=${rect.top.toFixed(1)}, width=${rect.width.toFixed(1)}, height=${rect.height.toFixed(1)}`);
      console.log(`  - Calculated: x=${x.toFixed(2)}, y=${y.toFixed(2)}`);
      console.log(`  - offsetX=${offsetX !== undefined ? offsetX.toFixed(2) : 'N/A'}, offsetY=${offsetY !== undefined ? offsetY.toFixed(2) : 'N/A'}`);
      if (offsetX !== undefined && Math.abs(x - offsetX) > 2) {
        console.warn(`  - MISMATCH! Calculated x=${x.toFixed(2)} vs offsetX=${offsetX.toFixed(2)}, diff=${Math.abs(x - offsetX).toFixed(2)}`);
      }
    }
    
    // Store with sufficient precision to prevent rounding errors
    // Use 4 decimal places for sub-pixel accuracy
    return { 
      x: Number(x.toFixed(4)), 
      y: Number(y.toFixed(4)), 
      t: performance.now() 
    };
  }

  // Store canvas size at stroke start to detect resizing
  let strokeStartCanvasSize: { width: number; height: number } | null = null;
  
  let lastStrokeStartTime = 0;
  function startStroke(e: PointerEvent) {
    // Prevent rapid double-taps from interfering
    const now = performance.now();
    
    // CRITICAL: Capture canvas size at stroke start
    // This helps detect if canvas resizes during drawing
    const rect = canvas.getBoundingClientRect();
    strokeStartCanvasSize = { width: rect.width, height: rect.height };
    
    // DEBUG: Draw a green marker at the exact capture point IMMEDIATELY
    // This helps verify that coordinates are captured correctly
    const testPoint = canvasPointFromEvent(e);
    console.log(`[canvas] DEBUG: About to draw GREEN marker:`);
    console.log(`  - Captured point: (${testPoint.x.toFixed(2)}, ${testPoint.y.toFixed(2)})`);
    console.log(`  - Canvas CSS size: ${rect.width.toFixed(2)}x${rect.height.toFixed(2)}`);
    console.log(`  - Canvas buffer size: ${canvas.width}x${canvas.height}`);
    console.log(`  - Click position: clientX=${e.clientX.toFixed(1)}, clientY=${e.clientY.toFixed(1)}`);
    console.log(`  - Canvas rect: left=${rect.left.toFixed(1)}, top=${rect.top.toFixed(1)}`);
    
    // Draw a VERY LARGE, OBVIOUS marker at the exact click position
    // This helps verify if coordinates are correct or if there's a rendering issue
    const currentDpr = Math.max(window.devicePixelRatio || 1, 1);
    
    // Draw on offscreen canvas (persists through redraws)
    octx.save();
    octx.setTransform(currentDpr, 0, 0, currentDpr, 0, 0);
    // Large bright red circle - impossible to miss
    octx.fillStyle = 'red';
    octx.globalAlpha = 0.8;
    octx.beginPath();
    octx.arc(testPoint.x, testPoint.y, 30, 0, Math.PI * 2);
    octx.fill();
    // Bright yellow center
    octx.fillStyle = 'yellow';
    octx.beginPath();
    octx.arc(testPoint.x, testPoint.y, 10, 0, Math.PI * 2);
    octx.fill();
    octx.restore();
    
    // Also draw on main canvas for immediate visual feedback
    ctx.save();
    ctx.setTransform(currentDpr, 0, 0, currentDpr, 0, 0);
    // Large bright red circle
    ctx.fillStyle = 'red';
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    ctx.arc(testPoint.x, testPoint.y, 30, 0, Math.PI * 2);
    ctx.fill();
    // Bright yellow center
    ctx.fillStyle = 'yellow';
    ctx.beginPath();
    ctx.arc(testPoint.x, testPoint.y, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    
    // ALSO draw a lime marker using offsetX/offsetY directly from the event
    // This helps verify if getBoundingClientRect() or offsetX/offsetY is more accurate
    const offsetX = (e as any).offsetX;
    const offsetY = (e as any).offsetY;
    if (offsetX !== undefined && offsetY !== undefined && !isNaN(offsetX) && !isNaN(offsetY)) {
      octx.save();
      octx.setTransform(currentDpr, 0, 0, currentDpr, 0, 0);
      octx.fillStyle = 'lime';
      octx.globalAlpha = 0.6;
      octx.beginPath();
      octx.arc(offsetX, offsetY, 20, 0, Math.PI * 2);
      octx.fill();
      octx.restore();
      
      ctx.save();
      ctx.setTransform(currentDpr, 0, 0, currentDpr, 0, 0);
      ctx.fillStyle = 'lime';
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.arc(offsetX, offsetY, 20, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      
      console.log(`[canvas] DEBUG: Drew RED/YELLOW at CALCULATED (${testPoint.x.toFixed(2)}, ${testPoint.y.toFixed(2)})`);
      console.log(`[canvas] DEBUG: Drew LIME at offsetX/Y (${offsetX.toFixed(2)}, ${offsetY.toFixed(2)})`);
      console.log(`[canvas] DEBUG: Difference: (${Math.abs(testPoint.x - offsetX).toFixed(2)}, ${Math.abs(testPoint.y - offsetY).toFixed(2)})`);
    } else {
      console.log(`[canvas] DEBUG: offsetX/offsetY not available, only drew RED/YELLOW at (${testPoint.x.toFixed(2)}, ${testPoint.y.toFixed(2)})`);
    }
    needsRedraw = true; // Trigger redraw to show marker
    
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
    // CRITICAL: Get coordinates BEFORE pointer capture
    // Pointer capture can change event.target, affecting offsetX/offsetY
    const p = canvasPointFromEvent(e);
    // Capture pointer AFTER getting coordinates
    try { (e.target as Element).setPointerCapture?.((e as unknown as PointerEvent).pointerId); } catch {}
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
  
  function moveStroke(e: PointerEvent) {
    if (!isPointerDown || !activeStroke) return;
    const p = canvasPointFromEvent(e);
    
    // Always add every point for maximum smoothness - no filtering
    // More points = smoother curves
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
    
    // Commit the active stroke to the strokes array - preserve local smooth points
    // Create a COMPLETE immutable copy to prevent any modifications
    const committedStrokeId = activeStroke.id;
    
    // MARK AS LOCALLY COMMITTED FIRST - before any operations
    // This prevents any race conditions with server updates
    locallyCommittedStrokes.add(committedStrokeId);
    
    // CRITICAL: Store original coordinates DIRECTLY from activeStroke.points
    // Don't round yet - preserve maximum precision
    // These coordinates are in CSS pixel space and will be rendered correctly with the canvas transform
    // Create a deep copy to ensure no references are shared with activeStroke
    const lockedPoints = activeStroke.points.map(p => ({ 
      x: p.x, // Preserve original precision
      y: p.y, 
      t: p.t 
    }));
    
    // Now round for storage (4 decimal places for sub-pixel accuracy)
    const lockedPointsRounded = lockedPoints.map(p => ({ 
      x: Number(p.x.toFixed(4)), 
      y: Number(p.y.toFixed(4)), 
      t: p.t 
    }));
    
    // Store canvas dimensions at commit time for validation
    const rect = canvas.getBoundingClientRect();
    const commitCanvasWidth = rect.width;
    const commitCanvasHeight = rect.height;
    
    // CRITICAL: Check if canvas resized during drawing
    // If it did, we need to scale coordinates to match the new canvas size
    if (strokeStartCanvasSize) {
      const sizeDiff = Math.abs(rect.width - strokeStartCanvasSize.width) + Math.abs(rect.height - strokeStartCanvasSize.height);
      if (sizeDiff > 1) {
        console.warn(`[canvas] Canvas resized during drawing! Start: ${strokeStartCanvasSize.width.toFixed(2)}x${strokeStartCanvasSize.height.toFixed(2)}, Commit: ${commitCanvasWidth.toFixed(2)}x${commitCanvasHeight.toFixed(2)}. Scaling coordinates.`);
        // Scale coordinates to match new canvas size
        const scaleX = commitCanvasWidth / strokeStartCanvasSize.width;
        const scaleY = commitCanvasHeight / strokeStartCanvasSize.height;
        // Adjust all points to account for canvas resize
        for (let i = 0; i < lockedPointsRounded.length; i++) {
          lockedPointsRounded[i].x = Number((lockedPointsRounded[i].x * scaleX).toFixed(4));
          lockedPointsRounded[i].y = Number((lockedPointsRounded[i].y * scaleY).toFixed(4));
        }
        console.log(`[canvas] Scaled coordinates by ${scaleX.toFixed(4)}x${scaleY.toFixed(4)} to account for resize`);
      }
    }
    strokeStartCanvasSize = null; // Reset for next stroke
    
    // Store coordinates along with canvas dimensions
    // Use rounded version for storage to prevent floating point drift
    committedStrokeCoordinates.set(committedStrokeId, lockedPointsRounded);
    committedStrokeCanvasSize.set(committedStrokeId, { 
      width: commitCanvasWidth, 
      height: commitCanvasHeight 
    });
    
    // ALSO store normalized coordinates (0-1 range) as percentages of canvas size
    // This allows us to recalculate coordinates if canvas resizes
    if (commitCanvasWidth > 0 && commitCanvasHeight > 0) {
      const normalizedPoints = lockedPointsRounded.map(p => ({
        x: p.x / commitCanvasWidth,
        y: p.y / commitCanvasHeight,
        t: p.t
      }));
      committedStrokeNormalizedCoordinates.set(committedStrokeId, normalizedPoints);
    }
    
    // Debug: Log first and last point to verify coordinates are correct
    if (lockedPointsRounded.length > 0) {
      const firstPoint = lockedPointsRounded[0];
      const lastPoint = lockedPointsRounded[lockedPointsRounded.length - 1];
      const originalFirstPoint = activeStroke.points[0];
      console.log(`[canvas] Committed stroke ${committedStrokeId.substring(0, 16)}...:`);
      console.log(`  - activeStroke.points[0] BEFORE commit: (${originalFirstPoint.x.toFixed(4)}, ${originalFirstPoint.y.toFixed(4)})`);
      console.log(`  - lockedPoints[0] (before rounding): (${lockedPoints[0].x.toFixed(4)}, ${lockedPoints[0].y.toFixed(4)})`);
      console.log(`  - lockedPointsRounded[0] (after rounding): (${firstPoint.x.toFixed(4)}, ${firstPoint.y.toFixed(4)})`);
      console.log(`  - Stored in Map: (${firstPoint.x.toFixed(4)}, ${firstPoint.y.toFixed(4)})`);
      console.log(`  - Canvas size: ${commitCanvasWidth.toFixed(2)}x${commitCanvasHeight.toFixed(2)}`);
      
      // Check if coordinates match at each step
      const diff1 = Math.abs(lockedPoints[0].x - originalFirstPoint.x) + Math.abs(lockedPoints[0].y - originalFirstPoint.y);
      const diff2 = Math.abs(firstPoint.x - lockedPoints[0].x) + Math.abs(firstPoint.y - lockedPoints[0].y);
      if (diff1 > 0.01) {
        console.error(`[canvas] MISMATCH: activeStroke.points[0] vs lockedPoints[0]: diff=${diff1.toFixed(4)}`);
      }
      if (diff2 > 0.01) {
        console.error(`[canvas] MISMATCH: lockedPoints[0] vs lockedPointsRounded[0]: diff=${diff2.toFixed(4)}`);
      }
      
      // Visual verification: Draw a red circle at the stored first point AFTER redraw
      // This helps verify that stored coordinates render correctly
      setTimeout(() => {
        const currentDpr = Math.max(window.devicePixelRatio || 1, 1);
        ctx.save();
        ctx.setTransform(currentDpr, 0, 0, currentDpr, 0, 0);
        ctx.fillStyle = 'red';
        ctx.globalAlpha = 0.9;
        ctx.beginPath();
        ctx.arc(firstPoint.x, firstPoint.y, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        console.log(`[canvas] Drew RED marker at STORED first point (${firstPoint.x.toFixed(2)}, ${firstPoint.y.toFixed(2)}) - this should match where stroke starts`);
      }, 100);
    }
    
    // CRITICAL: Verify coordinates immediately after storing
    // This helps catch any issues with coordinate storage
    setTimeout(() => {
      const stored = committedStrokeCoordinates.get(committedStrokeId);
      const storedSize = committedStrokeCanvasSize.get(committedStrokeId);
      if (stored && stored.length > 0 && storedSize) {
        const currentRect = canvas.getBoundingClientRect();
        if (Math.abs(currentRect.width - storedSize.width) > 1 || Math.abs(currentRect.height - storedSize.height) > 1) {
          console.warn(`[canvas] Canvas resized after commit! Stroke ${committedStrokeId} was committed at ${storedSize.width}x${storedSize.height}, but canvas is now ${currentRect.width.toFixed(2)}x${currentRect.height.toFixed(2)}`);
        }
      }
    }, 100);
    
    // Create stroke object with locked coordinates (use rounded version for consistency)
    const strokeToCommit: StrokeOp = {
      id: activeStroke.id,
      userId: activeStroke.userId,
      type: 'stroke',
      mode: activeStroke.mode,
      color: activeStroke.color,
      width: activeStroke.width,
      points: lockedPointsRounded.map(p => ({ x: p.x, y: p.y, t: p.t })), // Use locked rounded coordinates
      timestamp: activeStroke.timestamp,
    };
    if ((activeStroke as any).serverTimestamp) {
      (strokeToCommit as any).serverTimestamp = (activeStroke as any).serverTimestamp;
    }
    
    // Store a reference to the exact coordinates for verification
    (strokeToCommit as any).__localCommit = true;
    (strokeToCommit as any).__originalPoints = lockedPointsRounded.map(p => ({ x: p.x, y: p.y }));
    
    // Remove any existing stroke with this ID and add our committed version
    // This ensures we're not updating a reference that might be modified
    // CRITICAL: Use the exact coordinates from activeStroke - don't let anything modify them
    
    // First, clear activeStroke to prevent any interference
    const savedActiveStroke = activeStroke;
    activeStroke = null;
    
    const existingIndex = strokes.findIndex(s => s.id === committedStrokeId);
    if (existingIndex >= 0) {
      // Replace completely - don't modify existing object
      // This ensures the committed stroke has the exact coordinates that were drawn
      strokes[existingIndex] = strokeToCommit;
    } else {
      // Add new stroke with exact coordinates from where it was drawn
      strokes.push(strokeToCommit);
    }
    
    // CRITICAL: Before sorting, ensure the stroke object in the array has the correct coordinates
    // This prevents any drift during sorting or other operations
    const finalIndex = strokes.findIndex(s => s.id === committedStrokeId);
    if (finalIndex >= 0) {
      const stored = committedStrokeCoordinates.get(committedStrokeId);
      if (stored) {
        strokes[finalIndex].points = stored.map(p => ({ x: p.x, y: p.y, t: p.t }));
      }
    }
    
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
    
    // CRITICAL: After sorting, restore coordinates again in case sorting moved objects
    // Find the stroke again (it might be at a different index after sorting)
    const afterSortIndex = strokes.findIndex(s => s.id === committedStrokeId);
    if (afterSortIndex >= 0) {
      const stored = committedStrokeCoordinates.get(committedStrokeId);
      if (stored) {
        const beforeRestore = strokes[afterSortIndex].points[0];
        strokes[afterSortIndex].points = stored.map(p => ({ x: p.x, y: p.y, t: p.t }));
        const afterRestore = strokes[afterSortIndex].points[0];
        console.log(`[canvas] After sorting - restored coordinates for stroke ${committedStrokeId.substring(0, 16)}:`);
        console.log(`  - Before restore: (${beforeRestore?.x.toFixed(2) || 'N/A'}, ${beforeRestore?.y.toFixed(2) || 'N/A'})`);
        console.log(`  - Stored in Map: (${stored[0].x.toFixed(2)}, ${stored[0].y.toFixed(2)})`);
        console.log(`  - After restore: (${afterRestore.x.toFixed(2)}, ${afterRestore.y.toFixed(2)})`);
        console.log(`  - Index: ${afterSortIndex}`);
      } else {
        console.error(`[canvas] ERROR: After sorting, stroke ${committedStrokeId.substring(0, 16)} has NO stored coordinates in Map!`);
      }
    } else {
      console.error(`[canvas] ERROR: After sorting, stroke ${committedStrokeId.substring(0, 16)} not found in strokes array!`);
    }
    
    // CRITICAL: Before redrawing, verify the stroke object has correct coordinates
    const verifyStroke = strokes.find(s => s.id === committedStrokeId);
    if (verifyStroke && lockedPointsRounded.length > 0) {
      const storedFirst = lockedPointsRounded[0];
      const strokeFirst = verifyStroke.points[0];
      if (strokeFirst && (Math.abs(strokeFirst.x - storedFirst.x) > 0.01 || Math.abs(strokeFirst.y - storedFirst.y) > 0.01)) {
        console.warn(`[canvas] Stroke object coordinates don't match stored coordinates before redraw! Fixing...`);
        verifyStroke.points = lockedPointsRounded.map(p => ({ x: p.x, y: p.y, t: p.t }));
      }
    }
    
    // Redraw immediately with committed stroke
    // The drawStroke function will automatically use stored coordinates from the Map
    redrawAll();
    
    // Send end to server after committing locally
    network.sendStrokeEnd(committedStrokeId);
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
    
    // CRITICAL: Always ensure transform is correct before rendering
    // This ensures coordinates are rendered at the correct positions
    const currentDpr = Math.max(window.devicePixelRatio || 1, 1);
    ctx.setTransform(currentDpr, 0, 0, currentDpr, 0, 0);
    
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
      // Always apply smoothing for smooth, accurate curves
      if (isActivelyDrawing && activeStroke && !activeStroke.isDeleted && activeStroke.points.length > 0) {
        // Always apply smoothing for smooth, accurate curves
        drawStroke(ctx, activeStroke, true);
      }
      if (activeShape) {
        drawShape(ctx, activeShape);
      }
      
      // DEBUG: Draw green marker at first point of active stroke if drawing
      // This helps verify coordinates are correct during drawing
      if (isActivelyDrawing && activeStroke && activeStroke.points.length > 0) {
        const firstPoint = activeStroke.points[0];
        ctx.save();
        const currentDpr = Math.max(window.devicePixelRatio || 1, 1);
        ctx.setTransform(currentDpr, 0, 0, currentDpr, 0, 0);
        ctx.fillStyle = 'lime';
        ctx.globalAlpha = 0.8;
        ctx.beginPath();
        ctx.arc(firstPoint.x, firstPoint.y, 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
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


