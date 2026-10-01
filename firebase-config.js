// Firebase web app config for project common-time-finder.
// These values are public identifiers, not secrets. Firebase is used only for Google sign-in.
export const firebaseConfig = {
  "apiKey": "AIzaSyAtPw5Bk-9CBTRE48FJFPTK4cOo09EK9F8",
  "authDomain": "common-time-finder.firebaseapp.com",
  "projectId": "common-time-finder",
  "storageBucket": "common-time-finder.firebasestorage.app",
  "messagingSenderId": "337986777641",
  "appId": "1:337986777641:web:664b08682944bea88da238"
};

// Cloudflare Worker API (D1 / SQLite) that stores meetings and availability. Source: worker/
export const apiBase = "https://common-time-finder-api.nwm1997.workers.dev";
