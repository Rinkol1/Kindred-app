# Kindred

Kindred is a Node.js/Express dating and matching application with a vanilla JavaScript frontend and Supabase PostgreSQL storage.

## Required environment variables

- `SUPABASE_URL`: Supabase project URL.
- `SUPABASE_SERVICE_ROLE_KEY`: Supabase server-side secret/service-role key. Keep this private. Never put it in frontend files or commit it to GitHub.
- `NODE_ENV=production` when deployed.

## Run locally

1. Install Node.js 18 or later.
2. Run `npm install`.
3. Set the environment variables above.
4. Run `npm start`.

The app listens on `PORT` (defaults to 3000) and exposes `/health` for health checks.

## Database

Run the Kindred SQL schema in the Supabase SQL Editor before starting the server. The server uses the `users`, `sessions`, `swipes`, `blocks`, and `messages` tables.

## Security notes

The service-role key bypasses Row Level Security, so it belongs only in the hosting provider's private environment variables. Never expose it to browser JavaScript, screenshots, public repositories, or chat messages. Use HTTPS in production.
