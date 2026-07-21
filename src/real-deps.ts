import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { makeAgentRunner } from "./agents";
import type { BabysitDeps } from "./babysit";
import { loadConfig } from "./config";
import { shellExec } from "./exec";
import { makeGithub } from "./github";
import type { Deps } from "./run";

export function makePipelineDeps(projectRoot: string): Deps {
  return {
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
  };
}

export function makeBabysitDeps(projectRoot: string): BabysitDeps {
  return {
    config: loadConfig(projectRoot),
    exec: shellExec,
    agent: makeAgentRunner(shellExec),
    github: makeGithub(shellExec),
    projectRoot,
    log: (msg) => console.log(`[babysit] ${msg}`),
    sleep: (ms) => Bun.sleep(ms),
  };
}
