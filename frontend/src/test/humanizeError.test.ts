import { describe, expect, it } from "vitest";
import { humanFailure } from "../utils/humanizeError";

describe("failure messages preserve attribution uncertainty", () => {
  it("does not equate authentication rejection with expiration", () => {
    const failure = humanFailure("llm_auth_failed", "401 invalid api key");
    expect(failure.msg).toContain("认证失败");
    expect(failure.msg).not.toMatch(/过期|失效/);
    expect(failure.retryable).toBe(false);
  });
  it("does not attribute a syntax error or tool timeout to model ability", () => {
    expect(humanFailure(undefined, "syntax error").msg).toContain("执行环境");
    expect(humanFailure(undefined, "shell timed out").msg).not.toContain("模型");
    expect(humanFailure(undefined, "SpecificFailure ABC").msg).toBe("SpecificFailure ABC");
  });
});
