import { makeAgentRunner } from "./agents";
import { babysitWorkdir } from "./babysit";
import { loadConfig } from "./config";
import { shellExec } from "./exec";
import { makeGithub } from "./github";

// CI（GitHub Actions 等）用エントリ。cwd に PR ブランチが checkout 済みであることが前提
const prNumber = Number(process.argv[2]);
if (!Number.isInteger(prNumber) || prNumber <= 0) {
  console.error("使い方: PR ブランチを checkout したディレクトリで bun run <このファイル> <PR番号>");
  process.exit(1);
}

const cwd = process.cwd();
const github = makeGithub(shellExec);
const deps = {
  config: loadConfig(cwd),
  exec: shellExec,
  agent: makeAgentRunner(shellExec),
  github,
  projectRoot: cwd,
  log: (msg: string) => console.log(`[babysit] ${msg}`),
};

const pr = await github.getPr(cwd, prNumber);
const result = await babysitWorkdir(deps, pr, cwd);
console.log(`#${result.number}: ${result.actions.length > 0 ? result.actions.join(", ") : "対応不要"}`);
