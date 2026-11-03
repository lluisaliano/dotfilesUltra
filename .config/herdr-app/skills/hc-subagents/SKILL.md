---
name: hc-subagents
description: Delegate work to sub-agents or run long programs in persistent Herdr terminals with herdr-core (`hc`). Use when running inside Herdr (HC_TERMINAL_ID is set) and the task benefits from parallel agents, a reviewer, background jobs (builds, tests, deploys, dev servers), or reading/steering another terminal or agent.
---

# Sub-agents with herdr-core (`hc`)

Inside Herdr, sub-agents and long-running jobs go through `hc`, so the person
can see them in the Herdr app (agents list, peek) and take over.

## Before doing anything

1. Check you are in Herdr: `HC_TERMINAL_ID` must be set (`echo $env:HC_TERMINAL_ID`
   in PowerShell, `echo $HC_TERMINAL_ID` in sh). If not, don't use this skill.
2. Run `hc --skill` and follow that manual. It is the current one for the
   installed herdr-core version: don't rely on memory or on this file for
   commands or flags.
3. Run `hc templates` to see ready-made roles (reviewer, simplifier, ...) and
   prefer one that fits.

## Rules that always apply

- Start agents with `--bg`, a `--name`, an exact scope and the task in the
  same `hc run` call. Ask them to report back with `hc send $HC_TERMINAL_ID`.
- Run agents interactively (never one-shot print modes like `-p`).
- Don't let children start more agents unless you assign that explicitly.
- Wait with `hc wait <t>` (or `--children`), never with sleep loops.
- If a child is `blocked`, read its screen and ask the user; never use
  `hc send --force` to bypass a permission prompt.
- Clean up only terminals you started (`hc kill`, then `hc rm`) once their
  work is accepted.
- Never `hc server stop`/`restart` unless the user asks.
- For arranging the window (tabs, splits, layouts), use `herdr-app --skill`
  instead.
