import { describe, expect, test } from "bun:test";
import { assertSafeRemoteUrl, isPrivateIp } from "./netGuard";

describe("isPrivateIp", () => {
  test("blocks loopback/private/link-local/CGNAT/reserved (v4)", () => {
    for (const ip of [
      "0.0.0.0",
      "10.1.2.3",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "198.18.0.1",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isPrivateIp(ip)).toBe(true);
    }
  });

  test("allows public v4", () => {
    for (const ip of ["1.1.1.1", "8.8.8.8", "172.32.0.1", "93.184.216.34"]) {
      expect(isPrivateIp(ip)).toBe(false);
    }
  });

  test("blocks v6 loopback/ULA/link-local/mapped (v6)", () => {
    for (const ip of ["::1", "fc00::1", "fd00:ec2::254", "fe80::1", "::ffff:127.0.0.1"]) {
      expect(isPrivateIp(ip)).toBe(true);
    }
  });

  test("allows public v6", () => {
    expect(isPrivateIp("2606:4700:4700::1111")).toBe(false);
  });
});

describe("assertSafeRemoteUrl", () => {
  test("rejects http where https is required", async () => {
    await expect(
      assertSafeRemoteUrl("http://example.com/list", { protocols: ["https:"] }),
    ).rejects.toThrow(/protocol/);
  });

  test("rejects credentials in the URL", async () => {
    await expect(assertSafeRemoteUrl("https://user:pass@1.1.1.1/")).rejects.toThrow(/credentials/);
  });

  test("rejects metadata and private IP literals", async () => {
    for (const url of [
      "https://169.254.169.254/latest/meta-data",
      "https://metadata.google.internal/",
      "https://127.0.0.1/",
      "https://10.0.0.5/",
      "https://[::1]/",
      "https://[fd00:ec2::254]/",
    ]) {
      await expect(assertSafeRemoteUrl(url)).rejects.toThrow();
    }
  });

  test("ALLOW_PRIVATE_TARGETS permits private literals but not metadata", async () => {
    await expect(assertSafeRemoteUrl("https://127.0.0.1/", { allowPrivate: true })).resolves.toBeInstanceOf(URL);
    await expect(
      assertSafeRemoteUrl("https://169.254.169.254/", { allowPrivate: true }),
    ).rejects.toThrow(/metadata/);
  });
});
