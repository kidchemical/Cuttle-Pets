# `.cuttle/` — per-project Cuttle config

Mirror of the Cuttle global layout. This project owns its own commands, rules,
actions, and docs — it does **not** inherit another project's recipes.

```text
.cuttle/
  commands/*.md     # slash commands (/name)
  rules/*.md        # always-on (Context Compiler / Cuttle Brain)
  actions/*.yaml    # allowlisted side effects (forms / confirms)
  docs/             # runbooks
  scripts/          # optional shell helpers
  agents/<id>/      # optional harness agents
  memory/           # reserved
```

Also created at the project root (not under `.cuttle/`):

```text
temp/               # agent scratch / redirected stdout (gitignored)
```

Install-local overlay (gitignored except README):

```text
.cuttle/personal/   # mirrors commands|rules|actions|docs|scripts — supplements tracked (md appends, rest wins)
```

Global reference: see this repo's `.cuttle_global/README.md` and `.cuttle_global/docs/commands-and-actions.md`
(relative to your Cuttle install — do not hardcode another machine's drive path).
