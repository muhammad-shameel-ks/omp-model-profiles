# model-profiles — named model + agent profiles for omp

Switch a whole model setup in one keystroke: roles (`default`, `smol`, `slow`, `plan`, …),
custom roles, and per-agent model overrides — bundled into named profiles you can
apply, snapshot, and edit from a fullscreen dashboard that looks and keys like the
native `/models` hub.

## Install (project-local)

```sh
mkdir -p .omp/extensions
cp model-profiles.ts .omp/extensions/
```

omp discovers `<project>/.omp/extensions/*.ts` automatically. Or load explicitly:

```sh
omp -e ./model-profiles.ts
```

## Use

| Command | What it does |
| --- | --- |
| `/profiles` | Fullscreen dashboard: apply, snapshot, new, rename, delete; edit roles and agent overrides; pick models with fuzzy search |
| `/profiles <name>` | Quick switch: apply that profile immediately (Tab completes profile names) |

Dashboard keys — the same shape as `/models`:

```
↑↓        move in the focused pane        tab      profiles → roles → agents
← →       switch pane (profiles) ·        enter    apply (sidebar) · pick model (row) · run action
          cycle thinking level (roles,             
          agents, picker)                 ⌫        clear a role or agent assignment from the profile
r / a     jump to roles / agents          n        new profile
s         snapshot current models as…     esc      back one level, then close
                                          mouse    hover, click, wheel (fullscreen alt-screen)
```

### Sidebar navigation

`↑`/`↓`, the wheel, and clicks all move through the same list: saved profiles plus a
trailing **＋ New profile** row. That row is a real menu entry, so it is reachable from
the keyboard and the pointer alike (and `enter` on it opens the name prompt — no need to
remember `n`). Long lists scroll: the selection is always on screen and the last row
shows `↑↓ 12-42/42` when there is more above or below. Mouse rows are mapped through the
same scroll offset, so a click always lands on the row you are pointing at.

### Thinking levels, fast — per model, with omp's own glyphs

Every model accepts a different range (`deepseek-v4.1-flash`: `low · high · max`;
`muse-spark-1.3`: `minimal · low · medium · high · xhigh`), and the hub honours the
model's own list — read from the model's `thinking.efforts`, the same source `/models`
uses:

```
ROLE        PROFILE (model · thinking) → LIVE
▸ default   opencode-go/muse-spark-1.3-contri… 󰪣 high → opencode-go/muse-spar… 󰪣 high
  slow      opencode-go/deepseek-v4.1-flash      max → opencode-go/muse-spar… 󰪥 xhigh ≠
  plan      opencode-go/deepseek-v4.1-flash     󰪥 xhigh ! ← unsupported by that model
```

- Levels render with omp's native glyphs and per-level colors (`theme.thinking` +
  `getThinkingBorderColor`) — nerd-font brains in the nerd preset, `◔ ◑ ◒ ◉` in Unicode.
- `←`/`→` rotates the thinking level wherever the cursor is — no model re-pick:
  roles rows, agents rows, and the model picker (whose header shows the highlighted
  model's supported list, and whose rows show each model's range on the right).
- Cycling never leaves the model's range: `max` on the last level wraps to `inherit`,
  and stepping from an unsupported value first clamps to the nearest supported one
  (`deepseek :xhigh` + `→` → `:max`, not a jump to the head of the list).
- `!` on a chip means the stored level is not in that model's range; applying it will
  clamp, but the profile keeps your intent until you change it.
- `auto` is a level like any other: it is stored as `model:auto` and omp resolves the
  effort per request.
- Applying a profile also pushes the `default` role's level into the live session via
  `pi.setThinkingLevel()`, so `/profiles <name>` swaps model *and* effort in one shot.
  Writes are idempotent: the level suffix is always replaced, never appended, so
  re-applying a profile or re-cycling a level cannot grow `model:auto:auto:high`.

`:max` is read as a thinking level unless an available model's id literally ends in
`:max` (`zai/glm-4.7:max`) — the same disambiguation core uses.

Roles and agents views show `PROFILE → LIVE` side by side, with `≠` marking a row
where the profile and the live setting disagree — that is your "what would change"
preview before applying.

## Where things live

| Thing | Path |
| --- | --- |
| Profiles | `<project>/.omp/model-profiles.yml` (scope: project, v1) |
| Role assignments | written through omp settings: global `~/.omp/agent/config.yml`, or project `.omp/config.yml` when `modelRoleStorage: project` |
| Agent overrides | `task.agentModelOverrides` (same layer rules as the `/agents` hub) |

```yaml
version: 1
active: cheap-fast
profiles:
  cheap-fast:
    description: Cheap fast loop; heavy thinking on demand
    roles:
      default: opencode-go/muse-spark-1.3-contributor:high
      smol:    opencode-go/muse-spark-1.3-contributor:minimal
      slow:    opencode-go/muse-spark-1.3-contributor:xhigh
    agents:
      explore: openai-codex/gpt-5.5
  deep-research:
    roles:
      default: anthropic/claude-opus-4-5:high
      plan:    anthropic/claude-opus-4-5:xhigh
```

Open the dashboard with no file present and press `s` — it snapshots your current
roles into your first profile. Nothing is seeded for you.

## What "apply" does

1. Validates every entry through `ctx.models.resolve()` — the same matcher `--model` uses.
   Unresolvable entries are **skipped, not fatal**, and reported in the notification.
2. Persists roles (`setModelRole` / `setProjectModelRole` per your `modelRoleStorage`)
   and agent overrides, preserving other agents' session-only picks.
3. Live-switches the session to the profile's `default` model via `pi.setModel()` —
   no restart, no relaunch.
4. Records `active:` in the profiles file.

`:thinking` suffixes survive editing: picking a model for a role that already had
`:high` keeps the level.

## Implementation notes (omp 18.4.3)

- omp's compiled binary resolves **only** the `@oh-my-pi/pi-tui` package root (and
  `/theme`) from an extension. Every other pi-tui subpath — `/keys`, `/mouse`,
  `/utils`, `/chrome/*`, `/overlays/*` — fails with
  `Cannot find package '@oh-my-pi/pi-tui'`. So the hub is composed from root-barrel
  primitives (`Input`, `MenuSelection`, `matchesKey`, `truncateToWidth`,
  `visibleWidth`) with a local SGR mouse decoder and a local two-pane layout that
  mirrors native hub chrome. Deep imports are type-only (erased at transpile).
- Slash commands only run in interactive mode; with `hasUI=false` (RPC/ACP headless)
  the commands fall back to stepped `select` dialogs. Print mode never dispatches
  slash commands, so `/profiles` there is a plain prompt to the model.
- `keybinding-matchers` is an unresolvable subpath, so keybindings resolve through
  the injected `KeybindingsManager` (`tui.select.up` / `down` / `pageUp` / `pageDown`
  / `cancel`) with literal `matchesKey` fallbacks — user remaps keep working.

## Development

```sh
bunx tsc --noEmit --skipLibCheck --target esnext --module esnext \
  --moduleResolution bundler --allowImportingTsExtensions model-profiles.ts
```

Smoke suite lives outside the repo (fake host harness + real `Settings` instance);
it covers apply/skip semantics, agent-override masking, thinking-suffix handling,
YAML round-trips, malformed files, and argument completions.
