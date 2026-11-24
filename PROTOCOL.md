# Bridge protocol v1

Connect to `ws://HOST:8789/api/v1/events` with `Authorization: Bearer CONNECTION_KEY`. Browser Origin headers are rejected. No credentials belong in a URL.

Every server frame contains `apiVersion: 1`, `type`, `sessionId`, and integer `revision`, and `serverNow` (bridge Unix milliseconds). A new process has a new session ID. Revisions increase only when normalized race data changes.

- `state.snapshot`: `state` contains `competition`, `competitors` and `results`. `competitors`, `results` and optional `active` are objects keyed by stable IDs (`event-N:competitor-ID`). Includes `health`. While the first read is pending, `state` is null and revision is 0.
- `state.delta`: includes `baseRevision`, `changes` and `health`. `changes.competition`, if present, replaces metadata. `changes.competitors`, `changes.results` and `changes.active`, when present, each contain `upsert` objects and `delete` ID arrays. Apply the entire delta atomically, then validate references. A bib change is not a new competitor.
- `health`: sent at least every two seconds while the event loop is responsive; includes `health.ok`, `message` and `lastReadAt` (Unix milliseconds). Database errors preserve the last good state and revision. Socket liveness is not proof of database freshness.

The client sends `{"type":"state.request"}` to get a fresh snapshot. On connection, always accept a new snapshot as authoritative; do not replay its results as finish events. A delta is usable only when its session matches, `baseRevision` equals the client's revision, and `revision` is exactly one higher. Otherwise stop applying deltas and request a snapshot. There is no durable event replay journal.

Competition metadata includes event number, name, subtitle, source version, selected heats, ranking (`heat` or `total`), warnings, `runningTimersSupported` and optional `timingMode` (`simulation` or experimental `records`). In default results-only mode, `runningTimersSupported` is false.

Competitors contain `id`, `bib`, `name`, `category`, `club`, `yearOfBirth` (string or empty string). Results contain `id`, `competitorId`, `bib`, `status` (`finish`, `dns`, `dnf`, `dsq`) and `timeMs` (positive integer for finishes, null for terminal statuses).

HTTP `GET /api/v1/snapshot` returns the same snapshot envelope. `GET /api/v1/health` returns health, revision and client count. Both require the same Authorization header. There are no remote configuration or database-write routes. Localhost-only `/control/*` routes provide validated settings, folder discovery, explicit key copying, competition selection, diagnostic export and (only in simulation mode) commands to the separate replay writer; they are not part of the remote client contract. Selecting another competition starts a new session and sends a snapshot on existing WebSocket connections.

Active racers are keyed by competitor ID and contain `id`, `competitorId`, `bib`, `runId`, `startedAtMs` and `baseTimeMs`. `runId` distinguishes repeated starts of the same bib. `baseTimeMs` is the sum of selected earlier heat times, or zero for a single heat. Top-level `timing.lastStartAtMs` is the latest accepted start (null if none); `changes.timing` replaces this metadata. The receiver uses active snapshots for clock recovery and compares result deltas to produce finish holds. Full snapshots seed standings silently. Healthy heartbeat frames can re-anchor previously frozen local clocks without resending the roster.

Automatic standings add `competition.autoStandings: true` and `competition.categoryStandings`, an array of `{ category, heats, ranking }`. Use the entry matching the displayed category for labels and heat numbers; categories can be on different heats. Results already contain that category's selected time basis, so clients must not sum times again. A category switches only after a valid cumulative finish; incomplete totals are removed in the same atomic delta. Terminal statuses remain unranked. Corrections and reconnects reconstruct the selection from current rows. With automatic timing, each active racer's start and base time come from its detected heat, independently of the category's standings selection.

Local settings writes and key-copy requests require a control token and same-origin JSON POST. Network updates restart the HTTP/WebSocket listener; clients reconnect to the new configured address/port. This does not expose administration on the LAN.
