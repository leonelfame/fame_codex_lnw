import { expect, test } from "bun:test";
import { ChatGptMarkdownBuffer, type ChatGptMarkdownSegment } from "../src/adapters/chatgpt-web/markdown";

function block(index: number): ChatGptMarkdownSegment {
  return { key: `block-${index}`, tag: "p", html: `<p>Paragraph ${index}</p>`,
    text: `Paragraph ${index}`, sourceStart: index * 100, sourceEnd: index * 100 + 99, streamable: true };
}

test("rechecking a long streamed answer has a linear identity-read budget", () => {
  const blocks = Array.from({ length: 1_000 }, (_, index) => block(index));
  const buffer = new ChatGptMarkdownBuffer(undefined, 0);
  const expected = blocks.map(segment => segment.text).join("\n\n");
  expect(buffer.observe(blocks, 0)).toBe(expected);
  let identityReads = 0;
  // Count input accesses instead of wall time: a slow CI machine must not fail this budget.
  const observed = blocks.map(segment => new Proxy(segment, {
    get(target, property, receiver) {
      if (property === "sourceStart" || property === "key" || property === "tag") identityReads += 1;
      return Reflect.get(target, property, receiver);
    },
  }));
  expect(buffer.observe(observed, 1_000)).toBe("");
  expect(buffer.finish()).toEqual({ markdown: expected, delta: "" });
  expect(identityReads).toBeLessThan(blocks.length * 20);
});

test("ranged blocks still detect rewritten text and accept virtualized prefixes", () => {
  const buffer = new ChatGptMarkdownBuffer(undefined, 0);
  buffer.observe([block(0), block(1)], 0);
  expect(buffer.observe([block(1), block(2)], 1)).toBe("\n\nParagraph 2");
  expect(buffer.observe([{ ...block(1), text: "rewritten" }], 2)).toBe("");
  expect(() => buffer.finish()).toThrow("changed a completed text block");
  expect(buffer.observe([block(2)], 3)).toBe("");
  expect(buffer.finish().markdown).toBe("Paragraph 0\n\nParagraph 1\n\nParagraph 2");
});

test("mixed ranged and unranged identities preserve earliest matching block", () => {
  const buffer = new ChatGptMarkdownBuffer(undefined, 0);
  buffer.observe([{ ...block(0), sourceStart: undefined, sourceEnd: undefined, key: "shared" }, block(1)], 0);
  // The earlier unranged key wins over the later source-range match, as in the original matcher.
  buffer.observe([{ ...block(1), key: "shared" }], 1);
  expect(() => buffer.finish()).toThrow("changed a completed text block");
});

test("unranged semantic fallback requires an unambiguous tag and text", () => {
  const buffer = new ChatGptMarkdownBuffer(undefined, 0);
  buffer.observe([block(0), block(1)], 0);
  expect(buffer.observe([{ ...block(1), key: "remounted", sourceStart: undefined, sourceEnd: undefined }], 1)).toBe("");
  expect(buffer.finish().markdown).toBe("Paragraph 0\n\nParagraph 1");
  const ambiguous = new ChatGptMarkdownBuffer(undefined, 0);
  ambiguous.observe([block(0), { ...block(1), text: "Paragraph 0", html: "<p>Paragraph 0</p>" }], 0);
  ambiguous.observe([{ ...block(0), key: "remounted", sourceStart: undefined, sourceEnd: undefined }], 1);
  expect(() => ambiguous.finish()).toThrow("could not be aligned");
});

test("a ranged identity does not match a different ranged block just because its key matches", () => {
  const buffer = new ChatGptMarkdownBuffer(undefined, 0);
  buffer.observe([block(0)], 0);
  expect(buffer.observe([{ ...block(1), key: block(0).key }], 1)).toBe("\n\nParagraph 1");
  expect(buffer.finish().markdown).toBe("Paragraph 0\n\nParagraph 1");
});

test("finish indexes the unstreamable tail for subsequent observations", () => {
  const buffer = new ChatGptMarkdownBuffer(undefined, 0);
  buffer.observe([{ ...block(0), streamable: false }], 0);
  expect(buffer.finish()).toEqual({ markdown: "Paragraph 0", delta: "Paragraph 0" });
  expect(buffer.observe([block(0), block(1)], 1)).toBe("\n\nParagraph 1");
  expect(buffer.finish()).toEqual({ markdown: "Paragraph 0\n\nParagraph 1", delta: "" });
});

test("reordered committed blocks remain inconsistent without source ranges", () => {
  const buffer = new ChatGptMarkdownBuffer(undefined, 0);
  const blocks = [block(0), block(1)].map(segment => ({ ...segment, sourceStart: undefined, sourceEnd: undefined }));
  buffer.observe(blocks, 0);
  buffer.observe([...blocks].reverse(), 1);
  expect(() => buffer.finish()).toThrow("changed a completed text block");
});
