# Tesla Dashcam Viewer (Tauri)

Offline Tesla dashcam viewer with:
- Event scanning from TeslaCam folders
- Synced multi-camera playback (main + side previews)
- Native metadata extraction (GPS/creation time via `ffprobe`)
- Single-file MP4 export (layout compositor via `ffmpeg`)

## Current status

The project is scaffolded for Tauri, but this machine is currently missing Rust/Cargo so Tauri commands cannot run yet.

## Prerequisites (Windows)

1. Install Rust (Cargo + rustc):
   - https://rustup.rs/
2. Install FFmpeg (must provide `ffmpeg` and `ffprobe` on PATH):
   - https://ffmpeg.org/download.html
3. Node.js 18+ (already present)

## Install dependencies

```powershell
npm install
```

## Run in dev mode

```powershell
npm run tauri:dev
```

## Build desktop app

```powershell
npm run tauri:build
```

## Project structure

- `index.html`, `styles.css`, `app.js`: UI and playback logic
- `src-tauri/src/main.rs`: native commands
  - `scan_teslacam(root_path)`
  - `read_clip_metadata(clip_path)`
  - `export_event_mp4(request)`
- `src-tauri/tauri.conf.json`: Tauri config

## Notes

- App is designed offline-only.
- Export layout: one main camera (1280x720) + up to 3 preview cameras stacked on the right.
- Frontend still supports browser folder loading, but native path scanning/metadata/export require running inside Tauri.
