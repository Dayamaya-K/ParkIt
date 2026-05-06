# Park It! — Precision Parking

A browser-based 3D parking game built with Three.js. Navigate dense parking lots, slot into tight spaces, and chase the leaderboard. Plays equally well on desktop (keyboard) and mobile (touch controls).

## Features

- **10 hand-tuned levels** — straight-in, parallel, reverse, diagonal, and a multi-row maze
- **Realistic car physics** — bicycle-model steering, speed-aware turn radius, handbrake
- **Mobile-first touch controls** — draggable steering wheel + pedal buttons (auto-detected)
- **Park alignment system** — multi-factor scoring (inside-spot + centering + heading), hold-to-park
- **Proximity sensors with audio** — beeps escalate as you near obstacles
- **Online leaderboard** — top 5 scores via Supabase, scoped by `game_id`
- **Star rating** — 3★ for perfect park, 2★ good, 1★ completed
- **Two cameras** — top-down (default) and chase cam

## Tech Stack

- [Three.js](https://threejs.org/) (WebGL, ES modules)
- Vanilla HTML/CSS/JS — no build step
- [Supabase](https://supabase.com/) REST API for leaderboard
- Web Audio API (synthesized engine + beeps)

## Controls

### Desktop (keyboard)

| Key       | Action            |
| --------- | ----------------- |
| `W` / `↑` | Drive forward     |
| `S` / `↓` | Reverse / brake   |
| `A` / `←` | Steer left        |
| `D` / `→` | Steer right       |
| `Space`   | Handbrake         |
| `C`       | Cycle camera      |
| `R`       | Reset car         |
| `P` / `Esc` | Pause           |

### Mobile (touch — auto-detected)

- **Steering wheel** (bottom-left) — drag to turn, releases to center
- **GO** (green pedal) — accelerate
- **BRAKE** (red pedal) — brake / reverse when stopped
- **HOLD** — handbrake
- **CAM** — toggle camera

## Scoring

```
score = (totalStars × 100) + max(0, 800 − totalSeconds) − (bumps × 25)
```

- 3★ requires: 0 bumps, ≥85% alignment, time ≤ gold target
- 2★ requires: ≤1 bump, ≥70% alignment, time ≤ silver target
- 1★ for completing the level
