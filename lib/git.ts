import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface GitContext {
  root: string;
  branch?: string;
  head?: string;
}

export async function readGit(cwd: string, signal: AbortSignal): Promise<GitContext | undefined> {
  signal.throwIfAborted();
  const run = async (args: string[]) => {
    try {
      const { stdout } = await exec("git", ["--no-optional-locks", "-C", cwd, ...args], {
        signal, timeout: 2000, maxBuffer: 64 * 1024, windowsHide: true,
        env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_COMMON_DIR: undefined, GIT_INDEX_FILE: undefined },
      });
      return stdout.replace(/\r?\n$/, "");
    } catch (error) {
      signal.throwIfAborted();
      if (args[0] === "symbolic-ref" && error && typeof error === "object" && "code" in error && error.code === 1) return "";
      return undefined;
    }
  };
  const [root, branch, head] = await Promise.all([
    run(["rev-parse", "--show-toplevel"]),
    run(["symbolic-ref", "--quiet", "--short", "HEAD"]),
    run(["rev-parse", "--verify", "HEAD"]),
  ]);
  return root && branch !== undefined && (branch || head) ? { root, branch: branch || undefined, head } : undefined;
}

export function sameGit(a: GitContext | undefined, b: GitContext | undefined) {
  return a?.root === b?.root && a?.branch === b?.branch && a?.head === b?.head;
}
