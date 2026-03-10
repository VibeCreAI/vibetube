# VibeTube Dev Run (Windows)

Use two terminals: one for backend API, one for frontend web UI.

## 1) Backend API (Terminal A)

```powershell
cd C:\Users\samso\OneDrive\Desktop\Vibe\Web\VibeTube
.\.venv\Scripts\python.exe -m uvicorn backend.main:app --host 127.0.0.1 --port 17493 --reload
```

Health check:

```powershell
curl http://127.0.0.1:17493/health
```

## 2) Frontend Web Dev Server (Terminal B)

```powershell
cd C:\Users\samso\OneDrive\Desktop\Vibe\Web\VibeTube
bun run dev:web -- --host 127.0.0.1
bun run dev
```

Open in browser:

- `http://127.0.0.1:5173`
- or `http://localhost:5173` (if your browser resolves localhost correctly)

## 3) Recommended Start Order

1. Start backend first.
2. Start frontend second.
3. Hard refresh browser if UI was already open.

## 4) Quick Troubleshooting

- `ERR_CONNECTION_REFUSED` to `17493`:
  - backend is not running, or wrong port.
- Frontend not loading on `5173`:
  - start Terminal B command again.
- If `localhost:5173` fails but `127.0.0.1:5173` works:
  - use `127.0.0.1` consistently.

## 5) Stop Servers

In each terminal, press `Ctrl + C`.
