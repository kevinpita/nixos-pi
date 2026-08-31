# Global prompt history

Search user prompts across primary human sessions in every cwd in the active Pi session store without adding the history to model context. Nested subagent sessions and artifact transcripts are not indexed.

## Usage

- `Ctrl+R`: open the floating global-history picker. Existing editor text seeds the search.
- `Ctrl+R` again or `Down`: move to an older result.
- `Up`: move to a newer result.
- `Enter`: restore the selected prompt into the editor without submitting it.
- `Ctrl+D`: confirm that the selected prompt's source session should be ignored.
- `Escape` or `Ctrl+G`: close the picker without changing the editor draft.

Commands:

- `/prompt-history [query]`: open the picker with an optional query.
- `/prompt-history-ignore-current`: ignore the current session.
- `/prompt-history-include-current`: include the current session again.
- `/prompt-history-ignored`: choose an ignored session to include again.

## Storage and privacy

The searchable prompt index is lazy, bounded, and kept only in the current Pi process. Session files are streamed instead of loaded whole. It is never sent to a model. A restored prompt reaches the model only after it is submitted normally.

Ignored sessions are stored as individual mode-`0600` marker files under:

```text
~/.pi/agent/global-prompt-history/ignored-sessions/
```

This avoids concurrent Pi processes overwriting one shared blacklist file.

## Optional configuration

Create `~/.pi/agent/global-prompt-history.json`:

```json
{
  "maxPrompts": 5000,
  "maxBytes": 16777216,
  "maxPromptBytes": 262144,
  "excludedCwdPrefixes": [
    "~/private"
  ]
}
```

Defaults keep at most 5,000 unique prompts or 16 MiB of prompt text. Individual prompts over 256 KiB are skipped. Only the small session header is read before session-ID and cwd exclusions are applied. Invalid configuration or ignored-session marker files stop indexing instead of silently disabling privacy rules.
