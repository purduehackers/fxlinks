import { expect, mock, test } from "bun:test";
import { createPostCache } from "./cache.ts";
import type { Post } from "./embed.ts";

const post = (text: string): Post => ({ text, author: { name: "Example", handle: "example", url: "https://x.com/example" }, media: [], original: "https://x.com/example/status/1", stats: {} });

test("metadata cache obeys its byte budget and skips oversized entries", async () => {
  const cached = createPostCache();
  const large = mock(async () => post("x".repeat(1_100_000)));
  await cached("a", large);
  await cached("b", large);
  await cached("a", large);
  expect(large).toHaveBeenCalledTimes(3);
  const oversized = mock(async () => post("x".repeat(2_100_000)));
  await cached("oversized", oversized);
  await cached("oversized", oversized);
  expect(oversized).toHaveBeenCalledTimes(2);
  await cached("a", large);
  expect(large).toHaveBeenCalledTimes(3);
});
