import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { babysitWorkdir, runBabysit } from "./babysit";
import { updateBabysitBranches } from "./babysit-branches";
import { makeBabysitDeps, makePipelineDeps } from "./real-deps";
import { LoopExceededError, runPipeline } from "./run";

export type MainCommand =
  | { cmd: "run"; issue: number; designDocPath: string | undefined; mode: "resume" | "fresh" }
  | { cmd: "babysit" }
  | { cmd: "babysit-pr"; pr: number }
  | { cmd: "branch"; op: "list" }
  | { cmd: "branch"; op: "add" | "remove"; pattern: string }
  | { cmd: "help" };

function parseRunMode(args: string[]): "resume" | "fresh" {
  if (args.includes("--fresh")) return "fresh";
  return "resume";
}

export function parseMain(args: string[]): MainCommand {
  const [first, ...rest] = args;
  if (first === "babysit") return { cmd: "babysit" };
  if (first === "babysit-pr") {
    const pr = Number(rest[0]);
    return Number.isInteger(pr) && pr > 0 ? { cmd: "babysit-pr", pr } : { cmd: "help" };
  }
  if (first === "branch") {
    const op = rest[0];
    if (op === undefined || op === "list") return { cmd: "branch", op: "list" };
    if ((op === "add" || op === "remove") && rest[1]) return { cmd: "branch", op, pattern: rest[1] };
    return { cmd: "help" };
  }
  const issue = Number(first);
  if (Number.isInteger(issue) && issue > 0) {
    const i = args.indexOf("--design");
    return {
      cmd: "run",
      issue,
      designDocPath: i !== -1 && args[i + 1] ? args[i + 1] : undefined,
      mode: parseRunMode(args),
    };
  }
  return { cmd: "help" };
}

const USAGE = `使い方（.agent-pipeline.json のあるプロジェクトルートで実行）:
  pipeline <issue番号> [--design <設計書パス>] [--fresh]  issue を実装して PR 作成まで自動で回す（既定は --resume）
  pipeline babysit                                  open PR を 1 回走査（コンフリクト・コメント対応）
  pipeline babysit-pr <PR番号>                      checkout 済みブランチで単一 PR を処理（CI 用）
  pipeline branch [list | add <glob> | remove <glob>]  コメント対応の対象ブランチを管理`;

export async function main(args: string[]): Promise<number> {
  const command = parseMain(args);
  const projectRoot = process.cwd();

  switch (command.cmd) {
    case "help":
      console.error(USAGE);
      return 1;

    case "run":
      try {
        const { prUrl, reportPath } = await runPipeline(makePipelineDeps(projectRoot), command.issue, {
          designDocPath: command.designDocPath ? resolve(command.designDocPath) : undefined,
          mode: command.mode,
        });
        console.log(`PR 作成完了: ${prUrl}`);
        console.log(`レポート: ${reportPath}`);
        return 0;
      } catch (e) {
        if (e instanceof LoopExceededError) {
          console.error(String(e.message));
          return 2;
        }
        throw e;
      }

    case "babysit": {
      const results = await runBabysit(makeBabysitDeps(projectRoot));
      if (results.length === 0) console.log("対応が必要な open PR はありません");
      for (const r of results) console.log(`#${r.number}: ${r.actions.length > 0 ? r.actions.join(", ") : "対応不要"}`);
      return results.some((r) => r.actions[0]?.startsWith("error")) ? 1 : 0;
    }

    case "babysit-pr": {
      const deps = makeBabysitDeps(projectRoot);
      const pr = await deps.github.getPr(projectRoot, command.pr);
      const r = await babysitWorkdir(deps, pr, projectRoot);
      console.log(`#${r.number}: ${r.actions.length > 0 ? r.actions.join(", ") : "対応不要"}`);
      return 0;
    }

    case "branch": {
      const path = join(projectRoot, ".agent-pipeline.json");
      const config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      if (command.op === "list") {
        const current = Array.isArray(config.babysitBranches) ? config.babysitBranches : ["issue-*（デフォルト）"];
        console.log(`コメント対応の対象ブランチ: ${current.join(", ")}`);
        console.log("（コンフリクト解消は保護ブランチを除く全 open PR が対象）");
        return 0;
      }
      const next = updateBabysitBranches(config, command.op, command.pattern);
      writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
      console.log(`babysitBranches: ${(next.babysitBranches as string[]).join(", ")}`);
      return 0;
    }
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
