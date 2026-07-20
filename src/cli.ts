import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { makeAgentRunner } from "./agents";
import { loadConfig } from "./config";
import { shellExec } from "./exec";
import { makeGithub } from "./github";
import { LoopExceededError, runPipeline } from "./run";

const args = process.argv.slice(2);
const issueNumber = Number(args[0]);
if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
  console.error("使い方: プロジェクトルートで bun run <このファイル> <issue番号> [--design <設計書パス>]");
  process.exit(1);
}
const designFlag = args.indexOf("--design");
const designDocPath = designFlag !== -1 && args[designFlag + 1] ? resolve(args[designFlag + 1]!) : undefined;

const projectRoot = process.cwd();

try {
  const { prUrl, reportPath } = await runPipeline(
    {
      config: loadConfig(projectRoot),
      exec: shellExec,
      agent: makeAgentRunner(shellExec),
      github: makeGithub(shellExec),
      projectRoot,
      log: (msg) => console.log(`[pipeline] ${msg}`),
      writeFile: async (path, content) => {
        await mkdir(dirname(path), { recursive: true });
        await Bun.write(path, content);
      },
      readFile: (path) => readFile(path, "utf8"),
      // ローカルタイムゾーンの YYYY-MM-DD（toISOString は UTC で日付がずれる）
      date: new Date().toLocaleDateString("sv-SE"),
    },
    issueNumber,
    { designDocPath },
  );
  console.log(`PR 作成完了: ${prUrl}`);
  console.log(`レポート: ${reportPath}`);
} catch (e) {
  if (e instanceof LoopExceededError) {
    console.error(String(e.message));
    process.exit(2);
  }
  throw e;
}
