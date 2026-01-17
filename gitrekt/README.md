# Gitrekt CLI Gitrekt Server

This is the backend for your Gitrekt CLI agent, providing GitHub authentication via Better Auth.

## Tech Stack
- **Frontend**: React + Vite + Tailwind CSS 4 + shadcn/ui
- **Backend**: Hono + Bun
- **Auth**: Better Auth (GitHub Provider + Bearer Plugin)
- **Database**: Bun SQLite

## Getting Started

1. **Environment Variables**:
   Update `gitrekt/.env` with your GitHub OAuth credentials:
   ```env
   GITHUB_CLIENT_ID=...
   GITHUB_CLIENT_SECRET=...
   BETTER_AUTH_SECRET=...
   ```

2. **Install Dependencies**:
   ```bash
   cd gitrekt
   bun install
   ```

3. **Run Database Migrations**:
   The server automatically runs migrations on startup, but you can also run them manually:
   ```bash
   bun run migrate
   ```

4. **Start the Backend Server**:
   ```bash
   bun run server
   ```
   The server runs on port `3001`.

5. **Start the Frontend Development Server**:
   ```bash
   bun run dev
   ```
   The frontend runs on port `3000` and proxies `/api` requests to port `3001`.

## Authentication Flow
1. CLI checks for a session token. If none exists, it opens `http://localhost:3000?callback_url=http://localhost:3123/callback`.
2. User clicks "Continue with GitHub".
3. After successful GitHub OAuth, the user is redirected to `/success`.
4. The success page extracts the session token and redirects back to the CLI's local callback URL.
5. **CLI fetches the model configuration from `/api/cli/config`** using the session token.
6. Configuration is cached locally in `~/.gitrekt/gitrekt_config.json`.
7. User can now use the CLI with the pre-configured model.

## API Endpoints
- `POST/GET /api/auth/*` - Better Auth handlers
- `GET /api/me` - Get current user session
- `GET /api/cli/config` - Get CLI configuration (requires Bearer token)
