// relay イベントを babysit 対象プロジェクトへルーティングする純粋ロジック

export type RelayConfig = {
  url: string;
  token: string;
  /** 後方互換: 単一プロジェクト。projects 定義時は repo 情報のないメッセージのフォールバック */
  projectRoot?: string;
  /** "owner/repo" → projectRoot の複数プロジェクトマップ */
  projects?: Record<string, string>;
};

export function resolveProjectRoot(config: RelayConfig, rawMessage: string): string | null {
  let repo: string | null = null;
  try {
    const parsed = JSON.parse(rawMessage) as { repo?: unknown };
    if (typeof parsed.repo === "string") repo = parsed.repo;
  } catch {}

  if (config.projects && repo) {
    // マップにない repo のイベントで誤ったプロジェクトの babysit を走らせない
    return config.projects[repo] ?? null;
  }
  return config.projectRoot ?? null;
}
