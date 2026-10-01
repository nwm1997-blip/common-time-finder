# Common Time Finder

Find a meeting time that works for everyone. Create a meeting, pick the dates and hours, and share the link. Each person signs in with Google and marks when they're free. The app shows a group heat map and ranks the best common time slots.

**Live site:** https://nwm1997-blip.github.io/common-time-finder/

## How it fits together

| Part | Where | What it does |
|---|---|---|
| Website | GitHub Pages (`index.html`, `style.css`, `app.js`) | The app UI. No build step. |
| Sign-in | Firebase Authentication (project `common-time-finder`) | Google sign-in. The browser gets an ID token. |
| API | Cloudflare Worker (`worker/`) at `https://common-time-finder-api.nwm1997.workers.dev` | Verifies the Firebase ID token on every request, then reads and writes the database. |
| Database | Cloudflare D1 (SQLite), database `common-time-finder` | Tables `meetings` and `availability` (see `worker/schema.sql`). |

The meeting page checks for new responses every 12 seconds.

### Access rules (enforced in the Worker)
- You must be signed in for every request.
- Anyone signed in with a meeting link can view it.
- Each person can only save their own availability.
- Only the creator can delete a meeting.
- Your meeting list shows meetings you created or replied to.

## API

All routes need `Authorization: Bearer <Firebase ID token>`.

| Method | Path | Body |
|---|---|---|
| GET | `/api/meetings` | – (your meetings) |
| POST | `/api/meetings` | `{title, note, dates[], startMin, endMin, tz}` |
| GET | `/api/meetings/:id` | – (meeting + everyone's availability) |
| PUT | `/api/meetings/:id/availability` | `{slots[]}` |
| DELETE | `/api/meetings/:id` | – (creator only) |

## Working on the API

```sh
cd worker
npx wrangler login                     # once
npx wrangler deploy                    # deploy changes
npx wrangler d1 execute common-time-finder --remote --command "SELECT COUNT(*) FROM meetings"
npx wrangler d1 export common-time-finder --remote --output backup.sql   # back up the data
```

To allow another site origin to call the API, add it to `ALLOWED_ORIGINS` in `worker/wrangler.toml` and redeploy.
