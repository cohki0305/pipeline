import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { updateBabysitBranches } from "./babysit-branches";

// 使い方: プロジェクトルートで
//   bun run <このファイル> list
//   bun run <このファイル> add <glob>
//   bun run <このファイル> remove <glob>

const [op, pattern] = process.argv.slice(2);
const path = join(process.cwd(), ".agent-pipeline.json");
const config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

if (op === "list" || op === undefined) {
  const current = Array.isArray(config.babysitBranches) ? config.babysitBranches : ["issue-*（デフォルト）"];
  console.log(`コメント対応の対象ブランチ: ${current.join(", ")}`);
  console.log("（コンフリクト解消は全 open PR が対象）");
  process.exit(0);
}

if ((op !== "add" && op !== "remove") || !pattern) {
  console.error("使い方: babysit:branch [list | add <glob> | remove <glob>]");
  process.exit(1);
}

const next = updateBabysitBranches(config, op, pattern);
writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
console.log(`babysitBranches: ${(next.babysitBranches as string[]).join(", ")}`);
