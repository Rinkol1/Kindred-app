# Kindred

A small dating app built with Node.js, Express and a vanilla JavaScript front end.

## Run it
```
npm install
npm start
```
Open http://localhost:3000. Node 18 or newer is required.

## Features
- Sign up and log in (passwords hashed with scrypt, session cookie is HttpOnly)
- Profile editing (name, age, city, bio, interests) and account deletion
- Discover profiles, like or pass, mutual likes become matches
- Chat with matches, block a match
- 18+ only, input validation, login rate limiting

## Demo mode
On first start, five demo profiles are created. They like you back and reply to chats so you can try everything alone.
- `DEMO_MODE=0` turns off the auto-likes and auto-replies
- `SEED=0` skips creating demo profiles

## API
| Method | Path | Purpose |
| --- | --- | --- |
| POST | /api/signup, /api/login, /api/logout | Accounts |
| GET, PUT, DELETE | /api/me | View, edit, delete your profile |
| GET | /api/discover | Profiles you haven't responded to |
| POST | /api/swipe | `{ targetId, like }` |
| GET | /api/matches | Mutual likes |
| GET, POST | /api/messages/:id | Chat with a match |
| POST | /api/block/:id | Block a user |

## Before going live
- Replace `data/db.json` with PostgreSQL or MongoDB
- Serve over HTTPS and set `NODE_ENV=production` (makes cookies Secure)
- Add email verification, password reset, photo uploads, and a way to report users
- Swap polling for WebSockets (Socket.IO) for instant chat
