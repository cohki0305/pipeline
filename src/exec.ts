export type ExecResult = { code: number; stdout: string; stderr: string };
export type ExecOpts = { cwd?: string; timeoutMs?: number; env?: Record<string, string> };
export type Exec = (cmd: string, opts?: ExecOpts) => Promise<ExecResult>;

export const shellExec: Exec = async (cmd, opts = {}) => {
  const proc = Bun.spawn(["bash", "-c", cmd], {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  // エージェント実行は長い。既定 30 分で kill
  const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? 30 * 60 * 1000);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { code, stdout, stderr };
};
