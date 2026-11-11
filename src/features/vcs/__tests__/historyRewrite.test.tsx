import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Branch, BranchInfo, Commit, LogDetails, Settings, VcsRoot } from "@/bindings";

/**
 * History rewriting (Fixup…, Drop, Squash, Edit Commit Message, Interactively Rebase)
 * for commits that another branch contains (#2799): a commit of an open PR's branch
 * (origin/abc) is rewritten by checking out the branch that holds it when it is not on
 * the current branch, as long as its history down to the commit is linear.
 */
const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  ask: vi.fn(),
  notify: vi.fn(),
  showError: vi.fn(),
  openCommit: vi.fn(),
  checkout: vi.fn(),
  operation: vi.fn(),
  reword: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  Channel: class {
    onmessage: (line: string) => void = () => {};
  },
}));
vi.mock("@/workbench/contributions", () => ({
  notifications: () => ({ notify: mocks.notify, expire: vi.fn() }),
  maybeEditorService: () => undefined,
  toolWindowService: () => ({ show: vi.fn() }),
}));
vi.mock("@/workbench/messages", async (original) => ({
  ...(await original<typeof import("@/workbench/messages")>()),
  showError: mocks.showError,
  ask: mocks.ask,
}));
vi.mock("../dialogs", async (original) => ({
  ...(await original<typeof import("../dialogs")>()),
  confirmDialog: mocks.confirm,
}));
vi.mock("../commitUi", async (original) => ({
  ...(await original<typeof import("../commitUi")>()),
  openCommit: mocks.openCommit,
}));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => false,
    commands: {
      ...real.commands,
      vcsRoots: async () => ({ status: "ok" as const, data: [{ root: "/p", operation: null }] as VcsRoot[] }),
      vcsStatus: async () => ({ status: "ok" as const, data: [] }),
      vcsStashes: async () => ({ status: "ok" as const, data: [] }),
      vcsBranchInfo: async () => ({ status: "ok" as const, data: branchInfo() }),
      vcsBranches: async () => ({ status: "ok" as const, data: branchList() }),
      vcsCheckout: (...args: unknown[]) => mocks.checkout(...args),
      vcsOperation: (...args: unknown[]) => mocks.operation(...args),
      vcsReword: (...args: unknown[]) => mocks.reword(...args),
      vcsMergeBase: async (_repo: unknown, a: string, b: string) => ({ status: "ok" as const, data: mergeBase(a, b) }),
      vcsLog: async (_repo: unknown, q: { branch: string | null; range?: string | null }) => ({
        status: "ok" as const,
        data: log(q.branch, q.range ?? null),
      }),
      vcsLogDetailsBatch: async (_repo: unknown, revisions: string[]) => ({
        status: "ok" as const,
        data: revisions.map(details),
      }),
    },
  };
});

import { dropCommits, prepareFixup, rebaseAfterFixup } from "../rebase";
import { useCommit } from "../commitStore";
import { useVcs } from "../store";
import { useProject } from "@/platform/project";

// --- the reporter's repository: main checked out, the PR's branch abc holds the commits ---

const M0 = commit("m0ffffffffffffffffffffffffffffffff", ["m0root"]);
const A1 = commit("a1ffffffffffffffffffffffffffffffff", ["m0ffffffffffffffffffffffffffffffff"]);
const A2 = commit("a2ffffffffffffffffffffffffffffffff", ["a1ffffffffffffffffffffffffffffffff"]);

function commit(id: string, parents: string[], summary = id.slice(0, 2).toUpperCase()): Commit {
  return {
    id,
    shortId: id.slice(0, 8),
    parents,
    author: "A",
    email: "a@x",
    timeMs: 0,
    summary,
    message: summary,
    refs: [],
  };
}

/** The repository the queries answer from; the mocked checkout flips `checkedOut`. */
const repo: {
  checkedOut: string;
  logs: Record<string, Commit[]>;
  containing: string[];
  localAbc: boolean;
  extra: Branch[];
} = {
  checkedOut: "main",
  logs: {},
  containing: [],
  localAbc: true,
  extra: [],
};

function branch(name: string, remote: boolean, commitId: string, upstream: string | null = null): Branch {
  return {
    name,
    remote,
    current: !remote && name === repo.checkedOut,
    upstream,
    ahead: 0,
    behind: 0,
    lastCommitMs: null,
    commit: commitId,
  };
}

const branchList = (): Branch[] => [
  branch("main", false, M0.id),
  ...(repo.localAbc ? [branch("abc", false, A2.id, "origin/abc")] : []),
  branch("origin/abc", true, A2.id),
  ...repo.extra,
];

const branchInfo = (): BranchInfo => ({
  head: repo.checkedOut,
  headCommit: repo.checkedOut === "abc" ? A2.id : M0.id,
  upstream: repo.checkedOut === "abc" ? "origin/abc" : null,
  ahead: 0,
  behind: 0,
  operation: null,
});

/** The commits reachable from `rev` (HEAD, a branch name or a commit id), newest first. */
const reach = (rev: string): Commit[] => {
  if (rev === "HEAD") return logOf(repo.checkedOut);
  if (repo.logs[rev]) return repo.logs[rev];
  for (const commits of Object.values(repo.logs)) {
    const i = commits.findIndex((c) => c.id === rev);
    if (i >= 0) return commits.slice(i);
  }
  return [];
};

const logOf = (name: string): Commit[] => repo.logs[name] ?? [];

const log = (branch: string | null, range: string | null): Commit[] => {
  const commits = reach(branch ?? "HEAD");
  if (!range) return commits;
  const [excluded, included] = range.split("..") as [string, string];
  const gone = new Set(reach(excluded).map((c) => c.id));
  return reach(included).filter((c) => !gone.has(c.id));
};

const mergeBase = (a: string, b: string): string | null => {
  const history = new Set(reach(a).map((c) => c.id));
  for (const c of reach(b)) if (history.has(c.id)) return c.id;
  return null;
};

const details = (id: string): LogDetails => ({
  message: id.slice(0, 2).toUpperCase(),
  containingBranches: repo.containing,
  signature: "N",
  signer: "",
  key: "",
  fingerprint: "",
});

beforeEach(() => {
  vi.resetAllMocks();
  repo.checkedOut = "main";
  repo.logs = { main: [M0], abc: [A2, A1], "origin/abc": [A2, A1] };
  repo.containing = ["abc", "origin/abc"];
  repo.localAbc = true;
  repo.extra = [];
  mocks.confirm.mockResolvedValue(true);
  mocks.ask.mockResolvedValue({ button: "drop", checked: false });
  mocks.checkout.mockImplementation(async (_repoArg: unknown, rev: string) => {
    repo.checkedOut = rev === "origin/abc" ? "abc" : rev;
    useVcs.setState({ branch: branchInfo(), branches: branchList() });
    return { status: "ok" as const, data: { kind: "done", files: [], local: null, remote: null } };
  });
  mocks.operation.mockResolvedValue({ status: "ok" as const, data: null });
  useVcs.setState({
    available: true,
    root: "/p",
    repo: "/p",
    roots: ["/p"],
    branch: branchInfo(),
    branches: branchList(),
    branchesLoaded: true,
    stashesLoaded: true,
    status: [],
    operations: {},
  });
  useProject.setState({ settings: null });
  useCommit.setState({ message: "", fixupTarget: null });
});

const rebaseOp = () =>
  mocks.operation.mock.calls.at(-1)?.[2] as { op: string; base: string; entries: { commit: string; action: string }[] };

describe("history rewriting of a commit another branch contains (#2799)", () => {
  it("drops a commit of the PR's branch by checking out the branch that holds it", async () => {
    await dropCommits([A1]);
    expect(mocks.showError).not.toHaveBeenCalled();
    // The switch was offered and, once confirmed, checked the PR branch out.
    expect(mocks.confirm.mock.calls[0]?.[0]).toMatchObject({
      title: "Drop commit",
      message: expect.stringContaining("on 'abc'"),
    });
    expect(mocks.checkout).toHaveBeenCalledWith("/p", "abc", false, expect.anything());
    expect(repo.checkedOut).toBe("abc");
    // The rebase rewrites the checked-out branch's linear history from the commit.
    const op = rebaseOp();
    expect(op.op).toBe("interactiveRebase");
    expect(op.base).toBe(M0.id);
    expect(op.entries).toEqual([
      { commit: A1.id, action: "drop", message: null },
      { commit: A2.id, action: "pick", message: null },
    ]);
  });

  it("prepares a fixup on the branch that holds the target and autosquashes it there", async () => {
    await prepareFixup(A1, "fixup");
    expect(repo.checkedOut).toBe("abc");
    expect(useCommit.getState().fixupTarget).toEqual(A1);
    expect(useCommit.getState().message).toBe(`fixup! ${A1.summary}`);
    expect(mocks.openCommit).toHaveBeenCalled();
    // The user committed the fixup! commit on the PR branch; Commit and Rebase autosquashes it.
    const fx = commit("fxffffffffffffffffffffffffffffff", [A2.id], "fixup! A1");
    repo.logs.abc = [fx, A2, A1];
    useVcs.setState({
      branch: { head: "abc", headCommit: fx.id, upstream: "origin/abc", ahead: 1, behind: 0, operation: null },
    });
    mocks.confirm.mockClear();
    await rebaseAfterFixup(A1);
    const op = rebaseOp();
    expect(op.op).toBe("interactiveRebase");
    expect(op.base).toBe(M0.id);
    expect(op.entries).toEqual([
      { commit: A1.id, action: "pick", message: null },
      { commit: fx.id, action: "fixup", message: null },
      { commit: A2.id, action: "pick", message: null },
    ]);
    // The pushed history was confirmed once, with the usual force-push warning.
    expect(mocks.confirm.mock.calls[0]?.[0].message).toContain("force push");
  });

  it("stays on the current branch when the user declines the checkout", async () => {
    mocks.confirm.mockResolvedValue(false);
    await dropCommits([A1]);
    expect(mocks.checkout).not.toHaveBeenCalled();
    expect(mocks.operation).not.toHaveBeenCalled();
    expect(repo.checkedOut).toBe("main");
  });

  it("refuses before switching when the branch's history down to the commit has a merge", async () => {
    const merge = commit("mgggggggggggggggggggggggggggggg", [A1.id, "x22222222222222222222222222222222"], "Merge");
    repo.logs.abc = [A2, merge, A1];
    await dropCommits([A1]);
    expect(mocks.showError).toHaveBeenCalledWith(
      "Cannot drop commit",
      "Interactive rebase is not supported for a range that contains merge commits",
    );
    expect(mocks.checkout).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it("refuses when several branches hold the commit", async () => {
    repo.containing = ["abc", "origin/abc", "feature", "origin/feature"];
    repo.extra = [branch("feature", false, A2.id), branch("origin/feature", true, A2.id)];
    useVcs.setState({ branches: branchList() });
    await dropCommits([A1]);
    expect(mocks.showError).toHaveBeenCalledWith(
      "Cannot drop commit",
      expect.stringContaining("several branches ('abc', 'feature')"),
    );
    expect(mocks.checkout).not.toHaveBeenCalled();
  });

  it("checks out a remote-only branch by creating its local namesake", async () => {
    repo.localAbc = false;
    useVcs.setState({ branches: branchList() });
    await dropCommits([A1]);
    expect(mocks.confirm.mock.calls[0]?.[0].message).toContain("on 'abc'");
    expect(mocks.checkout).toHaveBeenCalledWith("/p", "origin/abc", false, expect.anything());
    expect(repo.checkedOut).toBe("abc");
    expect(mocks.operation).toHaveBeenCalled();
  });

  it("refuses a protected branch before switching", async () => {
    useProject.setState({ settings: { vcs: { git: { protectedBranches: "abc" } } } as Settings });
    await dropCommits([A1]);
    expect(mocks.showError).toHaveBeenCalledWith(
      "Cannot drop commit",
      "Pushed commits of the protected branch 'abc' cannot be rewritten",
    );
    expect(mocks.checkout).not.toHaveBeenCalled();
  });

  it("keeps preparing the fixup on the current branch without a switch dialog", async () => {
    repo.logs.main = [A1, M0];
    useVcs.setState({
      branch: { head: "main", headCommit: A1.id, upstream: "origin/main", ahead: 1, behind: 0, operation: null },
    });
    await prepareFixup(A1, "fixup");
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.checkout).not.toHaveBeenCalled();
    expect(useCommit.getState().fixupTarget).toEqual(A1);
  });
});
