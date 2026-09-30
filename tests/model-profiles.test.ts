import { describe, expect, test, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mp-"));
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "mp-agent-"));
process.chdir(tmp);
process.env.OMP_AGENT_DIR = agentDir;

import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgModelRoles } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { cfgTaskAgentModelOverrides } from "@oh-my-pi/pi-coding-agent/task/settings";
import mod, { applyProfile, formatApplyResult, loadProfiles, saveProfiles, splitSelector, cycleThinking, withThinking, thinkingOptions, clampThinking,
  profileMenuItems, profileNameOf, windowStart, NEW_PROFILE_ITEM } from "../model-profiles.ts";

let commands: Record<string, any> = {};
const notifications: { message: string; type?: string }[] = [];
let selectAnswer: string | undefined;
let scope: Settings;
let switched: string[] = [];

const fakePi: any = {
  setLabel: () => {},
  registerCommand: (name: string, opts: any) => { commands[name] = opts; },
  setModel: async (m: any) => { switched.push(`${m.provider}/${m.id}`); return true; },
  pi: null as any,
};
mod(fakePi);

const madeModels = [
  { provider: "prov-a", id: "model-x" },
  { provider: "prov-b", id: "model-y" },
  { provider: "prov-b", id: "model-z" },
];

function makeCtx() {
  const list = () => madeModels;
  return {
    cwd: tmp, hasUI: false, mode: "print",
    models: {
      list,
      current: () => madeModels[0],
      resolve: (s: string) => {
        const want = s.split(",")[0]!.trim();
        const bare = want.split("/").pop()!;
        return madeModels.find(m => `${m.provider}/${m.id}` === want) ?? madeModels.find(m => m.id === bare);
      },
    },
    ui: {
      notify: (message: string, type?: string) => { notifications.push({ message, type }); },
      select: async (_t: string, _o: string[]) => selectAnswer,
      input: async () => undefined,
      confirm: async () => false,
      custom: async () => undefined,
    },
  } as any;
}

describe("profiles extension", () => {
  beforeEach(async () => {
    notifications.length = 0; selectAnswer = undefined; switched = [];
    fs.rmSync(path.join(tmp, ".omp"), { recursive: true, force: true });
    fs.rmSync(path.join(agentDir, "model-profiles.yml"), { force: true });
    scope = await Settings.init({ agentDir, cwd: tmp });
    fakePi.pi = { settings: scope };
  });

  test("registers exactly one command, /profiles", () => {
    expect(Object.keys(commands)).toEqual(["profiles"]);
  });

  test("applyProfile persists roles and live-switches default", async () => {
    const res = await applyProfile(fakePi, makeCtx(), scope, {
      roles: { default: "prov-a/model-x:high", smol: "prov-b/model-y" },
    });
    expect(res.appliedRoles.sort()).toEqual(["default", "smol"]);
    expect(cfgModelRoles.get(scope)["smol"]).toBe("prov-b/model-y");
    expect(cfgModelRoles.get(scope)["default"]).toBe("prov-a/model-x:high");
    expect(res.switchedDefault).toBe("prov-a/model-x");
    expect(switched).toEqual(["prov-a/model-x"]);
  });

  test("applyProfile skips unresolvable entries and keeps applying the rest", async () => {
    const res = await applyProfile(fakePi, makeCtx(), scope, {
      roles: { default: "nope/nothing", smol: "prov-b/model-y" },
    });
    expect(res.appliedRoles).toEqual(["smol"]);
    expect(res.skipped.map(s => s.key)).toContain("@default");
    expect(res.switchedDefault).toBeUndefined();
  });

  test("applyProfile persists agent overrides without masking session picks", async () => {
    cfgTaskAgentModelOverrides.override(scope, { other: "prov-b/model-z" });
    const res = await applyProfile(fakePi, makeCtx(), scope, {
      agents: { explore: "prov-a/model-x" },
    });
    expect(res.appliedAgents).toEqual(["explore"]);
    const effective = cfgTaskAgentModelOverrides.get(scope);
    expect(effective["explore"]).toBe("prov-a/model-x");
    expect(effective["other"]).toBe("prov-b/model-z");
  });

  test("applyProfile strips thinking suffix for resolution then persists full selector", async () => {
    const res = await applyProfile(fakePi, makeCtx(), scope, { roles: { slow: "prov-b/model-z:xhigh" } });
    expect(res.appliedRoles).toEqual(["slow"]);
    expect(cfgModelRoles.get(scope)["slow"]).toBe("prov-b/model-z:xhigh");
  });

  test("/profiles <name> unknown name notifies with the known list", async () => {
    await commands["profiles"].handler("ghost", makeCtx());
    expect(notifications[0]?.message).toContain('Unknown profile "ghost"');
  });

  test("/profiles <name> with no profiles teaches the dashboard", async () => {
    await commands["profiles"].handler("", makeCtx());
    expect(notifications[0]?.message).toContain("No profiles yet");
  });

  test("round-trip: yml write → /profile applies → active recorded", async () => {
    saveProfiles(tmp, { version: 1, profiles: { fast: { roles: { smol: "prov-b/model-y" } } } });
    await commands["profiles"].handler("fast", makeCtx());
    expect(cfgModelRoles.get(scope)["smol"]).toBe("prov-b/model-y");
    expect(notifications[0]?.message).toContain('Profile "fast" applied (1 role)');
    expect(loadProfiles(tmp).active).toBe("fast");
  });

  test("/profiles without args falls back to the picker in headless mode", async () => {
    saveProfiles(tmp, { version: 1, profiles: { one: { roles: { smol: "prov-a/model-x" } }, two: {} } });
    selectAnswer = "one";
    await commands["profiles"].handler("", makeCtx());
    expect(cfgModelRoles.get(scope)["smol"]).toBe("prov-a/model-x");
  });

  test("argument completions list profile names", () => {
    saveProfiles(tmp, { version: 1, profiles: { alpha: {}, beta: {}, gamma: {} } });
    const all = commands["profiles"].getArgumentCompletions("");
    expect(all.map((i: any) => i.value).sort()).toEqual(["alpha", "beta", "gamma"]);
    const b = commands["profiles"].getArgumentCompletions("b");
    expect(b.map((i: any) => i.value)).toEqual(["beta"]);
    expect(commands["profiles"].getArgumentCompletions("zzz")).toBeNull();
  });

  test("loadProfiles tolerates missing, malformed and partial files", () => {
    expect(Object.keys(loadProfiles(tmp).profiles)).toEqual([]);
    fs.mkdirSync(path.join(tmp, ".omp"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".omp", "model-profiles.yml"), "{ not: yaml: [ }");
    expect(loadProfiles(tmp).profiles).toEqual({});
    fs.writeFileSync(path.join(tmp, ".omp", "model-profiles.yml"),
      "version: 1\nprofiles:\n  ok:\n    roles:\n      smol: a/b\n  bad: 42\nactive: ok\n");
    const loaded = loadProfiles(tmp);
    expect(loaded.profiles["ok"]).toEqual({ roles: { smol: "a/b" }, scope: "project" });
    expect(loaded.active).toBe("ok");
  });

  test("splitSelector handles thinking suffixes and ambiguous tails", () => {
    expect(splitSelector("a/b:high")).toEqual({ base: "a/b", thinking: "high" });
    // Without a catalog predicate, `:max` reads as a thinking level (user intent wins).
    expect(splitSelector("a/b:max")).toEqual({ base: "a/b", thinking: "max" });
    // Unknown tails stay put.
    expect(splitSelector("a/b:weird")).toEqual({ base: "a/b:weird" });
    expect(splitSelector("openrouter/x/y@cerebras")).toEqual({ base: "openrouter/x/y@cerebras" });
  });

  test("cycleThinking walks a model's own options and wraps", () => {
    const muse = ["", "off", "auto", "minimal", "low", "medium", "high", "xhigh"].map(v => v || undefined);
    expect(cycleThinking(undefined, 1, muse)).toBe("off");
    expect(cycleThinking("xhigh", 1, muse)).toBeUndefined();
    expect(cycleThinking(undefined, -1, muse)).toBe("xhigh");
    // deepseek-flash style: only low · high · max
    const ds = [undefined, "off", "auto", "low", "high", "max"];
    expect(cycleThinking("low", 1, ds)).toBe("high");
    expect(cycleThinking("high", 2, ds)).toBeUndefined();
    expect(cycleThinking("high", 3, ds)).toBe("off");
    expect(cycleThinking("medium", 1, ds)).toBe("off");
  });

  test("thinkingOptions mirrors the model's declared efforts", () => {
    const muse = { provider: "p", id: "muse", reasoning: true, thinking: { efforts: ["minimal", "low", "high"] } };
    const ds = { provider: "p", id: "ds", reasoning: true, thinking: { efforts: ["low", "high", "max"] } };
    const plain = { provider: "p", id: "plain", reasoning: false };
    expect(thinkingOptions(muse as any)).toEqual([undefined, "off", "auto", "minimal", "low", "high"]);
    expect(thinkingOptions(ds as any)).toEqual([undefined, "off", "auto", "low", "high", "max"]);
    expect(thinkingOptions(plain as any)).toEqual([undefined]);
    expect(thinkingOptions(undefined)).toEqual([undefined]);
  });

  test("clampThinking prunes a level the model does not accept", () => {
    const ds = { provider: "p", id: "ds", reasoning: true, thinking: { efforts: ["low", "high", "max"] } };
    expect(clampThinking("xhigh", ds as any)).toBe("high");
    expect(clampThinking("minimal", ds as any)).toBe("low");
    expect(clampThinking("max", ds as any)).toBe("max");
    expect(clampThinking("off", ds as any)).toBe("off");
    expect(clampThinking(undefined, ds as any)).toBeUndefined();
    expect(clampThinking("high", undefined)).toBe("high");
  });

  test("withThinking re-attaches and drops suffixes", () => {
    expect(withThinking("a/b:high", "xhigh")).toBe("a/b:xhigh");
    expect(withThinking("a/b:high", undefined)).toBe("a/b");
    expect(withThinking("a/b", "low")).toBe("a/b:low");
  });

  test(":max is a thinking level unless a real model id matches it", () => {
    const literal = (sel: string) => sel === "zai/glm-4.7:max";
    expect(splitSelector("a/b:max", literal)).toEqual({ base: "a/b", thinking: "max" });
    expect(splitSelector("zai/glm-4.7:max", literal)).toEqual({ base: "zai/glm-4.7:max" });
    expect(withThinking("zai/glm-4.7:max", "high", literal)).toBe("zai/glm-4.7:max:high");
    expect(splitSelector("a/b:max", literal).thinking).toBe("max");
  });

  test("applying a profile sets the session thinking level from the default suffix", async () => {
    const levels: unknown[] = [];
    (fakePi as any).setThinkingLevel = (l: unknown) => levels.push(l);
    const res = await applyProfile(fakePi, makeCtx(), scope, { roles: { default: "prov-b/model-z:xhigh" } });
    expect(res.switchedThinking).toBe("xhigh");
    expect(levels).toEqual(["xhigh"]);
    expect(formatApplyResult("t", res)).toContain("live → prov-b/model-z:xhigh");
  });

  test("formatApplyResult reports counts, live switch and skips", () => {
    const s = formatApplyResult("w", {
      appliedRoles: ["default", "smol"], appliedAgents: ["explore"],
      skipped: [{ key: "@slow", reason: "no match" }], switchedDefault: "a/b",
    });
    expect(s).toContain('Profile "w" applied (2 roles, 1 agent, live → a/b)');
    expect(s).toContain("@slow (no match)");
  });
  test("saveProfiles writes to global or project scope based on parameter", () => {
    saveProfiles(tmp, { version: 1, profiles: { gprof: { roles: { smol: "prov-a/model-x" } } } }, "global", agentDir);
    expect(fs.existsSync(path.join(agentDir, "model-profiles.yml"))).toBe(true);

    saveProfiles(tmp, { version: 1, profiles: { pprof: { roles: { smol: "prov-b/model-y" } } } }, "project", agentDir);
    expect(fs.existsSync(path.join(tmp, ".omp", "model-profiles.yml"))).toBe(true);

    const merged = loadProfiles(tmp, agentDir);
    expect(merged.profiles["gprof"]).toEqual({ roles: { smol: "prov-a/model-x" }, scope: "global" });
    expect(merged.profiles["pprof"]).toEqual({ roles: { smol: "prov-b/model-y" }, scope: "project" });
  });

  test("project profile overrides global profile with same name", () => {
    saveProfiles(tmp, { version: 1, profiles: { shared: { roles: { default: "prov-a/model-x" } } } }, "global", agentDir);
    saveProfiles(tmp, { version: 1, profiles: { shared: { roles: { default: "prov-b/model-y" } } } }, "project", agentDir);

    const merged = loadProfiles(tmp, agentDir);
    expect(merged.profiles["shared"]).toEqual({ roles: { default: "prov-b/model-y" }, scope: "project" });
  });

  test("applyProfile respects targetScope: project vs global", async () => {
    await applyProfile(fakePi, makeCtx(), scope, { roles: { smol: "prov-a/model-x" } }, "project");
    expect(scope.getProjectModelRole("smol")).toBe("prov-a/model-x");

    await applyProfile(fakePi, makeCtx(), scope, { roles: { slow: "prov-b/model-z" } }, "global");
    expect(cfgModelRoles.get(scope)["slow"]).toBe("prov-b/model-z");
  });

  test("/profiles <name> project|global applies to specified target scope", async () => {
    saveProfiles(tmp, { version: 1, profiles: { testp: { roles: { smol: "prov-a/model-x" } } } });
    await commands["profiles"].handler("testp project", makeCtx());
    expect(scope.getProjectModelRole("smol")).toBe("prov-a/model-x");
    expect(notifications[0]?.message).toContain("[project]");

    await commands["profiles"].handler("testp global", makeCtx());
    expect(cfgModelRoles.get(scope)["smol"]).toBe("prov-a/model-x");
    expect(notifications[1]?.message).toContain("[global]");
  });
});

describe("sidebar menu items", () => {
  test("the create row is a real menu entry, kept last", () => {
    const items = profileMenuItems(["a", "b"]);
    expect(items).toEqual(["a", "b", NEW_PROFILE_ITEM]);
  });

  test("the create row is not a profile name", () => {
    expect(profileNameOf("a")).toBe("a");
    expect(profileNameOf(NEW_PROFILE_ITEM)).toBeUndefined();
    expect(profileNameOf(undefined)).toBeUndefined();
  });

  test("a typed profile name can never collide with the sentinel", () => {
    for (const name of ["new-profile", "+ New profile", "New profile", "\u0000", ""]) {
      expect(profileNameOf(name)).toBe(name === "" ? undefined : name);
    }
  });
});

describe("windowStart", () => {
  test("keeps short lists pinned to the top", () => {
    expect(windowStart(0, 3, 10)).toBe(0);
    expect(windowStart(2, 3, 10)).toBe(0);
  });

  test("centers the selection in long lists and clamps at both ends", () => {
    expect(windowStart(0, 100, 10)).toBe(0);
    expect(windowStart(5, 100, 10)).toBe(0);
    expect(windowStart(50, 100, 10)).toBe(45);
    expect(windowStart(99, 100, 10)).toBe(90);
  });

  test("never returns a negative start for an empty list", () => {
    expect(windowStart(0, 0, 10)).toBe(0);
  });
});

describe("auto level and chain collapse", () => {
  test("the auto level is not part of the model id", () => {
    expect(splitSelector("opencode-go/deepseek-v4.1-flash:auto")).toEqual({
      base: "opencode-go/deepseek-v4.1-flash",
      thinking: "auto",
    });
  });

  test("writing a level is idempotent for auto", () => {
    const once = withThinking("opencode-go/deepseek-v4.1-flash", "auto");
    expect(once).toBe("opencode-go/deepseek-v4.1-flash:auto");
    expect(withThinking(once, "auto")).toBe(once);
    expect(withThinking(once, "high")).toBe("opencode-go/deepseek-v4.1-flash:high");
    expect(withThinking(once, undefined)).toBe("opencode-go/deepseek-v4.1-flash");
  });

  test("a chain written by the old parser collapses to base + last level", () => {
    const junk = "opencode-go/deepseek-v4.1-flash:auto:auto:auto:auto:auto:high";
    expect(splitSelector(junk)).toEqual({ base: "opencode-go/deepseek-v4.1-flash", thinking: "high" });
    expect(withThinking(junk, "low")).toBe("opencode-go/deepseek-v4.1-flash:low");
    expect(withThinking(junk, undefined)).toBe("opencode-go/deepseek-v4.1-flash");
  });

  test("a literal model id ending in :max keeps its suffix", () => {
    const isLiteral = (s: string) => s === "zai/glm-4.7:max";
    expect(splitSelector("zai/glm-4.7:max", isLiteral)).toEqual({ base: "zai/glm-4.7:max" });
    expect(splitSelector("zai/glm-4.7:max:high", isLiteral)).toEqual({
      base: "zai/glm-4.7:max",
      thinking: "high",
    });
    expect(withThinking("zai/glm-4.7:max:high", "low", isLiteral)).toBe("zai/glm-4.7:max:low");
  });
});
