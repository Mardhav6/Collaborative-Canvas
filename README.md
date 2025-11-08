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

## 🚀 Quick Start

### Prerequisites

- Node.js 18+ and npm

### Installation

```bash
# Clone the repository
git clone https://github.com/Mardhav6/Collaborative-Canvas.git
cd Collaborative-Canvas

# Install dependencies
npm install
```

### Development

```bash
# Start development server with hot reload
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

### Testing with Multiple Users

1. Start the server: `npm start`
2. Open multiple browser windows/tabs to `http://localhost:3001`
3. Use different rooms: `http://localhost:3001/?room=test` (each room has its own canvas)
4. Draw overlapping strokes with different colors to see real-time sync
5. Enable "Show render order" in the sidebar to see conflict resolution

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

## 🛠️ Technical Details

### Architecture

- **Client**: Vanilla TypeScript compiled with esbuild
- **Server**: Node.js + Express + Socket.IO
- **Canvas**: HTML5 Canvas API with high-DPI support
- **Real-time**: WebSocket-based bidirectional communication
- **Storage**: JSON file-based persistence (can be extended to database)

### Key Features Implementation

- **Coordinate System**: CSS pixel coordinates with Device Pixel Ratio (DPR) scaling for high-DPI displays
- **Smooth Drawing**: Quadratic curve interpolation for smooth stroke rendering
- **Conflict Resolution**: Deterministic timestamp-based sorting for consistent rendering order
- **State Synchronization**: Optimistic local updates with server reconciliation
- **Performance**: Offscreen canvas rendering with 60fps refresh rate

### Coordinate System Fix

The application uses a precise coordinate calculation system:
- Coordinates are calculated in CSS pixel space relative to the canvas element
- Device Pixel Ratio (DPR) is applied via canvas transform for high-DPI displays
- Transform is correctly handled when blitting offscreen canvas to main canvas
- Coordinates are stored with 4 decimal precision for accuracy

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

## 🐛 Known Limitations

- Global undo/redo is linear and affects the most recent visible operation (no per-user undo)
- Long sessions can accumulate many strokes; consider implementing compaction
- Eraser uses `destination-out` blending; subtle differences may appear across browsers
- No authentication; user identity is ephemeral per session
- Canvas state is stored in JSON files; for production, consider using a database

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
