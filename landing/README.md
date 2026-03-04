# VibeTube Landing Page

Landing page for VibeTube.sh - a modern Next.js 16 application.

## Tech Stack

- **Next.js 16** with App Router
- **Bun** for package management
- **Tailwind CSS** with shadcn/ui components
- **TypeScript** with strict mode
- **Railway** deployment ready

## Getting Started

### Prerequisites

- Bun installed ([bun.sh](https://bun.sh))

### Installation

```bash
cd landing
bun install
```

### Development

```bash
bun run dev
```

Open [http://localhost:3000](http://localhost:3000) to view the landing page.

### Build

```bash
bun run build
```

### Production

```bash
bun run start
```

## Configuration

### Update Download Links

Edit `src/lib/constants.ts` to update:
- `LATEST_VERSION` - Current release version
- `DOWNLOAD_LINKS` - GitHub release download URLs
- `GITHUB_REPO` - Repository URL

### Update GitHub Username

Replace `USERNAME` in `src/lib/constants.ts` with your actual GitHub username.

## Deployment to Railway

1. Connect your GitHub repository to Railway
2. Railway will auto-detect `nixpacks.toml`
3. Set root directory to `landing/`
4. Railway will automatically:
   - Install dependencies with `bun install`
   - Build with `bun run build`
   - Start with `bun run start`
5. Configure custom domain `VibeTube.sh` in Railway settings

## Project Structure

```
landing/
â”œâ”€â”€ src/
â”‚   â”œâ”€â”€ app/
â”‚   â”‚   â”œâ”€â”€ layout.tsx      # Root layout with metadata
â”‚   â”‚   â”œâ”€â”€ page.tsx        # Landing page
â”‚   â”‚   â””â”€â”€ globals.css     # Global styles
â”‚   â”œâ”€â”€ components/
â”‚   â”‚   â”œâ”€â”€ Header.tsx      # Top navigation
â”‚   â”‚   â”œâ”€â”€ Footer.tsx      # Footer
â”‚   â”‚   â”œâ”€â”€ DownloadSection.tsx  # Download buttons
â”‚   â”‚   â””â”€â”€ ui/             # shadcn/ui components
â”‚   â””â”€â”€ lib/
â”‚       â”œâ”€â”€ utils.ts        # Utility functions
â”‚       â””â”€â”€ constants.ts    # App constants
â”œâ”€â”€ public/
â”‚   â””â”€â”€ VibeTube-logo.png   # Logo asset
â””â”€â”€ nixpacks.toml          # Railway deployment config
```

## Features

- Responsive design (mobile-first)
- Dark mode by default
- SEO optimized metadata
- Download links for Mac, Windows, Linux
- Feature showcase
- Platform highlights
- GitHub integration
