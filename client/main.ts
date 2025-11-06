import { createCanvasController } from './modules/canvas';
import { createSocketClient } from './modules/websocket';

type Tool = 'brush' | 'eraser';

function fitCanvasToContainer(canvas: HTMLCanvasElement) {
  const dpr = Math.max(window.devicePixelRatio || 1, 1);
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.floor(rect.width * dpr);
  canvas.height = Math.floor(rect.height * dpr);
  const ctx = canvas.getContext('2d');
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function setupUI() {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const toolBrush = document.getElementById('tool-brush') as HTMLButtonElement;
  const toolEraser = document.getElementById('tool-eraser') as HTMLButtonElement;
  const toolRect = document.getElementById('tool-rect') as HTMLButtonElement;
  const toolCircle = document.getElementById('tool-circle') as HTMLButtonElement;
  const toolText = document.getElementById('tool-text') as HTMLButtonElement;
  const toolImage = document.getElementById('tool-image') as HTMLButtonElement;
  const colorPicker = document.getElementById('color-picker') as HTMLInputElement;
  const strokeRange = document.getElementById('stroke-range') as HTMLInputElement;
  const undoBtn = document.getElementById('undo-btn') as HTMLButtonElement;
  const redoBtn = document.getElementById('redo-btn') as HTMLButtonElement;
  const clearBtn = document.getElementById('clear-btn') as HTMLButtonElement;
  const saveBtn = document.getElementById('save-btn') as HTMLButtonElement;
  const loadBtn = document.getElementById('load-btn') as HTMLButtonElement;
  const userList = document.getElementById('user-list') as HTMLUListElement;
  const latencyEl = document.getElementById('latency') as HTMLSpanElement;
  const fpsEl = document.getElementById('fps') as HTMLSpanElement;
  const debugRenderOrderEl = document.getElementById('debug-render-order') as HTMLInputElement;

  // Layout sizing
  let isDrawingNow = false;
  function sizeStage() {
    const stage = document.getElementById('stage') as HTMLElement;
    const sidebar = document.getElementById('sidebar') as HTMLElement;
    stage.style.height = `${window.innerHeight}px`;
    // Avoid resizing canvas while drawing to prevent stroke shift
    if (!isDrawingNow) {
      fitCanvasToContainer(canvas);
      controller.redrawAll();
    }
  }

  let currentTool: Tool = 'brush';
  function setActiveTool(tool: Tool) {
    currentTool = tool;
    toolBrush.classList.toggle('active', tool === 'brush');
    toolEraser.classList.toggle('active', tool === 'eraser');
    if (toolRect) toolRect.classList.toggle('active', tool === 'rect');
    if (toolCircle) toolCircle.classList.toggle('active', tool === 'circle');
    if (toolText) toolText.classList.toggle('active', tool === 'text');
    if (toolImage) toolImage.classList.toggle('active', tool === 'image');
    const cursors: Record<string, string> = {
      brush: 'crosshair', eraser: 'grab', rect: 'crosshair', circle: 'crosshair', text: 'text', image: 'crosshair'
    } as const;
    canvas.style.cursor = (cursors as any)[tool] || 'crosshair';
    controller.setTool(tool);
  }

  const room = (new URLSearchParams(location.search)).get('room') || 'lobby';
  const roomNameEl = document.getElementById('room-name') as HTMLSpanElement;
  const userCountEl = document.getElementById('user-count') as HTMLSpanElement;
  const colorValueEl = document.getElementById('color-value') as HTMLSpanElement;
  const strokeValueEl = document.getElementById('stroke-value') as HTMLSpanElement;
  
  roomNameEl.textContent = room;
  
  const qs = new URLSearchParams(location.search);
  const serverOverride = qs.get('server');
  // Prefer URL param, then build-time define, then a runtime global, then same-origin
  // SERVICE_SERVER_URL can be injected at build time via esbuild --define
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const runtimeServer = (window as any).SERVER_URL as string | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buildTimeServer = (typeof (globalThis as any).SERVICE_SERVER_URL !== 'undefined' ? (globalThis as any).SERVICE_SERVER_URL : undefined) as string | undefined;
  const serverUrl = serverOverride || buildTimeServer || runtimeServer || location.origin;
  let controller: ReturnType<typeof createCanvasController>;
  
  console.log('[client] serverUrl', serverUrl, 'room', room);
  const client = createSocketClient(serverUrl, room, {
    onPresence(users) {
      console.log('[client] onPresence ->', users.length);
      userList.innerHTML = '';
      userCountEl.textContent = users.length.toString();
      
      // Generate friendly names for users (consistent numbering)
      const userNames = new Map<string, string>();
      users.forEach((u, index) => {
        const friendlyName = u.name || `User ${index + 1}`;
        userNames.set(u.id, friendlyName);
      });
      
      // Update canvas with user info including generated names
      if (controller) {
        const usersWithNames = users.map(u => ({
          id: u.id,
          color: u.color,
          name: userNames.get(u.id) || undefined
        }));
        controller.updateUserInfo(usersWithNames);
      }
      
      for (const u of users) {
        const li = document.createElement('li');
        const dot = document.createElement('span');
        dot.className = 'dot';
        dot.style.background = u.color;
        dot.style.boxShadow = `0 0 0 2px ${u.color}20, 0 0 8px ${u.color}40`;
        
        const nameSpan = document.createElement('span');
        nameSpan.textContent = userNames.get(u.id) || u.id.slice(0, 8);
        nameSpan.style.fontWeight = '500';
        
        const colorSpan = document.createElement('span');
        colorSpan.textContent = u.color;
        colorSpan.style.fontSize = '11px';
        colorSpan.style.color = 'var(--text-tertiary)';
        colorSpan.style.fontFamily = 'Monaco, Menlo, monospace';
        colorSpan.style.marginLeft = 'auto';
        
        li.append(dot, nameSpan, colorSpan);
        userList.appendChild(li);
      }
    },
    onLatency(ms) { 
      if (ms < 0) {
        latencyEl.textContent = '--';
      } else {
        latencyEl.textContent = `${Math.round(ms)}ms`;
      }
    },
    onFps(fps) { 
      if (fps > 0) {
        fpsEl.textContent = Math.round(fps).toString();
      } else {
        fpsEl.textContent = '--';
      }
    },
  });

  controller = createCanvasController({
    canvas,
    getColor: () => colorPicker.value,
    getStrokeWidth: () => parseInt(strokeRange.value, 10),
    getTool: () => currentTool,
    network: client,
  });

  // UI bindings
  toolBrush.onclick = () => setActiveTool('brush');
  toolEraser.onclick = () => setActiveTool('eraser');
  if (toolRect) toolRect.onclick = () => setActiveTool('rect');
  if (toolCircle) toolCircle.onclick = () => setActiveTool('circle');
  if (toolText) toolText.onclick = () => setActiveTool('text');
  if (toolImage) toolImage.onclick = () => setActiveTool('image');
  undoBtn.onclick = () => client.sendUndo();
  redoBtn.onclick = () => client.sendRedo();
  clearBtn.onclick = () => {
    if (confirm('Clear the entire canvas? This action cannot be undone.')) {
      client.sendClear();
    }
  };

  // Persistence actions
  saveBtn.onclick = async () => {
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(room)}/save`, { method: 'POST' });
      if (!res.ok) throw new Error('Save failed');
      alert('Saved room state to disk.');
    } catch (e) {
      alert('Failed to save.');
    }
  };
  loadBtn.onclick = async () => {
    if (!confirm('Load saved state for this room? This replaces the current canvas for everyone in the room.')) return;
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(room)}/load`, { method: 'POST' });
      if (!res.ok) throw new Error('Load failed');
      // Server will broadcast state:replace to everyone
    } catch (e) {
      alert('Failed to load. Make sure a save exists.');
    }
  };
  
  // Update color value display
  colorPicker.addEventListener('input', () => {
    colorValueEl.textContent = colorPicker.value.toUpperCase();
  });
  
  // Update stroke value display
  strokeRange.addEventListener('input', () => {
    strokeValueEl.textContent = `${strokeRange.value}px`;
  });

  // Debug: render order toggle (sync across room)
  if (debugRenderOrderEl) {
    debugRenderOrderEl.addEventListener('change', () => {
      controller.setDebugRenderOrder(debugRenderOrderEl.checked);
      controller.redrawAll();
      client.sendDebugRenderOrder(debugRenderOrderEl.checked);
    });
  }

  // Listen for room-wide debug toggle and reflect in UI
  client.onDebugRenderOrder((enabled) => {
    controller.setDebugRenderOrder(enabled);
    controller.redrawAll();
    if (debugRenderOrderEl) {
      debugRenderOrderEl.checked = enabled;
    }
  });

  document.addEventListener('keydown', (e) => {
    const z = e.key.toLowerCase() === 'z';
    const y = e.key.toLowerCase() === 'y';
    if ((e.ctrlKey || e.metaKey) && z) { e.preventDefault(); client.sendUndo(); }
    if ((e.ctrlKey || e.metaKey) && y) { e.preventDefault(); client.sendRedo(); }
  });

  window.addEventListener('resize', sizeStage);
  // Track drawing state locally to pause resize while drawing
  canvas.addEventListener('pointerdown', () => { isDrawingNow = true; }, { passive: true });
  const endDraw = () => { isDrawingNow = false; sizeStage(); };
  canvas.addEventListener('pointerup', endDraw, { passive: true });
  canvas.addEventListener('pointerleave', endDraw, { passive: true });
  sizeStage();
  setActiveTool('brush');
}

document.addEventListener('DOMContentLoaded', setupUI);


