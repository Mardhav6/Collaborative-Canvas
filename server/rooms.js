const { createDrawingState } = require('./state');

function createRooms() {
  const rooms = new Map();
  function ensure(name) {
    if (!rooms.has(name)) {
      rooms.set(name, {
        name,
        users: new Map(), // socketId -> { id, color }
        state: createDrawingState(),
        addUser(u) { this.users.set(u.socketId, u); },
        removeUser(socketId) { this.users.delete(socketId); },
        getPresence() {
          return Array.from(this.users.values()).map(u => ({ id: u.id, color: u.color }));
        },
      });
    }
    return rooms.get(name);
  }
  return { get: ensure };
}

module.exports = { createRooms };


