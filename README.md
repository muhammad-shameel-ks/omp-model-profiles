# omp-model-profiles

Named model + thinking-level profiles for [Oh My Pi](https://github.com/can1357/oh-my-pi) (`omp`).

Switch a whole model setup in one keystroke: roles (`default`, `smol`, `slow`, `plan`, …),
custom roles, and per-agent model overrides — bundled into named profiles you can
apply, snapshot, and edit from a fullscreen dashboard that looks and keys like the
native `/models` hub.

## Install

```sh
omp plugin install github:muhammad-shameel-ks/omp-model-profiles
```

That is a user-scope install (`~/.omp/plugins`), so `/profiles` is available in every
project. Confirm it registered:

```sh
omp plugin list      # ● omp-model-profiles@0.1.0
omp plugin doctor    # 4 ok, 0 warnings, 0 errors
```

Update to the latest commit, or remove it:

```sh
omp plugin install github:muhammad-shameel-ks/omp-model-profiles --force
omp plugin uninstall omp-model-profiles
```

### Working on the plugin

```sh
git clone https://github.com/muhammad-shameel-ks/omp-model-profiles
cd omp-model-profiles
omp plugin link .    # symlinks this checkout into ~/.omp/plugins
bun install && bun test && bun run typecheck
```

Edits take effect on the next omp start; `omp plugin install … --force` puts back the
pinned GitHub copy.

### No plugin manager

omp also discovers extension files directly — `<project>/.omp/extensions/*.ts` (that
project only) or `~/.omp/agent/extensions/*.ts` (that omp profile, any project):

```sh
mkdir -p .omp/extensions && cp model-profiles.ts .omp/extensions/
omp -e /path/to/model-profiles.ts    # or load a single file explicitly
```

## Use

| Command | What it does |
| --- | --- |
| `/profiles` | Fullscreen dashboard: apply, snapshot, new, rename, delete; edit roles and agent overrides in place; pick models with fuzzy search; keeps the active profile in step with live settings |
| `/profiles <name> [project\|global]` | Quick switch: apply that profile immediately (optional target scope; Tab completes profile names and scopes) |

Dashboard keys — the same shape as `/models`:

```
↑↓ / j k   move in the focused pane        tab      profiles → roles → agents
← →        cycle thinking on a row ·       enter    pick model (row) · run action (bar)
           walk the action bar             b        apply the profile
r / a      jump to roles / agents          n        new profile
s          snapshot current models as…     e        edit the description
esc        back one level, then close      mouse    hover, click, wheel (fullscreen alt-screen)
```

### Focus, and why there is only ever one ▸

The hub has two panes and exactly one cursor. A `▸` marks whatever owns the
keyboard right now:

- **Profile picker** — `↑`/`↓` (or `j`/`k`) move through the saved profiles and the
  detail pane re-renders as a live preview of the one you are on. The cursor stays
  in the sidebar, so you can walk past the third, fourth, tenth profile without
  interrupting yourself. `→` is what moves focus right (or click the detail pane);
  `esc` brings it back. The sidebar greys out every profile except the one loaded
  on the right while the detail pane has focus, which is what makes the single
  `▸` unambiguous about which pane owns the keyboard.
- **Detail pane** — the profile is one focusable list: the description, then the
  role rows, then the agent rows, then the action bar. `↑`/`↓` walk all of it. On
  a role or agent row `←`/`→` rotate the thinking level and `enter` opens the
  model picker — you can change a model without ever leaving this screen. On the
  action bar `←`/`→` pick the action and `enter` runs it, because a horizontal
  bar should never be driven with vertical arrows.

`enter` in the profile picker applies the selected profile outright, and `b`
applies it from anywhere in the detail pane.

The wheel follows the pointer, like any two-pane browser: over the sidebar it
browses profiles, over the body it walks the detail rows. Neither path moves the
cursor between panes.

The header is right-aligned with the model the session is *actually* running, so
every profile view is anchored to reality rather than only showing what the
profile would install.

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

## Changes you make outside the hub are captured

The active profile is kept in step with the live role settings, so a model you
switch with the native `/model` hub (or a subagent, or a hook) ends up in the
profile instead of only in `config.yml`:

- On open, the hub compares the live roles against the active profile and writes
  the differences straight to whichever file that profile lives in —
  `.omp/model-profiles.yml` for a `proj` profile,
  `~/.omp/agent/model-profiles.yml` for a `glob` one. It reports what it synced.
- While the hub is open it re-checks every couple of seconds, so a switch made
  elsewhere lands in the profile mid-session.
- Only the **active** profile is written. The others are left alone.
- The live settings win per role: a role the settings no longer configure is
  dropped from the profile, and a role the settings added is added to it. Agent
  overrides and the description are never touched by a sync.
- Applying a profile re-baselines the check, so the hub never reads its own write
  back as a foreign switch and reverts an entry that apply skipped.

## Where things live

| Thing | Location |
| --- | --- |
| Project profiles | `<project>/.omp/model-profiles.yml` (versionable with the repo, `proj` tag in sidebar) |
| Global profiles | `~/.omp/agent/model-profiles.yml` (fallback `~/.omp/model-profiles.yml`, available everywhere, `glob` tag) |
| Project roles | `<project>/.omp/config.yml` (`scope.setProjectModelRole`) |
| Global roles | `~/.omp/agent/config.yml` (`scope.setModelRole`) |
| Agent overrides | `task.agentModelOverrides` (persisted to settings) |

Profiles can be saved **project-only** (scoped to one repository) or **globally** (available across all projects on your machine). Whenever you save a snapshot (`s`), create a new profile (`n`), or apply a profile, the dashboard prompts you:

```
  Save profile "deepseek" where?

  ▸ [Project only]  .omp/ (current repository only)
    [Global]        ~/.omp/agent/ (available everywhere)

  ←→ / ↑↓ select · p project · g global · enter confirm · esc cancel
```

Both global and project profiles load simultaneously into the dashboard. When a project profile shares a name with a global profile, the project profile takes precedence in that repository.
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

1. Prompts whether to save the applied roles to **Project only** (`.omp/config.yml`) or **Global** (`~/.omp/agent/config.yml`), pre-selecting the profile's own scope (or run `/profiles <name> project` / `/profiles <name> global` to choose directly from the command line).
2. Validates every entry through `ctx.models.resolve()` — the same matcher `--model` uses.
   Unresolvable entries are **skipped, not fatal**, and reported in the notification.
3. Persists roles (`setModelRole` or `setProjectModelRole` per your selected scope)
   and agent overrides, preserving other agents' session-only picks.
4. Live-switches the session to the profile's `default` model via `pi.setModel()` —
   no restart, no relaunch.
5. Records `active:` in the profile's source file (`.omp/model-profiles.yml` or `~/.omp/agent/model-profiles.yml`).

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
bun install
bun run typecheck
bun test
```

`tests/model-profiles.test.ts` runs against a fake host harness (a stub `pi` API plus a
real `Settings` instance), so the whole dashboard's non-visual logic is covered:
apply/skip semantics, agent-override masking, thinking-suffix handling (per-model
efforts, clamping, `auto`, junk-chain collapse), sidebar menu identity and scroll
windowing, the detail pane's focusable row list, the live-settings drift diff, the
hub's sync-on-open (including scope routing and that agents/description survive),
YAML round-trips, malformed files, and argument completions.
