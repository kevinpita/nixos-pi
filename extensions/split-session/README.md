# Split Session

`/split N [prompt]` keeps the current Pi session and opens `N - 1` additional
Herdr tabs. Each tab starts Pi with `--fork`, so it inherits the active
conversation branch while writing to an independent session file.

Without a prompt:

```text
/split 5
```

This leaves the current tab in place and creates four background tabs. Focus
stays on the current tab.

With a prompt:

```text
/split 3 explain me point $i
```

The prompt runs in all three sessions. Every `$i` is replaced by that session's
one-based index, so the sessions receive `explain me point 1`,
`explain me point 2`, and `explain me point 3`. A prompt without `$i` runs
unchanged in every session.

## Requirements

- Pi must be running inside Herdr.
- The current Pi session must be persisted.
- `N` must be between 2 and 12.

## Working directory

Every created tab starts in the current Pi working directory. Conversation
state is isolated, but files are shared. Coordinate concurrent edits or create
separate Git worktrees before editing the same files from multiple tabs.
