# Jev context pruning

Use TypeSafe Jev to hide low-value history from future model requests. Original session messages stay intact. The extension is off by default and has no runtime dependencies beyond Pi and Node.js.

Requires Pi 0.85.1 or later with the `agent_settled` event.

## Load

Add the absolute path to `extensions/jev-context/index.ts` to the `extensions` array in your Pi settings, then run `/reload`. Keep `context.ts` and `jev.ts` beside `index.ts`.

For a temporary session:

```bash
pi -e ./extensions/jev-context/index.ts
```

This repository does not enable extensions automatically. NixOS users must select the extension directory in `nixos-config/modules/pi.nix` too.

## Authentication

After loading the extension, run:

```text
/login typesafe
/jev on
```

Enter the API key in Pi's secret prompt. Get a key from https://console.typesafe.ai. Pi stores it under `typesafe` in its standard `auth.json` credential file, normally `~/.pi/agent/auth.json`. Do not commit this file. The extension resolves credentials through Pi for each scan and never saves the key in session entries or Nix configuration.

TypeSafe appears as **TypeSafe (Jev)** in `/login`. It does not add a main-agent model to `/model`: Jev answers structured judgment questions, not chat completions.

`TYPESAFE_API_KEY` remains an optional fallback. A stored key takes precedence. `/logout typesafe` removes the stored key, but the fallback still works if the environment variable remains set. If judging paused before login, use `/jev on` to resume it.

**Privacy:** When enabled, the extension sends candidate assistant history, tool arguments and text results, and excerpts of recent conversation to `https://api.typesafe.ai/v1/systemone`. These can contain private code or secrets. No TypeSafe API requests are made while disabled.

## Commands

| Command | Effect |
| --- | --- |
| `/jev on` | Enable pruning and scan if idle. Also resume judging after an error. |
| `/jev off` | Stop judging and stop filtering history. Cached judgments remain. |
| `/jev status` | Show settings and the number of cached judgments. |
| `/jev threshold 0.8` | Keep only candidates with a probability **greater than** 0.8. Reuse stored probabilities. |
| `/jev buffer 5` | Protect the latest five tool call/result pairs during active work. Zero disables the buffer. |
| `/jev cache off` | Rejudge all eligible candidates on each scan. |
| `/jev cache on` | Judge only new or changed candidates. This is the default. |
| `/rejev` | While enabled and idle, rejudge all eligible active-branch history against the latest conversation. Includes hidden candidates, which can become visible again. |

Commands save settings for the current session branch. Judgment records also follow the branch and survive reloads, resume, and forks. Changing the threshold does not require new API calls for cached candidates.

## Defaults

Optional global configuration: `~/.pi/agent/jev-context.json` (or the active Pi agent directory).

```json
{
  "enabled": false,
  "threshold": 0.8,
  "buffer": 5,
  "cache": true,
  "model": "jev-latest",
  "timeoutMs": 60000
}
```

Session settings saved by `/jev` take precedence over these defaults. `timeoutMs` bounds an entire scan, not each request. Use a versioned model name if judgments must not change when the `jev-latest` alias changes.

## Scan and removal rules

- During active work, scan at the `context` hook before the next model request. This is after tool completion, or after the complete batch when tools run in parallel. No scan runs between parallel sibling results. The initial model request uses the same hook.
- While running, exclude the latest `buffer` calls from judging and pruning. Even a previously hidden call is protected if it is in this active buffer.
- At `agent_settled`, scan in the background with no tool buffer. New input, agent activity, compaction, navigation, shutdown, or a settings change cancels the scan.
- Keep all user messages, system instructions, extension messages, and compaction/branch summaries. This deliberately protects older user requirements too.
- Keep all `todo` calls and results, including previously judged ones. The task list persists outside model context. Hiding its operations can make the agent forget task IDs and create duplicate work. This protection does not remove existing duplicate tasks.
- Judge each other complete text-only tool call/result pair. Remove both together, never just one half. Incomplete or ambiguous pairs, image results, and results that introduce dynamically loaded tools stay intact.
- Judge assistant text and readable thinking together as one unit. Retain the original assistant content while any of its tool calls survive. Opaque or redacted thinking stays intact.
- Judge user shell execution history, except commands excluded from model context with `!!`.
- Keep unknown message types. Do not send image data or tool-result `details` to Jev.

A Jev **Noul** answer is the probability that the candidate should be kept. It is not a separate confidence score. At the default threshold, 0.81 stays and 0.80 is hidden. This is an aggressive policy: uncertain information can be hidden. A lower threshold keeps more history.

Large candidates are split into text fragments without truncating their content. Independent questions share bounded requests. If any fragment exceeds the keep threshold, retain the whole original candidate. Recent conversational evidence uses bounded excerpts, including the latest user request. This limits request size but can miss earlier task context.

Only successful, complete scans are saved. Errors, invalid responses, and timeouts leave existing judgments unchanged and pause automatic judging. Existing pruning remains active. Use `/rejev` or `/jev on` to retry, or `/jev off` to restore unfiltered history. Requests are sequential, with no automatic retry loop.

## Savings notice

After the agent finishes and the idle scan succeeds, Pi shows a notice such as `Jev saved ~12.4k context tokens.` Small reductions are shown as whole tokens.

This uses Pi's token estimator to compare the current history with its pruned form, without the active-tool buffer. It includes cached decisions and counts each removed part once. It is a snapshot of context reduction, not cumulative API token or billing savings. No notice is shown for disabled pruning or a failed or cancelled scan. The notice does not enter model context.

## Limits

Filtering changes outgoing model context, not the transcript on disk or in the UI. Pi's context meter and automatic compaction use its own history and accounting, so they need not immediately reflect this reduction. Pruning can also invalidate provider prompt caches.

Pi compaction remains independent. `/rejev` only scans history in the current compaction checkpoint and retained tail. It does not resurrect messages that Pi itself has compacted away. Other extensions can also change context before or after this extension runs.

Jev can make incorrect relevance decisions. Once-only caching intentionally does not adapt old judgments to a new task. Use `/rejev` when the topic changes, or disable caching if the extra latency and API usage are acceptable.
