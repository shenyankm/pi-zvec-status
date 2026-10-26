import assert from "node:assert/strict";
import { execFile, type ChildProcess } from "node:child_process";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import { readGit, sameGit, readWorktrees } from "../lib/git.ts";
import { indexActions } from "../lib/menu.ts";
import { showWorktreeOverview } from "../lib/worktrees.ts";
import { formatStatus } from "../lib/display.ts";
import { readSnapshot } from "../lib/status.ts";
import { openPanel } from "../lib/panel.ts";
import { cacheFixture, mockServer, setEnv } from "./helpers.ts";

const exec = promisify(execFile);
const plain = { fg: (_color: string, text: string) => text };

async function repository(t: TestContext) {
  const { home } = await cacheFixture(t);
  const root = join(home, "main-tree");
  await mkdir(root);
  const git = async (cwd: string, ...args: string[]) =>
    (
      await exec("git", [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.autocrlf=false",
        "-c",
        `core.hooksPath=${join(home, "no-hooks")}`,
        "-C",
        cwd,
        ...args,
      ])
    ).stdout.trim();
  await git(root, "init", "--initial-branch=main");
  return { home, root, git, signal: () => AbortSignal.timeout(5000) };
}

test("unborn branches and subdirectories retain the worktree root", async (t) => {
  const { root, git, signal } = await repository(t);
  const sub = join(root, "src");
  await mkdir(sub);
  const unborn = await readGit(sub, signal());
  assert.equal(unborn?.branch, "main");
  assert.equal(unborn?.head, undefined);
  assert.equal(await realpath(unborn!.root), await realpath(root));
  await git(root, "commit", "--allow-empty", "-m", "initial");
  const committed = await readGit(sub, signal());
  assert.equal(committed?.branch, "main");
  assert.match(committed!.head!, /^[a-f0-9]{40,64}$/);
  assert.equal(sameGit(unborn, committed), false);
});

test("upstream progress does not change local identity; local edits still do", async (t) => {
  const { root, git, signal } = await repository(t);
  await git(root, "commit", "--allow-empty", "-m", "initial");
  await git(root, "branch", "upstream");
  await git(root, "branch", "--set-upstream-to=upstream", "main");
  await git(root, "commit", "--allow-empty", "-m", "local one");
  await git(root, "commit", "--allow-empty", "-m", "local two");
  const before = await readGit(root, signal());
  assert.equal(before?.branch, "main");
  assert.equal(before?.dirty, false);
  await git(root, "update-ref", "refs/heads/upstream", "HEAD^");
  assert.equal(sameGit(before, await readGit(root, signal())), true);
  await writeFile(join(root, "untracked.txt"), "local edit\n");
  const edited = await readGit(root, signal());
  assert.equal(edited?.dirty, true);
  assert.equal(sameGit(before, edited), false);
  await git(root, "commit", "--allow-empty", "-m", "new HEAD");
  assert.equal(sameGit(edited, await readGit(root, signal())), false);
});

test("linked worktrees have independent branches and identities; detached HEAD is explicit", async (t) => {
  const { home, root, git, signal } = await repository(t);
  await git(root, "commit", "--allow-empty", "-m", "initial");
  const worktree = join(home, "功能 worktree");
  await git(root, "worktree", "add", "-b", "feature/login", worktree);
  const main = await readGit(root, signal());
  const feature = await readGit(worktree, signal());
  assert.equal(main?.branch, "main");
  assert.equal(feature?.branch, "feature/login");
  assert.equal(main?.head, feature?.head, "same commit must not collapse different worktrees");
  assert.equal(sameGit(main, feature), false);
  assert.equal(await realpath(feature!.root), await realpath(worktree));
  assert.match(formatStatus("zvec: ready", plain, feature), /feature\/login @ 功能 worktree/);
  await git(worktree, "checkout", "--detach", "HEAD");
  const detached = await readGit(worktree, signal());
  assert.equal(detached?.branch, undefined);
  assert.equal(detached?.head, feature?.head);
  assert.equal(sameGit(feature, detached), false);
  assert.ok(formatStatus("zvec: ready", plain, detached).includes(`detached@${detached!.head!.slice(0, 7)}`));
});

for (const suffix of ["\r", "\n\r", "\n"]) {
  test(`Git roots preserve trailing control characters ${JSON.stringify(suffix)}`, { skip: process.platform === "win32" }, async (t) => {
    const { home, root, git, signal } = await repository(t);
    const checkout = join(home, "checkout" + suffix);
    await git(root, "init", "--initial-branch=main", checkout);
    const context = await readGit(checkout, signal());
    assert.equal(context?.root, await realpath(checkout));
    await writeFile(join(checkout, ".git", "MERGE_HEAD"), "test");
    assert.equal((await readGit(checkout, signal()))?.operation, "merge");
  });
}

test("a branch named (detached) is distinct from detached HEAD at the same commit", async (t) => {
  const { root, git, signal } = await repository(t);
  await git(root, "commit", "--allow-empty", "-m", "initial");
  await git(root, "checkout", "-b", "(detached)");
  const attached = await readGit(root, signal());
  assert.equal(attached?.branch, "(detached)");
  await git(root, "checkout", "--detach", "HEAD");
  const detached = await readGit(root, signal());
  assert.equal(detached?.branch, undefined);
  assert.equal(attached?.head, detached?.head);
  assert.equal(sameGit(attached, detached), false);
});

test("non-Git directories and missing Git do not break status rendering", async (t) => {
  const { home } = await cacheFixture(t);
  assert.equal(await readGit(home, AbortSignal.timeout(3000)), undefined);
  const { env } = await mockServer(t, {
    result: {
      content: [],
      structuredContent: {
        root: home,
        indexed: false,
      },
    },
  });
  setEnv(t, { PATH: "" });
  const snapshot = await readSnapshot(home, AbortSignal.timeout(3000), env);
  assert.equal(snapshot.text, "zvec: no index");
  assert.equal(snapshot.git?.unavailable, true);
  assert.ok(!indexActions(snapshot).includes("Create index"));
  assert.match(snapshot.details, /Git: Not available/);
  assert.equal(formatStatus(snapshot.text, plain), "○ zvec · no index");
});

test("repository environment overrides cannot point the display at another worktree", async (t) => {
  const { root, signal } = await repository(t);
  setEnv(t, { GIT_DIR: join(root, "missing.git"), GIT_WORK_TREE: "/wrong", GIT_COMMON_DIR: "/wrong" });
  const context = await readGit(root, signal());
  assert.equal(context?.branch, "main");
  assert.equal(basename(context!.root), "main-tree");
});

test("aborted Git reads reject rather than returning a non-Git result", async (t) => {
  const { root } = await repository(t);
  await assert.rejects(readGit(root, AbortSignal.abort()), { name: "AbortError" });
});

test("a snapshot uses four Git processes and one read-only MCP call", async (t) => {
  const { root, signal } = await repository(t);
  const { env, calls } = await mockServer(t, {
    result: { content: [], structuredContent: { root, indexed: true, status: "ready" } },
  });
  const children: ChildProcess[] = [];
  const onSpawn = (message: unknown) => children.push((message as { process: ChildProcess }).process);
  subscribe("child_process", onSpawn);
  try {
    assert.equal((await readSnapshot(root, signal(), env)).text, "zvec: ready");
  } finally {
    unsubscribe("child_process", onSpawn);
  }
  assert.equal(children.length, 4);
  assert.equal(children.filter((child) => child.spawnargs.includes("rev-parse")).length, 2);
  const statuses = children.filter((child) => child.spawnargs.includes("status"));
  assert.equal(statuses.length, 2);
  assert.ok(statuses.every((child) => child.spawnargs.includes("--no-ahead-behind")));
  assert.equal(calls.filter((call) => call.message?.method === "tools/call").length, 1);
  assert.ok(calls.some((call) => call.message?.params?.name === "zvec_grep_index_status"));
});

for (const failedRead of [1, 2]) {
  test(`a failed Git read (${failedRead}) is not evidence of a branch change`, async (t) => {
    const { root, signal } = await repository(t);
    const { env } = await mockServer(t, {
      result: { content: [], structuredContent: { root, indexed: true, status: "ready" } },
    });
    let statuses = 0;
    const onSpawn = (message: unknown) => {
      const child = (message as { process: ChildProcess }).process;
      child.once("spawn", () => {
        if (child.spawnargs.includes("status") && ++statuses === failedRead) child.kill();
      });
    };
    subscribe("child_process", onSpawn);
    try {
      const snapshot = await readSnapshot(root, signal(), env);
      assert.equal(snapshot.text, "zvec: ready");
      assert.doesNotMatch(snapshot.details, /Changed during query/);
      assert.match(snapshot.details, /Git: Not available/);
      assert.equal(snapshot.git?.operation, "unknown");
      assert.ok(!indexActions(snapshot).includes("Update index (incremental)"));
    } finally {
      unsubscribe("child_process", onSpawn);
    }
  });
}

test("a branch switch during a daemon query cannot label its response ready", async (t) => {
  const { root, git, signal } = await repository(t);
  await git(root, "commit", "--allow-empty", "-m", "initial");
  let switched = false;
  const { env } = await mockServer(t, async () => {
    if (!switched) {
      switched = true;
      await git(root, "checkout", "-b", "feature/new");
    }
    return { result: { content: [], structuredContent: { root, indexed: true, status: "ready" } } };
  });
  const snapshot = await readSnapshot(root, signal(), env);
  assert.equal(snapshot.text, "zvec: unknown");
  assert.equal(snapshot.git?.branch, "feature/new");
  assert.match(snapshot.details, /Changed during query; refresh status/);
  const stable = await readSnapshot(root, signal(), env);
  assert.equal(stable.text, "zvec: ready");
  assert.match(stable.details, /Branch: feature\/new/);
  assert.match(stable.details, /HEAD: [a-f0-9]{12}/);
});

test("the actual footer follows branch and detached HEAD changes without changing the query root", async (t) => {
  const { root, git } = await repository(t);
  await git(root, "commit", "--allow-empty", "-m", "initial");
  const { env, calls } = await mockServer(t, {
    result: { content: [], structuredContent: { root, indexed: true, status: "ready" } },
  });
  setEnv(t, { ...env, ZVEC_GREP_SERVER_TOKEN_FILE: undefined });
  type Handler = (_event: Record<string, never>, ctx: ExtensionContext) => Promise<void>;
  const handlers = new Map<string, Handler>();
  let open!: (_args: string, ctx: ExtensionContext) => Promise<void>;
  extension({
    on: (name: string, handler: Handler) => {
      handlers.set(name, handler);
    },
    registerCommand: (_name: string, command: { handler: typeof open }) => {
      open = command.handler;
    },
  } as unknown as ExtensionAPI);
  const statuses: (string | undefined)[] = [];
  const ctx = {
    mode: "tui",
    cwd: root,
    ui: {
      theme: plain,
      setStatus: (_key: string, value: string | undefined) => statuses.push(value),
      custom: async () => "Close",
      notify: () => assert.fail("no errors expected"),
    },
  } as unknown as ExtensionContext;
  t.after(() => handlers.get("session_shutdown")!({}, ctx));
  await handlers.get("session_start")!({}, ctx);
  await open("", ctx);
  assert.match(statuses.at(-1)!, /main @ main-tree · ready \(last check\)/);
  await git(root, "checkout", "-b", "feature/new");
  await open("", ctx);
  assert.match(statuses.at(-1)!, /feature\/new @ main-tree · ready \(last check\)/);
  await git(root, "checkout", "--detach", "HEAD");
  await open("", ctx);
  assert.match(statuses.at(-1)!, /detached@[a-f0-9]{7} @ main-tree/);
  const queries = calls.filter((call) => call.message?.params?.name === "zvec_grep_index_status");
  assert.ok(queries.every((call) => call.message?.params?.arguments?.root === root));
});

test("switching branches during confirmation prevents index submission", async (t) => {
  const { root, git, signal } = await repository(t);
  await git(root, "commit", "--allow-empty", "-m", "initial");
  const { env, calls } = await mockServer(t, {
    result: {
      content: [],
      structuredContent: {
        root,
        indexed: true,
        status: "ready",
        persistent: { workspace_index: { embedding: { provider: "remote", model: "existing" } } },
      },
    },
  });
  setEnv(t, { ...env, ZVEC_GREP_SERVER_TOKEN_FILE: undefined });
  const notifications: string[] = [];
  let menus = 0;
  await openPanel(
    {
      cwd: root,
      ui: {
        custom: async () => (menus++ === 0 ? "Update index (incremental)" : "Close"),
        confirm: async (_title: string, message: string) => {
          assert.match(message, /Branch: main/);
          await git(root, "checkout", "-b", "feature/changed");
          return true;
        },
        notify: (message: string) => notifications.push(message),
      },
    } as unknown as ExtensionContext,
    signal(),
  );
  assert.match(notifications[0], /state has changed/);
  assert.equal(calls.filter((call) => call.message?.params?.name === "zvec_grep_index").length, 0);
});

test("real merge, cherry-pick and rebase conflicts are visible and disable writes", async (t) => {
  const { root, git, signal } = await repository(t);
  await writeFile(join(root, "conflict.txt"), "base\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "base");
  await git(root, "checkout", "-b", "feature");
  await writeFile(join(root, "conflict.txt"), "feature\n");
  await git(root, "commit", "-am", "feature");
  const featureHead = await git(root, "rev-parse", "HEAD");
  await git(root, "checkout", "main");
  await writeFile(join(root, "conflict.txt"), "main\n");
  await git(root, "commit", "-am", "main");
  for (const [command, argument, operation] of [
    ["merge", "feature", "merge"],
    ["cherry-pick", featureHead, "cherry-pick"],
    ["rebase", "feature", "rebase"],
  ]) {
    await assert.rejects(git(root, command, argument));
    const context = await readGit(root, signal());
    assert.equal(context?.operation, operation);
    assert.equal(context?.dirty, true);
    assert.match(formatStatus("zvec: ready", plain, context), new RegExp(`\\[${operation}\\]`));
    assert.doesNotMatch(
      indexActions({ text: "zvec: ready", details: "", indexed: true, busy: false, git: context }).join("\n"),
      /Rebuild index|Update index/,
    );
    await git(root, command, "--abort");
    assert.equal((await readGit(root, signal()))?.operation, undefined);
  }
});

test("submodules, nested repositories and sparse checkouts use their own Git roots", async (t) => {
  const { home, root, git, signal } = await repository(t);
  await mkdir(join(root, "src"));
  await mkdir(join(root, "excluded"));
  await writeFile(join(root, "src", "a.txt"), "visible\n");
  await writeFile(join(root, "excluded", "b.txt"), "sparse\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "sparse fixture");
  await git(root, "sparse-checkout", "init", "--cone");
  await git(root, "sparse-checkout", "set", "src");
  assert.equal((await readGit(root, signal()))?.dirty, false);
  await writeFile(join(root, "src", "a.txt"), "changed\n");
  assert.equal((await readGit(root, signal()))?.dirty, true);
  await git(root, "checkout", "--", "src/a.txt");
  await git(root, "sparse-checkout", "disable");
  const module = join(home, "module-source");
  await mkdir(module);
  await git(module, "init", "--initial-branch=main");
  await git(module, "commit", "--allow-empty", "-m", "module");
  await git(root, "-c", "protocol.file.allow=always", "submodule", "add", module, "modules/lib");
  const inside = join(root, "modules", "lib");
  assert.equal(await realpath((await readGit(inside, signal()))!.root), await realpath(inside));
  const nested = join(root, "nested");
  await mkdir(nested);
  await git(nested, "init", "--initial-branch=nested");
  assert.equal((await readGit(nested, signal()))?.branch, "nested");
});

test("worktree move, missing paths, prune, recreation and bare repositories remain distinguishable", async (t) => {
  const { home, root, git, signal } = await repository(t);
  await git(root, "commit", "--allow-empty", "-m", "initial");
  const name = process.platform === "win32" ? "tree with space" : "tree with\nnewline";
  const original = join(home, name);
  const moved = join(home, "moved 工作树");
  await git(root, "worktree", "add", "-b", "linked", original);
  assert.ok((await readWorktrees(root, signal())).some((tree) => tree.root.endsWith(name)));
  const originalContext = await readGit(original, signal());
  assert.equal(await realpath(originalContext!.root), await realpath(original));
  assert.equal(originalContext?.branch, "linked");
  await git(root, "worktree", "move", original, moved);
  assert.ok((await readWorktrees(root, signal())).some((tree) => tree.root.endsWith("moved 工作树")));
  await rm(moved, { recursive: true, force: true });
  assert.ok((await readWorktrees(root, signal())).some((tree) => tree.prunable));
  await git(root, "worktree", "prune");
  await git(root, "worktree", "add", "-b", "recreated", moved);
  assert.equal((await readGit(moved, signal()))?.branch, "recreated");
  const bare = join(home, "bare.git");
  await git(root, "clone", "--bare", root, bare);
  assert.ok((await readWorktrees(bare, signal())).some((tree) => tree.bare));
});

test("separate Git directories resolve to checkouts, never Git internals", async (t) => {
  const { home, root, git, signal } = await repository(t);
  const checkout = join(home, "checkout");
  const gitDir = join(home, "repo.git");
  await git(root, "init", "--initial-branch=main", "--separate-git-dir", gitDir, checkout);
  await git(checkout, "commit", "--allow-empty", "-m", "initial");
  const linked = join(home, "linked");
  await git(checkout, "worktree", "add", "-b", "linked", linked);
  const mainTrees = await readWorktrees(checkout, signal());
  assert.deepEqual(mainTrees.map((tree) => tree.root).sort(), [await realpath(checkout), await realpath(linked)].sort());
  const linkedTrees = await readWorktrees(linked, signal());
  assert.deepEqual(linkedTrees.map((tree) => tree.root), [await realpath(linked)]);
});

test("worktree overview pages real worktrees and bounds status concurrency to four", { timeout: 30000 }, async (t) => {
  const { home, root, git } = await repository(t);
  await git(root, "commit", "--allow-empty", "-m", "initial");
  for (let index = 0; index < 22; index++) await git(root, "worktree", "add", "--detach", join(home, `tree-${index}`));
  let active = 0;
  let peak = 0;
  const { env, calls } = await mockServer(t, async (message) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active--;
    return { result: { content: [], structuredContent: { root: message.params?.arguments?.root, indexed: false } } };
  });
  setEnv(t, { ...env, ZVEC_GREP_SERVER_TOKEN_FILE: undefined });
  let pages = 0;
  const ctx = {
    cwd: root,
    ui: {
      select: async (title: string, labels: string[]) => {
        assert.match(title, /read-only/);
        assert.ok(labels.some((label) => label.includes("no index")));
        return pages++ === 0 ? "Next page" : "Close";
      },
      notify: () => assert.fail("overview must succeed"),
    },
  } as unknown as ExtensionContext;
  await showWorktreeOverview(ctx, AbortSignal.timeout(15000));
  assert.equal(pages, 2);
  assert.ok(peak <= 4);
  assert.equal(calls.filter((call) => call.message?.params?.name === "zvec_grep_index_status").length, 23);
  assert.equal(calls.filter((call) => call.message?.params?.name === "zvec_grep_index").length, 0);
});

test("worktree page deadlines leave timed-out rows unavailable and unstarted rows not checked", async (t) => {
  const { home, root, git } = await repository(t);
  await git(root, "commit", "--allow-empty", "-m", "initial");
  for (let index = 0; index < 4; index++) await git(root, "worktree", "add", "--detach", join(home, `tree-${index}`));
  const { env } = await mockServer(t, async (message) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return {
      result: {
        content: [],
        structuredContent: { root: message.params?.arguments?.root, indexed: true, status: "ready" },
      },
    };
  });
  setEnv(t, { ...env, ZVEC_GREP_SERVER_TOKEN_FILE: undefined });
  const signal = AbortSignal.timeout(5000);
  const timeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, "timeout", (ms: number) => timeout(ms === 10_000 ? 50 : ms));
  let labels: string[] = [];
  await showWorktreeOverview(
    {
      cwd: root,
      ui: {
        select: async (_title: string, options: string[]) => {
          labels = options;
          return "Close";
        },
        notify: () => assert.fail("page timeout must not close the overview"),
      },
    } as unknown as ExtensionContext,
    signal,
  );
  assert.equal(labels.filter((label) => label.includes("[unavailable]")).length, 4);
  assert.equal(labels.filter((label) => label.includes("[not checked]")).length, 1);
  assert.ok(labels.every((label) => !label.includes("[ready]")));
});

test(
  "worktree Back reuses the page; details, refresh and page changes read fresh status",
  { timeout: 30000 },
  async (t) => {
    const { home, root, git } = await repository(t);
    await git(root, "commit", "--allow-empty", "-m", "initial");
    for (let index = 0; index < 19; index++)
      await git(root, "worktree", "add", "--detach", join(home, `tree-${index}`));
    let status = "ready";
    const { env, calls } = await mockServer(t, (message) => ({
      result: { content: [], structuredContent: { root: message.params?.arguments?.root, indexed: true, status } },
    }));
    setEnv(t, { ...env, ZVEC_GREP_SERVER_TOKEN_FILE: undefined });
    let step = 0;
    const expectedCalls = [20, 21, 21, 22, 22, 42, 43, 63];
    const ctx = {
      cwd: root,
      ui: {
        select: async (title: string, labels: string[]) => {
          const current = step++;
          assert.equal(calls.filter((call) => call.message?.method === "tools/call").length, expectedCalls[current]);
          if (current === 1 || current === 3) {
            assert.match(title, current === 1 ? /Status: ready/ : /Status: stale/);
            status = "stale";
            return "Back";
          }
          assert.match(title, /read-only snapshot/);
          if (current < 4) {
            assert.match(labels[0], /\[ready\]/);
            return labels[0];
          }
          if (current === 4) {
            await git(root, "worktree", "add", "--detach", join(home, "new-tree"));
            return "Refresh overview";
          }
          assert.match(title, /\/ 21 /);
          assert.match(labels[0], /\[stale\]/);
          return current === 5 ? "Next page" : current === 6 ? "Previous page" : "Close";
        },
        notify: () => assert.fail("overview must succeed"),
      },
    } as unknown as ExtensionContext;
    await showWorktreeOverview(ctx, AbortSignal.timeout(15000));
    assert.equal(step, expectedCalls.length);
    assert.equal(calls.filter((call) => call.message?.params?.name === "zvec_grep_index").length, 0);
  },
);
