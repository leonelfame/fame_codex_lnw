import { ChatGptMarkdownBuffer, type ChatGptMarkdownSegment } from "../src/adapters/chatgpt-web/markdown";

// Local synthetic workload: no account, browser, credentials, or network required.
// Measures repeated observations after streaming, excluding initial HTML conversion.
for (const count of [100, 1_000, 3_000]) {
  const segments: ChatGptMarkdownSegment[] = Array.from({ length: count }, (_, index) => ({
    key: `block-${index}`, tag: "p", html: `<p>Paragraph ${index}</p>`, text: `Paragraph ${index}`,
    sourceStart: index * 100, sourceEnd: index * 100 + 99, streamable: true,
  }));
  const buffer = new ChatGptMarkdownBuffer(undefined, 0);
  buffer.observe(segments, 0);
  const expected = segments.map(segment => segment.text).join("\n\n");
  for (let warmup = 0; warmup < 10; warmup += 1) buffer.observe(segments, 1_000);
  const samples: number[] = [];
  for (let sample = 0; sample < 7; sample += 1) {
    const start = performance.now();
    for (let iteration = 0; iteration < 50; iteration += 1) {
      if (buffer.observe(segments, 1_000) !== "") throw new Error("Duplicate streamed text");
    }
    samples.push((performance.now() - start) / 50);
  }
  if (buffer.finish().markdown !== expected) throw new Error("Final Markdown changed");
  samples.sort((a, b) => a - b);
  console.log(JSON.stringify({ blocks: count, medianMsPerObservation: samples[3] }));
}
