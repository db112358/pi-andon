# Changelog

## 1.1.0 - 2026-11-17

- The supervisor is part of the extension: a present-participle objective, a
  rolling description, a green/amber/red judgement and a note, on the session's
  own model by default with no configuration.
- `andon.state` entries and the `andon:state` broadcast carry `description` and
  `note`, so other readers get the summary without reading the transcript.
- `/andon supervisor` to inspect, `on|off`, `model`, `interval`; settings in
  `~/.pi/agent/andon.json`.
- An external `andon:update` from another supervisor still takes the card over
  for ten minutes.

## 1.0.0 - 2026-11-17

- First release: the status card, the terminal title, the `set_andon` tool and
  the durable `andon.state` entry.
