import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";

type Step = { name?: string; uses?: string; run?: string; with?: Record<string, unknown> };
const text = readFileSync(repoPath(".github", "workflows", "personal-build.yml"), "utf8");
const workflow = Bun.YAML.parse(text) as {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<string, { if?: string; "runs-on"?: string; "timeout-minutes"?: number; steps: Step[] }>;
};
const job = workflow.jobs.package!;
const steps = job.steps;
const commands = steps.map(step => step.run ?? "").join("\n");

test("personal builds are manual, fork-only, personal-only and read-only", () => {
  expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(Object.keys(workflow.jobs)).toEqual(["package"]);
  expect(job.if).toBe("github.repository == 'colthreepv/opencodex' && github.ref == 'refs/heads/personal'");
  expect(job["runs-on"]).toBe("ubuntu-latest");
  expect(job["timeout-minutes"]).toBe(20);
  expect(text).not.toMatch(/secrets\.|pull_request|schedule:|id-token:|contents: write/);
});

test("the build pins actions and source without retaining checkout credentials", () => {
  for (const step of steps) {
    if (step.uses && !step.uses.startsWith("./")) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
  }
  const checkout = steps.find(step => step.uses?.startsWith("actions/checkout@"))!;
  expect(checkout.with?.ref).toBe("${{ github.sha }}");
  expect(checkout.with?.["persist-credentials"]).toBe(false);
  expect(steps.some(step => step.uses === "./.github/actions/setup-project-bun")).toBe(true);
});

test("the artifact contains the prepared package, source provenance and checksums without publication", () => {
  expect(commands).toContain("bun install --frozen-lockfile");
  expect(commands).toContain("bun run typecheck");
  expect(commands).toContain("bun run build:gui");
  expect(commands.indexOf("bun run build:gui")).toBeLessThan(commands.indexOf("npm pack --ignore-scripts"));
  expect(commands).toContain("npm pack --ignore-scripts --pack-destination dist/personal");
  expect(commands).toContain("process.env.BUILD_COMMIT");
  expect(commands).toContain("sha256sum *.tgz provenance.json personal.md > SHA256SUMS");
  expect(commands).not.toMatch(/npm publish|gh release|bun run release|service (start|stop)|git push/);
  const upload = steps.find(step => step.uses?.startsWith("actions/upload-artifact@"))!;
  expect(upload.with?.name).toBe("opencodex-personal-${{ github.sha }}");
  expect(upload.with?.path).toBe("dist/personal/");
  expect(upload.with?.["if-no-files-found"]).toBe("error");
});
