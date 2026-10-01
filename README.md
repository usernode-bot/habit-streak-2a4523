# Habit Streak

Daily habit check-in with streak calendar and a group leaderboard.

- **Today** — your habits as clean cards: a big check-in button for
  today, the current streak, and 30 dots showing the last month of
  completions.
- **Add habit** — one field, names of 3+ characters.
- **Leaderboard** — everyone in the group ranked by their longest
  current streak.

## How it works

- Sign-in is handled by Homeroom: the server verifies the
  platform-issued user token (an RS256 JWT) on every request.
- The app has its own Postgres database. `habits` holds each habit
  (owner, name); `habit_checks` holds one row per checked day, keyed
  on `(habit_id, check_date)` so a check-in is idempotent and a streak
  is a walk backwards through consecutive dates (UTC).
- Styling is Tailwind CSS, precompiled by `npm run build` during image
  creation; the page follows the platform's light/dark theme with the
  OS preference as fallback.
- Staging containers seed a few obviously fake demo members
  (`staging-demo-*`) so the leaderboard and streak dots are reviewable
  on an empty database.