# Ping Pong Championship — Feature TODO

Ideas queued and implemented.

---

## 1. Number of Tables Setting (Setup → Rules)
- [x] Add a `tableCount` (Number of Tables) numeric setting in the Tournament Setup dialog under **Rules** (default `1`, allow any integer `>= 1`).
- [x] Persist `rules.tableCount` in `tournamentStore.js` (and sync over LAN/Cloud).
- [x] Support assigning/tracking active matches across multiple tables (e.g., `Table 1`, `Table 2`, …) in Scorekeeper, Control View, Presentation slides, and Next Match recommendations.
- [x] Update default/contextual table references cleanly when `tableCount > 1` (including `$table` / `$tables`).

---

## 2. Accessible & Contextual Variables for Grandma's Phrases
- [x] Support template variables inside Grandma's **Idle Banter**, **Contextual**, **Game Point**, and **Custom / Live** phrases, resolved dynamically at display/trigger time.
- [x] Supported variables (case-insensitive `$var` and `${var}`):
  - **Match & Entrants**: `$player1`, `$player2`, `$leader`, `$trailer`, `$server`, `$winner`, `$loser`, `$round`, `$match`
  - **Scores & Rules**: `$score1`, `$score2`, `$score` (e.g. `10-9`), `$targetPoints`, `$winBy`, `$pointDiff`
  - **Tournament & Venue**: `$tournament`, `$tables`, `$table` (current match table), `$playersRemaining`, `$totalPlayers`, `$matchesLeft`, `$champion`
- [x] Add an accessible variable helper/reference in Grandma's Phrase Manager (grouped clickable insert chips with keyboard focus & descriptive ARIA labels + live preview).
- [x] Gracefully fall back if a variable isn't applicable in the current state (e.g., `$champion` before finals, or `$leader` when tied) and preserve literal values like `$5`.

---

## 3. Browser & Device Notifications
- [x] Add opt-in Web Notifications API / Web Push (VAPID) / in-app alert banner support (with graceful fallback on plain HTTP LAN where browser Push/Notification permissions may be restricted, plus optional sound/vibration cues).
- [x] Support notifying devices on key tournament events (match starting, on deck, near end, role/join request approvals, tournament announcements & direct messages).

---

## 4. User Player Claim & Progress Notifications
- [x] Allow a connected user/device to claim a player (or team) from the tournament roster (with confirmation, lock-in, and host/moderator reassignment or release support).
- [x] Automatically notify the user whenever their claimed player/team progresses — including **On Deck / Next Up**, **Near End**, **Match Starting (with Table #)**, **Match Result**, and **Bracket Advancement / Elimination**.

---

## 5. Upcoming / Active Fixes
- [x] Investigate multi-table setups (independent matches per table, simultaneous multi-table scoreboards, and overflow plan when too many tables to display at once)
- [ ] Allow agent to use `git add` and `git commit` without approval *(Antigravity IDE Settings → Agent → Terminal Settings)*
- [x] Fix Presentation View slide picker UI style bug
- [x] Pause symbol still showing up even with sitcom initially covering
- [x] Stop Control View slide options from shifting UI elements during automatic slide rotation
- [x] Unified `LIVE | STUDIO` → `LIVE | PUSH` split-pill (with auto-push when returning to `LIVE`)
- [x] Only show Grandma icon in speech bubble when in coffee-cup mode
- [x] Move On Deck banner inside Inbox tab body so hiding it on On Deck tab never shifts the tab bar
- [x] Automated zero-quota QA / fuzz test engine (kept on `debug` branch off Render)

---

## 6. Security & Hardening
- [ ] Add per-IP / per-device rate limiting & brute-force lockout (with exponential backoff / `429 Too Many Requests`) on both **Tournament Room Join Keys** (`/__sync/join`, `/__sync/select`, `/__sync/state`) and **Hub Admin Key** (`/__sync/admin/unlock`).
- [ ] Use constant-time comparison (`crypto.timingSafeEqual`) for Admin Key checks and cap/guard `allowedKeyTypos` sensibly.

add a flag in tv playlist/database that tells the client to download that asset locally.

