import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface GitContext {
  root: string;
  branch?: string;
  head?: string;
  dirty?: boolean;
  operation?: string;
  stateId?: string;
}

export async function runGit(cwd: string, args: string[], signal: AbortSignal) {
  signal.throwIfAborted();
  try {
    const { stdout } = await exec("git", ["--no-optional-locks", "-C", cwd, ...args], {
      signal, timeout: 2000, maxBuffer: 1024 * 1024, windowsHide: true,
      env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_COMMON_DIR: undefined, GIT_INDEX_FILE: undefined },
    });
    return stdout;
  } catch {
    signal.throwIfAborted();
    return undefined;
  }
}

export async function readGit(cwd: string, signal: AbortSignal): Promise<GitContext | undefined> {
  const [rootOutput, statusOutput, gitDirOutput] = await Promise.all([
    runGit(cwd, ["rev-parse", "--show-toplevel"], signal),
    runGit(cwd, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal"], signal),
    runGit(cwd, ["rev-parse", "--absolute-git-dir"], signal),
  ]);
  if (!rootOutput || statusOutput === undefined || !gitDirOutput) return;
  const fields = statusOutput.split("\0");
  const head = fields.find((field) => field.startsWith("# branch.oid "))?.slice(13);
  const branch = fields.find((field) => field.startsWith("# branch.head "))?.slice(14);
  if (!head || !branch) return;
  const markers = [
    ["rebase-merge", "rebase"], ["rebase-apply", "rebase"], ["MERGE_HEAD", "merge"],
    ["CHERRY_PICK_HEAD", "cherry-pick"], ["REVERT_HEAD", "revert"], ["BISECT_LOG", "bisect"],
  ];
  const operations = await Promise.all(markers.map(async ([path, operation]) => {
    try { await stat(join(gitDirOutput.replace(/\r?\n$/, ""), path)); return operation; }
    catch (error) {
      return error && typeof error === "object" && "code" in error && error.code === "ENOENT" ? undefined : "unknown";
    }
  }));
  signal.throwIfAborted();
  return {
    root: rootOutput.replace(/\r?\n$/, ""),
    branch: branch === "(detached)" ? undefined : branch,
    head: head === "(initial)" ? undefined : head,
    dirty: fields.some((field) => /^(1 |2 |u |\? )/.test(field)),
    operation: operations.find(Boolean),
    stateId: createHash("sha256").update(statusOutput).digest("hex"),
  };
}

export function sameGit(a: GitContext | undefined, b: GitContext | undefined) {
  return a?.root === b?.root && a?.branch === b?.branch && a?.head === b?.head &&
    a?.dirty === b?.dirty && a?.operation === b?.operation && a?.stateId === b?.stateId;
}

export interface Worktree { root: string; branch?: string; head?: string; bare: boolean; prunable: boolean; }

export async function readWorktrees(cwd: string, signal: AbortSignal): Promise<Worktree[]> {
  const output = await runGit(cwd, ["worktree", "list", "--porcelain", "-z"], signal);
  if (output === undefined) throw new Error("Cannot list Git worktrees.");
  return output.split("\0\0").filter(Boolean).map((record) => {
    const fields = record.split("\0");
    const root = fields.find((field) => field.startsWith("worktree "))?.slice(9);
    if (!root) throw new Error("Invalid Git worktree list.");
    return {
      root,
      branch: fields.find((field) => field.startsWith("branch refs/heads/"))?.slice(18),
      head: fields.find((field) => field.startsWith("HEAD "))?.slice(5),
      bare: fields.includes("bare"),
      prunable: fields.some((field) => field === "prunable" || field.startsWith("prunable ")),
    };
  });
}
