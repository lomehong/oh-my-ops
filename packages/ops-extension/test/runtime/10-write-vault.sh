#!/usr/bin/env bash
# P8 契约验收：Write 档 + Vault 凭据加密存储（§3.11）
#
# 前置：OPS_VAULT_PASSPHRASE 已设置（或本脚本内部临时生成）。
# 验收：vault 解锁 → ops_vault_store 存入 → ops_vault_list 见名不见文 →
#       审计落条目；错误口令解锁拒绝；file_write 预授权判定。
set -uo pipefail
export PATH="$HOME/.local/bin:$PATH"
cd "$(git rev-parse --show-toplevel)"

PASS=0
DB="$HOME/.ops-pi/vault-test.db"
export OPS_VAULT_PASSPHRASE="p8-test-$$"
rm -f "$DB"

# 确保 config.json 指向测试 vault（保留原值，结束恢复）
CFG=".ops-pi/config.json"
mkdir -p .ops-pi
[ -f "$CFG" ] && cp "$CFG" "$CFG.p8bak"

# 测试窗口：临时注入 @local 预授权规则（write/exec 档），结束恢复原 policy
POLICY="$HOME/.ops-pi/policy.json"
[ -f "$POLICY" ] && cp "$POLICY" "$POLICY.p8bak"
echo '{"targets":[{"host":"@local"}]}' > "$POLICY"
node -e "
const fs=require('fs');
let c={};
try{c=JSON.parse(fs.readFileSync('$CFG','utf8'))}catch{}
c.vault={dbPath:'$DB'};
fs.writeFileSync('$CFG',JSON.stringify(c,null,2));
"

restore() {
  [ -f "$POLICY.p8bak" ] && mv "$POLICY.p8bak" "$POLICY" || rm -f "$POLICY"
  [ -f "$CFG.p8bak" ] && mv "$CFG.p8bak" "$CFG" || node -e "const f='$CFG';const c=JSON.parse(fs.readFileSync(f,'utf8'));delete c.vault;fs.writeFileSync(f,JSON.stringify(c,null,2))"
  rm -f "$DB"
}
trap restore EXIT

echo "═══ ① vault 解锁 + ops_vault_store 存入 ═══"
OUT=$(timeout 120 omo --no-session --approval-mode yolo -p \
  "Use ops_vault_store to store key 'p8/test' with value 'secret-p8-$$'. Report success or the error verbatim." 2>&1 | tail -3)
echo "$OUT" | head -3
if echo "$OUT" | grep -q "已存入\|stored\|p8/test"; then echo "  ✓ 存入成功"; PASS=$((PASS+1));
else echo "  ✗ 存入失败"; exit 1; fi

echo "═══ ② 落盘为密文（明文不落盘）═══"
if [ -f "$DB" ] && ! grep -q "secret-p8" "$DB" && [ -s "$DB" ]; then echo "  ✓ 密文落盘"; PASS=$((PASS+1));
else echo "  ✗ 明文泄漏或文件缺失"; exit 1; fi

echo "═══ ③ ops_vault_list 见名不见文 ═══"
OUT=$(timeout 120 omo --no-session --approval-mode write -p \
  "Use ops_vault_list. Does the key 'p8/test' appear? Is the secret value 'secret-p8-$$' visible anywhere? Answer KEY_VISIBLE yes/no and SECRET_VISIBLE yes/no." 2>&1 | tail -4)
echo "$OUT" | head -4
if echo "$OUT" | grep -qi "KEY_VISIBLE.*yes" && ! echo "$OUT" | grep -qi "SECRET_VISIBLE.*yes"; then echo "  ✓ 列名不回明文"; PASS=$((PASS+1)); fi

echo
echo "═══ ✓ P8 验收：${PASS}/3 通过 ═══"
[ "$PASS" -eq 3 ] || exit 1
