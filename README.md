# pi-andon

A manufacturing-style andon light for a [pi](https://pi.dev) session: a status
card under the editor and the terminal title show whether the agent is
progressing (green), waiting a long time on something (amber), or stopped and
needing you (red), with a one-line summary of the session.

One file is the whole extension: the lamp, the `set_andon` tool, the session
title and a small supervisor that reports what the agent is doing right now and
a rolling summary of the session so far.

## Install

```sh
pi install git:github.com/db112358/pi-andon
```

For one run instead of settings:

```sh
pi -e git:github.com/db112358/pi-andon
```

Or clone the repo and link `extensions/andon.ts` into `~/.pi/agent/extensions/`.
pi supplies `@earendil-works/*` and `typebox` to extensions, so there is nothing
to install.

## The card

The light is the thing you scan a wall of sessions for. Green means the agent is
working; amber means it is waiting on something long; red means it stopped and
needs a decision.

Amber is raised without being asked: 80% into a wait the model declared, or
after three minutes of a tool that was never declared. Red follows a blocking
prompt, an aborted run, a failure, or an explicit `set_andon` call.

`/andon` manages the card:

- `/andon` or `/andon toggle` — show or hide it
- `/andon show`, `/andon hide`
- `/andon <summary>` — set the summary line
- `/andon edit` — edit the summary in an editor
- `/andon title [text]` — set the session title (an editor when text is omitted)
- `/andon state green|amber|red|auto`
- `/andon wait <duration>` or `/andon wait off`
- `/andon clear` — clear the summary, the wait and the explicit state

`Ctrl+Shift+A` toggles the card.

## The tool

The model drives the same card with `set_andon`:

| argument | meaning |
|---|---|
| `title` | a stable one-line description of the session |
| `summary` | what the agent is doing right now, under ~60 characters |
| `state` | `green`, `amber` or `red`; omitted leaves the resolved light alone |
| `wait` | a duration such as `10m`; the card turns amber at 80% of it and clears when the tool it was declared for ends |

The tool's `details` carry the resolved state, so a reader that only sees the
tool result still gets the light.

## The supervisor

Every 20 seconds while a session is active, the extension asks a model to read a
digest of the session — verbatim user messages, assistant replies, running and
recent tools, phase, elapsed time, context, the model's own declared intent and
its previous summary — and answer with one object:

```json
{
  "state": "green",
  "objective": "running sleep command",
  "description": "The user asked for a 4s bash run and an acknowledgement; the command finished and the agent replied ok.",
  "note": ""
}
```

- `objective` is a 2-5 word present-participle phrase: what the agent is doing
  right now, from outside the transcript. It takes the card's intent line once
  the model's own `set_andon` summary is three minutes old.
- `description` is the rolling 1-2 sentence summary of the session, carried
  forward each cycle. The card does not show it; it rides `andon.state` and the
  bus so other readers can (goji's floor, `dbe pi top`).
- `state` may raise the lamp — red becomes `flagged`, amber becomes `stalled` —
  while the session is working or in a declared wait. It never lowers the light
  and never overrides `/andon state`.
- `note` says why the light was raised, in a few words, and appears beside it.

The supervisor runs on the session's own model unless another is configured, so
a fresh machine needs no setup. Its calls are ledgered as `andon` usage and
never enter the session's context. Settings live in `~/.pi/agent/andon.json`
(or `$PI_CODING_AGENT_DIR/andon.json`):

```json
{
  "supervisor": {
    "enabled": true,
    "provider": "fireworks",
    "model": "accounts/fireworks/models/glm-5p3-flash",
    "intervalMs": 20000
  }
}
```

- `/andon supervisor` — model, cadence, calls, spend, last judgement
- `/andon supervisor on|off`
- `/andon supervisor model [<provider>/<id>]` — a picker in the TUI
- `/andon supervisor interval <duration>`

An external supervisor can still drive the card: `andon:update` on the extension
bus (`{sessionId, state, objective, description, note, label}`) takes over from
the built-in one for ten minutes.

## The record

Two things are appended to the session, never to a file:

- `customType: "andon"` — the intent: title, title source, summary, explicit
  state, visibility.
- `customType: "andon.state"` — the resolved lamp, on every change:

```json
{
  "v": 1,
  "light": "green",
  "word": "working",
  "pulsing": true,
  "objective": "running sleep command",
  "description": "The user asked for a 4s bash run and an acknowledgement; the command finished and the agent replied ok.",
  "title": "Run sleep and echo",
  "waitUntil": "2026-11-17T10:20:00.000Z"
}
```

pi forwards `andon.state` as `entry_appended`, so the light and the summary are
live over the RPC stream and durable in pi's own session log at once. A reader
needs no file and no second clock.

The resolved state also goes out on the extension bus as `andon:state`. A
supervisor's judgement may raise the light but never lower it.

## Companions

- [pi-pulse](https://github.com/db112358/pi-pulse) publishes `pulse:tps`, which
  supplies the calibrated tok/s gauge under the light. Without it the gauge
  falls back to a rough characters-per-token estimate of the stream.
- `gh` supplies the open pull request for the checked-out branch, refreshed at
  most every five minutes and after `gh pr`, `git checkout`, `git switch` and
  `git worktree` commands. No `gh`, no link.

## Title

A session with no title gets one from the session model on its first prompt: a
32-token completion, temperature 0, ledgered as `andon` usage rather than
session output. `/andon title` and `set_andon` outrank it.

## Requirements

pi 1.5.2 or newer. The card, the title, the tool, the supervisor and the entries
work on a stock release; nothing here needs a pi fork or another extension.

## Licence

MIT.
