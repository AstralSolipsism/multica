import { spawn } from "node:child_process";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const jobs = [
  ["brand", ["test:brand"]],
  ["ysk", ["test:ysk"]],
  ["core", ["--filter", "@multica/core", "exec", "vitest", "run", "--maxWorkers=1",
    "notification-preferences/patch.test.ts",
    "inbox/ws-updaters.test.ts",
    "realtime/use-realtime-sync.test.ts",
    "projects/queries.test.ts",
  ]],
  ["views", ["--filter", "@multica/views", "exec", "vitest", "run", "--maxWorkers=1",
    "editor/content-editor-quick-actions.test.tsx",
    "issues/components/comment-composers.test.tsx",
    "issues/components/issue-detail-route.highlight.test.tsx",
    "inbox/components/inbox-page-query.test.tsx",
    "layout/panels/work-tree.test.tsx",
    "settings/components/notifications-tab.test.tsx",
    "message-delivery/copy.test.ts",
  ]],
  ["desktop", ["--filter", "@multica/desktop", "exec", "vitest", "run", "--maxWorkers=1",
    "src/renderer/src/components/desktop-layout.test.tsx",
    "src/renderer/src/components/desktop-layout.workspace-gate.test.tsx",
    "src/renderer/src/components/workspace-route-layout.test.tsx",
  ]],
  ["web", ["--filter", "@multica/web", "exec", "vitest", "run", "--maxWorkers=1",
    "proxy.test.ts",
    "platform/issue-deep-link.test.tsx",
  ]],
  ["mobile", ["--filter", "@multica/mobile", "exec", "vitest", "run", "--maxWorkers=1"]],
];

const started = Date.now();
const children = new Set();
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    for (const child of children) child.kill(signal);
  });
}

const results = await Promise.all(jobs.map(([name, args]) => new Promise((resolve) => {
  const child = spawn(pnpm, args, { stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  child.on("error", (error) => { output += `\n${error.stack ?? error.message}\n`; });
  child.on("close", (code, signal) => {
    children.delete(child);
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`\n--- ${name}: exit=${code ?? "none"} signal=${signal ?? "none"} elapsed=${elapsed}s ---\n${output}`);
    resolve(code === 0);
  });
})));

console.log(`\nUnit contract suite: ${((Date.now() - started) / 1000).toFixed(1)}s`);
if (results.some((passed) => !passed)) process.exitCode = 1;
