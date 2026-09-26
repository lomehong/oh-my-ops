#!/usr/bin/env bash
# probe-vendor-integrity.sh —— vendor 适配器「完整性防线」体检（对应 OMOVENDOR-1）
#
# 背景：vendor/yuyi-omp-extension.js 是上游构建拷贝，历史上以「整文件同步」方式更新（chore(vendor): 同步…）。
# 本仓在 OMOBRIDGE-2 落的回信修复（D1-D5）因此可能被下一次同步**静默回退**——没有任何红灯。
# 本脚本把防线串成一条可重复执行的体检，四段：
#   [1] 清单一致：适配器 sha256 == vendor/yuyi-omp-extension.sha256（改文件必改清单，清单是安装闸门的判据）
#   [2] 溯源一致：PROVENANCE.md 记录的指纹与实物一致，且登记上游基准 md5（393e21ba…）与补丁清单
#   [3] 负例自证：把回信目标回滚为「会话别名」（= 上游同步回退 D1）后，回归探针必须变红且红在预期项上
#   [4] 闸门在位：test:ci 入口 / install.sh 安装前校验 / release.yml 打包前探针 三道闸门都在
#
# 用法：bash scripts/probe-vendor-integrity.sh   退出码 0=全绿
# 注：[3] 会真跑一次回归探针（约 33s）——负例必须实跑，静态断言证明不了「探针有区分力」。
set -euo pipefail
cd "$(dirname "$0")/.."

FAILED=0
pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; FAILED=$((FAILED + 1)); }
skip() { echo "  - $1"; }

ADAPTER="vendor/yuyi-omp-extension.js"
MANIFEST="vendor/yuyi-omp-extension.sha256"
PROV="vendor/yuyi-omp-extension.PROVENANCE.md"
UPSTREAM_MD5="393e21ba0700a4d5e3008fc80cc65b1b"

# sha256 取值：master 用 sha256sum，Git Bash/macOS 回退 shasum -a 256
sha256_of() {
	if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
	else shasum -a 256 "$1" | awk '{print $1}'; fi
}
md5_of() {
	if command -v md5sum >/dev/null 2>&1; then md5sum "$1" | awk '{print $1}';
	else md5 -q "$1" 2>/dev/null || openssl md5 "$1" | awk '{print $NF}'; fi
}

echo "[1] 清单一致：$ADAPTER vs $MANIFEST"
[ -f "$ADAPTER" ] || { fail "适配器本体缺失：$ADAPTER"; }
if [ -f "$MANIFEST" ]; then
	ACTUAL="$(sha256_of "$ADAPTER")"
	LISTED="$(awk '{print $1}' "$MANIFEST" | head -1)"
	if [ "$ACTUAL" = "$LISTED" ]; then
		pass "sha256 一致（${ACTUAL:0:16}…）"
	else
		fail "sha256 不符：实物 ${ACTUAL:0:16}… ≠ 清单 ${LISTED:0:16}…（改了 vendor 未更新清单，或反之）"
	fi
	grep -q "yuyi-omp-extension.js" "$MANIFEST" && pass "清单含文件名（sha256sum -c 可直接消费）" || fail "清单缺文件名，无法用 sha256sum -c 校验"
else
	fail "清单缺失：$MANIFEST（安装闸门失去判据）"
	ACTUAL="$(sha256_of "$ADAPTER")"
fi

echo "[2] 溯源一致：$PROV"
if [ -f "$PROV" ]; then
	grep -q "$ACTUAL" "$PROV" && pass "溯源件记录当前 sha256（${ACTUAL:0:16}…）" || fail "溯源件未记录当前 sha256 ${ACTUAL:0:16}…（文件改了，溯源件没跟上）"
	AM="$(md5_of "$ADAPTER")"
	grep -q "$AM" "$PROV" && pass "溯源件记录当前 md5（${AM:0:12}…）" || fail "溯源件未记录当前 md5 ${AM:0:12}…"
	grep -q "$UPSTREAM_MD5" "$PROV" && pass "溯源件登记上游基准 md5（393e21ba…）" || fail "溯源件缺上游基准 md5，无法判断同步来源"
	grep -qE "D1|D2|D3|D4|D5" "$PROV" && pass "溯源件含本仓补丁清单（D1-D5）" || fail "溯源件缺补丁清单"
else
	fail "溯源件缺失：$PROV"
fi

echo "[3] 负例自证：回滚 D1（回信目标 → 会话别名）后探针必须变红"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
cp "$ADAPTER" "$TMP/regressed.js"
# 上游 0.1.0 原形态（D1）：to: { target: from.name ?? from.sessionID }
PAT_OLD='to: { device: origMsg.from.device, target: origMsg.from.sessionID ?? origMsg.from.name },'
PAT_NEW='to: { target: origMsg.from.name ?? origMsg.from.sessionID },'
BEFORE_N="$(grep -cF "$PAT_OLD" "$TMP/regressed.js" || true)"
if [ "$BEFORE_N" -eq 0 ]; then
	fail "变异未命中：vendor 中已无「agent 级回信目标」原形态（vendor 结构已变，请更新本脚本的变异式）"
else
	# 用 node 做替换（避免 sed 在 / & 上的转义坑），并断言命中条数不变
	node -e '
	  const fs = require("fs");
	  const p = process.argv[1], a = process.argv[2], b = process.argv[3];
	  const src = fs.readFileSync(p, "utf8");
	  const n = src.split(a).length - 1;
	  if (n === 0) { console.error("mutation-miss"); process.exit(2); }
	  fs.writeFileSync(p, src.split(a).join(b));
	  console.log(n);
	' "$TMP/regressed.js" "$PAT_OLD" "$PAT_NEW" > "$TMP/mutated-n.txt" || { fail "变异执行失败"; }
	MUT_N="$(cat "$TMP/mutated-n.txt" 2>/dev/null || echo 0)"
	AFTER_SHA="$(sha256_of "$TMP/regressed.js")"
	if [ "$MUT_N" -ge 1 ] && [ "$AFTER_SHA" != "$ACTUAL" ]; then
		pass "变异生效（$MUT_N 处，文件指纹已变）"
	else
		fail "变异未生效（命中 $MUT_N 处）"
	fi
	set +e
	node scripts/probe-yuyi-reply-frame.mjs --bundle "$TMP/regressed.js" > "$TMP/regressed.log" 2>&1
	EC=$?
	set -e
	RED_LINE="$(grep -m1 '^结果：' "$TMP/regressed.log" || true)"
	if [ "$EC" -ne 0 ]; then
		pass "回退版探针变红（exit=$EC；$RED_LINE）"
	else
		fail "回退版探针竟全绿——探针失去区分力（$RED_LINE）"
	fi
	grep -q "✗ T2 " "$TMP/regressed.log" && pass "红在预期项：T2（回信目标 agent 级）" || fail "T2 未红——回信目标断言失效"
	grep -qE "✗ T(9|10) " "$TMP/regressed.log" && pass "红在预期项：T9/T10（失败回信路径）" || fail "T9/T10 未红——失败回信断言失效"
	echo "  · 负例输出留档：$RED_LINE"
fi

echo "[4] 闸门在位（静态）"
grep -qE '"test:vendor": "[^"]*probe-yuyi-reply-frame\.mjs"' package.json && pass "直跑入口 test:vendor 指向回归探针" || fail "package.json 的 test:vendor 未指向 probe-yuyi-reply-frame.mjs"
grep -q 'npm run test:vendor' package.json && pass "test:ci 含 test:vendor" || fail "test:ci 未纳入 test:vendor（防线不入 CI=形同虚设）"
grep -q 'npm run test:vendor-integrity' package.json && pass "test:ci 含 test:vendor-integrity" || fail "test:ci 未纳入本体检"
grep -q 'yuyi-omp-extension.sha256' scripts/install.sh && pass "install.sh 引用完整性清单（安装前校验）" || fail "install.sh 未见安装前完整性校验"
grep -q 'probe-yuyi-reply-frame.mjs' .github/workflows/release.yml && pass "release.yml 打包前跑回归探针" || fail "release.yml 未见打包前探针闸门"
grep -q 'yuyi-omp-extension.sha256' .github/workflows/release.yml && pass "release.yml 校验发布包内适配器指纹" || fail "release.yml 未见适配器指纹抽验"
grep -q 'yuyi-omp-extension.js' .github/workflows/release.yml && pass "release.yml 打包清单含适配器" || fail "release.yml 打包清单未断言适配器"

if [ "$FAILED" -eq 0 ]; then echo "结果：全绿"; exit 0; fi
echo "结果：$FAILED 项失败"; exit 1
