import { describe, expect, it } from "vite-plus/test";
import { counted, formatBytes, usedPercent } from "./usage-format";

describe("formatBytes", () => {
  it.each([
    [0, "0 bytes"],
    [1, "1 byte"],
    [1023, "1.023 bytes"],
    [1024, "1 KiB"],
    [9805, "9,6 KiB"],
    [3945, "3,9 KiB"],
    [524288, "512 KiB"],
    [1048575, "1 MiB"],
    [1048576, "1 MiB"],
    [1153434, "1,1 MiB"],
    [18 * 1024 * 1024, "18 MiB"],
    [1e12, "931,3 GiB"],
  ])("%d bytes reads %s", (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text);
  });
  it("rounds half up with integers only, at the exact boundary", () => {
    // 1.126,4 bytes is 1,1 KiB; 1.177,6 (1,15 KiB) is the first to read 1,2.
    expect(formatBytes(1126)).toBe("1,1 KiB");
    expect(formatBytes(1177)).toBe("1,1 KiB");
    expect(formatBytes(1178)).toBe("1,2 KiB");
  });
  it("refuses what is not a whole number of bytes", () => {
    expect(formatBytes(-1)).toBe("");
    expect(formatBytes(1.5)).toBe("");
  });
});

describe("counted", () => {
  it("agrees in number in pt-BR, zero included", () => {
    expect(counted(0, "reservado", "reservados")).toBe("0 reservados");
    expect(counted(1, "reservado", "reservados")).toBe("1 reservado");
    expect(counted(3945, "reservado", "reservados")).toBe("3.945 reservados");
  });
});

describe("usedPercent", () => {
  it("rounds down, so 100% means the limit was reached", () => {
    expect(usedPercent(0, 5)).toBe(0);
    expect(usedPercent(4, 5)).toBe(80);
    expect(usedPercent(5, 5)).toBe(100);
    expect(usedPercent(996, 1000)).toBe(99);
    expect(usedPercent(7, 5)).toBe(100);
    expect(usedPercent(1, 1048576)).toBe(0);
  });
  it("treats a zero limit as reached", () => {
    expect(usedPercent(0, 0)).toBe(100);
  });
});
