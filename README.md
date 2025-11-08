# Collaborative Canvas

A real-time collaborative drawing canvas built with vanilla TypeScript/JavaScript, HTML5 Canvas, Node.js, and Socket.IO. Multiple users can draw together simultaneously with real-time synchronization, presence cursors, and global undo/redo functionality.

## ✨ Features

- **Real-time Collaboration**: Multiple users can draw simultaneously with instant synchronization
- **Brush & Eraser Tools**: Smooth drawing with customizable colors and stroke widths
- **Presence Indicators**: See other users' cursors and online status in real-time
- **Room Support**: Create separate drawing rooms via URL parameter (`?room=roomname`)
- **Global Undo/Redo**: Undo/redo the last operation regardless of who created it
- **Smooth Drawing**: High-performance rendering with 60fps smooth curves
- **Live Metrics**: View latency and FPS in real-time
- **Responsive Design**: Works on desktop and mobile devices
- **Persistent Storage**: Canvas state is saved and restored on server restart

## 🚀 Setup Instructions

### Prerequisites

- Node.js 18+ and npm

### Quick Start

```bash
# Clone the repository
git clone https://github.com/Mardhav6/Collaborative-Canvas.git
cd Collaborative-Canvas

# Install dependencies
npm install

# Start the server
npm start
```

The server will start on `http://localhost:3001`. Open your browser and navigate to that URL to start drawing!

### Development Mode

For development with hot reload:

```bash
# Start development server with auto-rebuild
npm run dev
```

This will:
- Start the server on `http://localhost:3001`
- Watch for client-side changes and rebuild automatically
- Restart the server on changes

### Production Build

```bash
# Build the client bundle
npm run build

# Start the production server
npm start
```

## 🧪 How to Test with Multiple Users

Testing with multiple users is straightforward:

1. **Start the server**: Run `npm start` in the project directory
2. **Open multiple browser windows/tabs**: Navigate to `http://localhost:3001` in each window
3. **Use different rooms** (optional): Add `?room=test` to the URL to create separate drawing rooms
   - Example: `http://localhost:3001/?room=test`
   - Each room has its own independent canvas
4. **Draw simultaneously**: 
   - Draw overlapping strokes with different colors to see real-time sync
   - Watch as strokes appear on all connected clients in real-time
   - Observe presence indicators showing other users' cursors
5. **Test conflict resolution**: 
   - Enable "Show render order" in the sidebar to see how strokes are ordered
   - Draw overlapping strokes simultaneously from different clients
   - Notice how strokes are consistently ordered across all clients
6. **Test global operations**:
   - Use undo/redo buttons to test global undo/redo functionality
   - Use clear button to test global clear functionality
   - Verify that operations sync across all connected clients

### Testing Tips

- **Latency Testing**: Check the latency display in the sidebar to monitor connection quality
- **FPS Monitoring**: Monitor FPS to ensure smooth rendering (should be ~60fps)
- **Room Isolation**: Test that different rooms maintain separate canvas states
- **Reconnection**: Disconnect and reconnect to test state restoration

## 🐛 Known Limitations & Bugs

### Limitations

1. **Global Undo/Redo**: 
   - Undo/redo is linear and affects the most recent visible operation
   - No per-user undo/redo support
   - Undo/redo affects all users in the room simultaneously

2. **State Management**:
   - Long sessions can accumulate many strokes, potentially impacting performance
   - No automatic state compaction or stroke merging
   - Consider implementing periodic cleanup for very long sessions

3. **Eraser Behavior**:
   - Eraser uses `destination-out` blending mode
   - Subtle visual differences may appear across different browsers
   - Eraser affects all underlying strokes regardless of order

4. **Authentication**:
   - No user authentication system
   - User identity is ephemeral per session (UUID-based)
   - Users are identified only by their session ID

5. **Persistence**:
   - Canvas state is stored in JSON files on the server
   - For production use, consider implementing database storage
   - State is loaded on server restart but may be lost if server crashes

6. **Network**:
   - No offline support or local caching
   - Requires persistent WebSocket connection
   - Reconnection may cause brief state sync delays

### Known Bugs

1. **Coordinate Precision**: 
   - Fixed: Coordinate calculation now uses CSS pixel space with Device Pixel Ratio (DPR) scaling
   - Coordinates are stored with 4 decimal precision for accuracy

2. **Canvas Resizing**:
   - Canvas resize during active drawing may cause slight coordinate shifts
   - Stroke coordinates are captured at stroke start to minimize issues

3. **Browser Compatibility**:
   - Tested on Chrome, Firefox, Safari, and Edge
   - Some older browsers may have performance issues
   - Mobile browsers may have touch event handling differences

## ⏱️ Time Spent on Project

### Development Timeline

- **Core Infrastructure** (~4 hours):
  - Project setup and scaffolding
  - Client/server architecture with Socket.IO
  - Basic WebSocket communication protocol
  - Room management system

- **Drawing Pipeline** (~6 hours):
  - Canvas rendering system with HTML5 Canvas API
  - Brush and eraser tool implementation
  - Smooth stroke rendering with quadratic curves
  - Coordinate system with Device Pixel Ratio (DPR) support
  - Real-time stroke streaming at ~60Hz

- **Collaboration Features** (~4 hours):
  - Real-time synchronization between clients
  - Presence indicators and cursor tracking
  - Conflict resolution with timestamp-based ordering
  - State synchronization and reconciliation

- **Global Operations** (~2 hours):
  - Global undo/redo implementation
  - Global clear functionality
  - State replacement and convergence
  - Server-side state management

- **Performance Optimization** (~3 hours):
  - Offscreen canvas rendering for performance
  - Render loop optimization (60fps)
  - Point streaming and throttling
  - Smooth curve interpolation algorithms
  - Coordinate system fixes and optimizations

- **UI/UX** (~2 hours):
  - Modern sidebar interface design
  - Tool selection and color picker
  - Live metrics display (latency, FPS)
  - Debug overlay for render order
  - Responsive design for mobile devices

- **Deployment & Fixes** (~3 hours):
  - Render deployment configuration
  - Vercel deployment setup
  - Environment variable configuration
  - Coordinate system debugging and fixes
  - Build system configuration

- **Documentation** (~1 hour):
  - README.md documentation
  - ARCHITECTURE.md documentation
  - Code comments and explanations

**Total Time: ~25 hours**

### Key Challenges Overcome

1. **Coordinate System**: Spent significant time debugging coordinate calculation issues with high-DPI displays and canvas transforms
2. **Real-time Sync**: Implemented robust conflict resolution for simultaneous drawing
3. **Performance**: Optimized rendering pipeline for smooth 60fps drawing
4. **State Management**: Developed reliable state synchronization between clients and server

## 🌐 Deployment

### Backend (Render)

The server is deployed on Render using the `render.yaml` configuration:

1. Connect your GitHub repository to Render
2. Render will automatically detect the `render.yaml` file
3. The server will be deployed as a web service
4. The backend URL will be something like: `https://collaborative-canvas-server-8lyl.onrender.com`

### Frontend (Vercel)

The client is deployed on Vercel:

1. Connect your GitHub repository to Vercel
2. Configure build settings:
   - Build Command: `npm run build`
   - Output Directory: `client/dist` (or as configured in `vercel.json`)
   - Install Command: `npm install`
3. Set environment variables:
   - `SERVER_URL`: Your Render backend URL (e.g., `https://collaborative-canvas-server-8lyl.onrender.com`)
4. Deploy

### Environment Variables

**Vercel (Frontend):**
- `SERVER_URL`: Backend server URL (required for production)

**Render (Backend):**
- No environment variables required (uses default configuration)

## 📁 Project Structure

```
Collaborative Canvas/
├── client/                 # Client-side application
│   ├── dist/              # Built client bundle
│   ├── modules/           # TypeScript modules
│   │   ├── canvas.ts      # Canvas drawing logic
│   │   └── websocket.ts   # WebSocket client
│   ├── index.html         # Main HTML file
│   ├── main.ts            # Client entry point
│   └── style.css          # Stylesheet
├── server/                # Server-side application
│   ├── server.js          # Express + Socket.IO server
│   ├── rooms.js           # Room management
│   └── state.js           # State management
├── scripts/               # Build scripts
│   └── build.js           # Client build script
├── data/                  # Persistent storage
│   └── lobby.json         # Room state data
├── render.yaml            # Render deployment config
├── vercel.json            # Vercel deployment config
└── package.json           # Dependencies and scripts
```

## 📝 Scripts

- `npm start` - Start the production server (uses prebuilt bundle)
- `npm run build` - Build the client bundle for production
- `npm run build:client` - Build the client bundle (alias for `npm run build`)
- `npm run dev` - Start development server with hot reload

## 🔧 Configuration

### Room Configuration

Rooms are created automatically when accessed. Use the `?room=` URL parameter to specify a room name:
- Default room: `lobby`
- Custom room: `?room=myroom`

### Server Configuration

The server listens on port 3001 by default. Change this in `server/server.js` if needed.

### Client Configuration

The client can connect to different servers:
1. URL parameter: `?server=https://your-server.com`
2. Build-time injection: Set `SERVER_URL` environment variable during build
3. Runtime global: Set `window.SERVER_URL` in the HTML
4. Default: Same origin as the client

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📄 License

This project is open source and available under the MIT License.

## 🙏 Acknowledgments

- Built with [Socket.IO](https://socket.io/) for real-time communication
- Styled with modern CSS and [Inter font](https://rsms.me/inter/)
- Deployed on [Render](https://render.com/) and [Vercel](https://vercel.com/)

## 📞 Support

For issues or questions, please open an issue on the GitHub repository.

---

**Happy Drawing! 🎨**
