import { describe, expect, it } from "bun:test";
import { mergeBodyPatch, validateBody } from "./body-merge";

const RISK_BODY = [
	"root = Card([head, callout])",
	'head = CardHeader("Campaign inconsistency")',
	'callout = Callout("warning", "Medium likelihood / high impact", "Flipping between the two campaigns causes bugs.")',
].join("\n");

const METRIC_BODY = [
	"root = Card([head, chart])",
	'head = CardHeader("Weekly active users")',
	'chart = LineChart(["Wk 1", "Wk 2", "Wk 3"], [series1])',
	'series1 = Series("WAU", [12400, 13100, 13900])',
].join("\n");

describe("validateBody", () => {
	it("accepts a well-formed body", () => {
		expect(validateBody(RISK_BODY).ok).toBe(true);
		expect(validateBody(METRIC_BODY).ok).toBe(true);
	});

	it("rejects empty / whitespace", () => {
		expect(validateBody("").ok).toBe(false);
		expect(validateBody("   \n ").ok).toBe(false);
	});

	it("rejects a body with a dangling reference", () => {
		const r = validateBody(
			'root = Card([head, ghost])\nhead = CardHeader("x")',
		);
		expect(r.ok).toBe(false);
		expect(r.reason).toContain("ghost");
	});

	it("rejects unparseable garbage (no resolvable root)", () => {
		const r = validateBody("::: @@@ ((( not dsl");
		expect(r.ok).toBe(false);
		expect(r.reason).toContain("no root");
	});
});

describe("mergeBodyPatch — happy path", () => {
	it("replaces a same-named statement, keeps the rest", () => {
		const patch =
			'callout = Callout("danger", "High likelihood / high impact", "Now confirmed customer-visible bugs.")';
		const res = mergeBodyPatch(RISK_BODY, patch);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		// changed statement is now danger
		expect(res.body).toContain("danger");
		expect(res.body).not.toContain('"warning"');
		// unmentioned statements survive
		expect(res.body).toContain("Campaign inconsistency");
		expect(res.body).toContain("root = Card([head, callout])");
	});

	it("adds a new statement referenced by a rewritten root", () => {
		const patch = [
			"root = Card([head, callout, mit])",
			'mit = TextCallout("info", "Mitigation", "Add a guardrail before the next flip.")',
		].join("\n");
		const res = mergeBodyPatch(RISK_BODY, patch);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.body).toContain("mit = TextCallout");
		// original callout kept (not re-sent in the patch)
		expect(res.body).toContain("Flipping between the two campaigns");
	});

	it("extends a metric series (add a data point)", () => {
		const patch = [
			'chart = LineChart(["Wk 1", "Wk 2", "Wk 3", "Wk 4"], [series1])',
			'series1 = Series("WAU", [12400, 13100, 13900, 14600])',
		].join("\n");
		const res = mergeBodyPatch(METRIC_BODY, patch);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.body).toContain("14600");
		expect(res.body).toContain("Wk 4");
		expect(res.body).toContain("Weekly active users");
	});
});

describe("mergeBodyPatch — fallback cases", () => {
	it("fails when the patch introduces a dangling reference", () => {
		// root now points at `ghost`, which is never defined → unresolved
		const patch = "root = Card([head, callout, ghost])";
		const res = mergeBodyPatch(RISK_BODY, patch);
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.reason).toContain("ghost");
	});

	it("fails when there is no existing body to patch against", () => {
		expect(mergeBodyPatch("", 'callout = Callout("info", "x", "y")').ok).toBe(
			false,
		);
	});

	it("fails on an empty patch", () => {
		expect(mergeBodyPatch(RISK_BODY, "   ").ok).toBe(false);
	});

	it("garbage patch is a safe no-op — body preserved unchanged", () => {
		// Pure garbage parses to zero statements; mergeStatements returns the
		// original body, which still validates. The node is never corrupted.
		const res = mergeBodyPatch(RISK_BODY, "this is ::: not @@@ valid (((");
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.body.trim()).toBe(RISK_BODY.trim());
	});
});
