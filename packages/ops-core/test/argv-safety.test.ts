import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertNoFlagLike, assertSafeIdentifier, clampNumeric, safeRelativePath } from "../src/argv-safety.ts";

/**
 * 执行层参数收口（审查 P0：选项注入与 compose file 越权）。
 *
 * 这些用例是安全回归网：`service="--all"` / `container="--privileged"` /
 * `file="../../x.yml"` 三条路径任一被放行，都等于绕过授权扩大破坏范围。
 */

describe("assertSafeIdentifier · 资源标识符白名单", () => {
	it("正常名放行：systemd unit（含 @instance）、容器名、K8s 名与命名空间", () => {
		assert.equal(assertSafeIdentifier("systemdUnit", "nginx"), "nginx");
		assert.equal(assertSafeIdentifier("systemdUnit", "docker@docker.service"), "docker@docker.service");
		assert.equal(assertSafeIdentifier("systemdUnit", "my-app_2.0"), "my-app_2.0");
		assert.equal(assertSafeIdentifier("dockerContainer", "web-01"), "web-01");
		assert.equal(assertSafeIdentifier("k8sName", "my-app-7d9f8b6c5-x2k9p"), "my-app-7d9f8b6c5-x2k9p");
		assert.equal(assertSafeIdentifier("k8sNamespace", "kube-system"), "kube-system");
	});

	it("★ 选项形态一律拒（这是本模块存在的理由）", () => {
		assert.throws(() => assertSafeIdentifier("systemdUnit", "--all"), /POLICY_DENIED/);
		assert.throws(() => assertSafeIdentifier("systemdUnit", "--now"), /POLICY_DENIED/);
		assert.throws(() => assertSafeIdentifier("dockerContainer", "--privileged"), /POLICY_DENIED/);
		assert.throws(() => assertSafeIdentifier("dockerContainer", "-v"), /POLICY_DENIED/);
		assert.throws(() => assertSafeIdentifier("k8sName", "--kubeconfig=/etc/kube.conf"), /POLICY_DENIED/);
	});

	it("空串与路径分隔符拒（容器名/服务名不含路径语义）", () => {
		assert.throws(() => assertSafeIdentifier("systemdUnit", ""), /POLICY_DENIED/);
		assert.throws(() => assertSafeIdentifier("dockerContainer", "a/b"), /POLICY_DENIED/);
		assert.throws(() => assertSafeIdentifier("dockerContainer", "../../etc/passwd"), /POLICY_DENIED/);
	});

	it("K8s 名拒绝大写与首尾连字符（RFC 1123）", () => {
		assert.throws(() => assertSafeIdentifier("k8sName", "MyApp"), /POLICY_DENIED/);
		assert.throws(() => assertSafeIdentifier("k8sName", "-app"), /POLICY_DENIED/);
		assert.throws(() => assertSafeIdentifier("k8sName", "app-"), /POLICY_DENIED/);
	});
});

describe("assertNoFlagLike · 轻量档", () => {
	it("仅拒绝以 '-' 开头的形态，其余放行", () => {
		assert.equal(assertNoFlagLike("prod", "命名空间"), "prod");
		assert.throws(() => assertNoFlagLike("--namespace=x", "命名空间"), /POLICY_DENIED/);
		assert.throws(() => assertNoFlagLike("-n", "命名空间"), /POLICY_DENIED/);
	});
});

describe("safeRelativePath · compose 文件名等相对路径", () => {
	it("单段文件名放行", () => {
		assert.equal(safeRelativePath("docker-compose.yml", "compose 文件名"), "docker-compose.yml");
		assert.equal(safeRelativePath("compose.yaml", "compose 文件名"), "compose.yaml");
		assert.equal(safeRelativePath("docker-compose.prod.yml", "compose 文件名"), "docker-compose.prod.yml");
	});

	it("★ `..` 穿越一律拒（授权域外 compose 加载）", () => {
		assert.throws(() => safeRelativePath("../../etc/other.yml", "compose 文件名"), /POLICY_DENIED/);
		assert.throws(() => safeRelativePath("..", "compose 文件名"), /POLICY_DENIED/);
		assert.throws(() => safeRelativePath("../docker-compose.yml", "compose 文件名"), /POLICY_DENIED/);
	});

	it("绝对路径与分隔符拒", () => {
		assert.throws(() => safeRelativePath("/etc/docker-compose.yml", "compose 文件名"), /POLICY_DENIED/);
		assert.throws(() => safeRelativePath("sub/docker-compose.yml", "compose 文件名"), /POLICY_DENIED/);
		assert.throws(() => safeRelativePath("sub\\docker-compose.yml", "compose 文件名"), /POLICY_DENIED/);
	});

	it("选项形态与空串拒", () => {
		assert.throws(() => safeRelativePath("--file", "compose 文件名"), /POLICY_DENIED/);
		assert.throws(() => safeRelativePath("", "compose 文件名"), /POLICY_DENIED/);
	});
});

describe("clampNumeric · 数值入参统一夹取", () => {
	it("缺省/非有限数/非正数 → 回落 fallback", () => {
		assert.equal(clampNumeric(undefined, 100, 1, 5000), 100);
		assert.equal(clampNumeric(null, 100, 1, 5000), 100);
		assert.equal(clampNumeric(Number.NaN, 100, 1, 5000), 100);
		assert.equal(clampNumeric(Number.POSITIVE_INFINITY, 100, 1, 5000), 100);
		assert.equal(clampNumeric(0, 100, 1, 5000), 100);
		assert.equal(clampNumeric(-5, 100, 1, 5000), 100);
	});

	it("★ null（Number(null)=0）不得被夹成下限 1（否则 file_read maxBytes 退化为必然失败）", () => {
		assert.equal(clampNumeric(null, 2 * 1024 * 1024, 1, 16 * 1024 * 1024), 2 * 1024 * 1024);
	});

	it("超上限截断、下限夹取、小数向下取整；数字字符串接受", () => {
		assert.equal(clampNumeric(99999, 100, 1, 5000), 5000);
		assert.equal(clampNumeric(0.4, 100, 1, 5000), 1);
		assert.equal(clampNumeric(250.9, 100, 1, 5000), 250);
		assert.equal(clampNumeric("300", 100, 1, 5000), 300);
		assert.equal(clampNumeric("", 100, 1, 5000), 100);
		assert.equal(clampNumeric("abc", 100, 1, 5000), 100);
	});
});