import { sameGit } from "./git.ts";
import { localModelChoices } from "./models.ts";
import { indexWorkspace, readSnapshot, type Snapshot } from "./status.ts";

export interface AutoUpdateSetting {
  readonly enabled: boolean;
  setEnabled: (enabled: boolean) => void | Promise<void>;
}

function eligible(snapshot: Snapshot) {
  return (
    snapshot.text === "zvec: stale" &&
    snapshot.indexed &&
    !snapshot.busy &&
    !snapshot.git?.operation &&
    snapshot.model?.startsWith("local/")
  );
}

export function createAutoUpdater(root: string, onError: () => unknown) {
  let enabled = false;
  let controller = new AbortController();
  let candidate: Snapshot | undefined;
  let candidateAt = 0;
  let nextAttemptAt = 0;

  return {
    get enabled() {
      return enabled;
    },
    setEnabled(value: boolean) {
      controller.abort();
      controller = new AbortController();
      enabled = value;
      candidate = undefined;
      nextAttemptAt = 0;
    },
    async update(snapshot: Snapshot, parentSignal: AbortSignal) {
      if (!enabled || parentSignal.aborted) return false;
      if (!eligible(snapshot) || Date.now() < nextAttemptAt) {
        candidate = undefined;
        return false;
      }
      if (!candidate || candidate.model !== snapshot.model || !sameGit(candidate.git, snapshot.git)) {
        candidate = snapshot;
        candidateAt = Date.now();
        return false;
      }
      // Use existing status polls: require two stable samples at least five seconds apart.
      if (Date.now() - candidateAt < 5000) return false;
      candidate = undefined;
      const current = controller;
      const signal = AbortSignal.any([parentSignal, current.signal]);
      let submitted = false;
      try {
        const choices = await localModelChoices(process.env, undefined, signal, snapshot.model);
        if (choices.find((choice) => choice.model === snapshot.model)?.status !== "Downloaded") return false;
        const latest = await readSnapshot(root, signal);
        signal.throwIfAborted();
        if (!eligible(latest) || latest.model !== snapshot.model || !sameGit(snapshot.git, latest.git)) return false;
        submitted = true;
        await indexWorkspace(root, {}, signal);
        nextAttemptAt = Date.now() + 60_000;
        return true;
      } catch {
        if (!submitted && parentSignal.aborted) return false;
        if (current === controller) {
          enabled = false;
          await onError();
        }
        return false;
      }
    },
  };
}
