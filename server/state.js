function createDrawingState() {
  /** @type {Array<any>} */
  const ops = [];
  /** @type {Array<string>} */
  const redoStack = [];

  function appendOp(op) {
    // Add server timestamp for conflict resolution
    const strokeWithTimestamp = {
      ...op,
      isDeleted: false,
      serverTimestamp: Date.now(),
      // Use client timestamp if available, otherwise server timestamp
      timestamp: op.timestamp || Date.now()
    };
    ops.push(strokeWithTimestamp);
    redoStack.length = 0; // new op invalidates redo
    
    // Sort by timestamp to ensure consistent ordering across clients
    // This handles conflicts when multiple users draw simultaneously
    ops.sort((a, b) => {
      // Primary sort: timestamp (earlier = drawn first)
      if (a.timestamp !== b.timestamp) {
        return a.timestamp - b.timestamp;
      }
      // Secondary sort: server timestamp (earlier server receipt = drawn first)
      if (a.serverTimestamp !== b.serverTimestamp) {
        return a.serverTimestamp - b.serverTimestamp;
      }
      // Tertiary sort: user ID for complete determinism
      return a.userId.localeCompare(b.userId);
    });
  }

  function patchPoints(id, points) {
    const s = ops.find(o => o.id === id);
    if (s) s.points = points;
  }

  function globalUndo() {
    for (let i = ops.length - 1; i >= 0; i--) {
      if (!ops[i].isDeleted) {
        ops[i].isDeleted = true;
        redoStack.push(ops[i].id);
        break;
      }
    }
  }

  function globalRedo() {
    const id = redoStack.pop();
    if (!id) return;
    const s = ops.find(o => o.id === id);
    if (s) s.isDeleted = false;
  }

  function clear() {
    ops.length = 0;
    redoStack.length = 0;
  }

  return {
    ops,
    appendOp,
    patchPoints,
    globalUndo,
    globalRedo,
    clear,
  };
}

module.exports = { createDrawingState };


