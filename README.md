# Common Time Finder

Find a meeting time that works for everyone. Create a meeting, pick the dates and hours, and share the link. Each person signs in with Google and marks when they're free. The app shows a group heat map and ranks the best common time slots.

**Live site:** https://nwm1997-blip.github.io/common-time-finder/

## Setup (one time)

1. Create a free project at https://console.firebase.google.com/
2. **Authentication** → Get started → enable **Google**. Under *Settings → Authorised domains*, add `nwm1997-blip.github.io`.
3. **Firestore Database** → Create database (production mode). Open the *Rules* tab, paste the contents of [`firestore.rules`](firestore.rules), and publish.
4. **Project settings** → *Your apps* → add a **Web** app. Copy the `firebaseConfig` object into [`firebase-config.js`](firebase-config.js), commit and push.

The Firebase web config is a public identifier, not a secret. Access is enforced by `firestore.rules`:
- Anyone signed in with the link can open a meeting.
- Each person can only write their own availability.
- Only the creator can edit or delete a meeting.
- Your meeting list shows only meetings you created or replied to.

## Files

- `index.html`, `style.css`, `app.js`: the app (no build step)
- `firebase-config.js`: your Firebase project config
- `firestore.rules`: database security rules
