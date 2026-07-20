import { makeAgentRunner } from "./agents";
import { loadConfig } from "./config";
import { shellExec } from "./exec";
import { makeGithub } from "./github";
import { runBabysit } from "./babysit";

const projectRoot = process.cwd();

const results = await runBabysit({
  config: loadConfig(projectRoot),
  exec: shellExec,
  agent: makeAgentRunner(shellExec),
  github: makeGithub(shellExec),
  projectRoot,
  log: (msg) => console.log(`[babysit] ${msg}`),
});

if (results.length === 0) {
  console.log("対象の open PR はありません");
} else {
  for (const r of results) {
    console.log(`#${r.number}: ${r.actions.length > 0 ? r.actions.join(", ") : "対応不要"}`);
  }
}
