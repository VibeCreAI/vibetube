# VibeTube Documentation

This directory contains the documentation for VibeTube, built with [Mintlify](https://mintlify.com).

## Development

### Prerequisites

Install Mintlify globally using bun:

```bash
bun add -g mintlify
```

Or use the helper script:

```bash
bun run install:mintlify
```

### Running Locally

```bash
bun run dev
```

This will start the Mintlify dev server.

The docs will be available at `http://localhost:3000`

### Structure

```
docs/
â”œâ”€â”€ mint.json           # Mintlify configuration
â”œâ”€â”€ custom.css          # Custom styles
â”œâ”€â”€ overview/           # Getting started & feature docs
â”œâ”€â”€ guides/             # User guides
â”œâ”€â”€ api/                # API reference
â”œâ”€â”€ development/        # Developer documentation
â”œâ”€â”€ logo/               # Logo assets
â””â”€â”€ public/             # Static assets
```

### Writing Docs

- Use `.mdx` files for all documentation pages
- Follow the existing structure in `mint.json` for navigation
- Use Mintlify components for enhanced formatting (Card, CardGroup, Accordion, etc.)
- Reference the [Mintlify documentation](https://mintlify.com/docs) for available components

## Deployment

Docs are automatically deployed when changes are pushed to the main branch.

To manually deploy:

```bash
mintlify deploy
```

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md) for contribution guidelines.
