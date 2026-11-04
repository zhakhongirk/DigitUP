import { describe, expect, it } from "vitest";
import { envName, upsertEnv } from "@/scripts/eval/setup";

describe("eval setup", () => {
  it("names the key variable after the store", () => {
    expect(envName("stride-shoes")).toBe("EVAL_CUSTOMER_KEY_STRIDE_SHOES");
  });

  it("replaces an existing key line", () => {
    expect(upsertEnv("A=1\nEVAL_CUSTOMER_KEY_X=old\nB=2\n", "EVAL_CUSTOMER_KEY_X", "new")).toBe(
      "A=1\nEVAL_CUSTOMER_KEY_X=new\nB=2\n",
    );
  });

  it("appends a missing key on a new line", () => {
    expect(upsertEnv("A=1", "K", "v")).toBe("A=1\nK=v\n");
    expect(upsertEnv("", "K", "v")).toBe("K=v\n");
  });
});
