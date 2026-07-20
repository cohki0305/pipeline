// ブランチ名は PR 作成者が決められる外部入力であり、シェルコマンドに補間する前に必ず通す
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;

export function safeRef(name: string): string {
  if (!SAFE_REF.test(name)) throw new Error(`安全でない git ref のため拒否: ${JSON.stringify(name)}`);
  return name;
}
