import { expect, test } from "bun:test";
import { copyFor } from "../launcher/src/i18n";

test("supported launcher locales return complete, nonempty dictionaries", () => {
  const english = copyFor("en");
  const keys = Object.keys(english).sort();
  for (const language of ["th"] as const) {
    const translated = copyFor(language);
    expect(Object.keys(translated).sort()).toEqual(keys);
    expect(Object.values(translated).every(text => text.trim().length > 0)).toBe(true);
    expect(translated.install).not.toBe(english.install);
    expect(translated.done).not.toBe(english.done);
    for (const key of keys as Array<keyof typeof english>) {
      if (["product", "devBadge", "english", "thai", "manualInteraction", "tunnelId", "zeroRiskProProfile"].includes(key)) continue;
      expect(translated[key], `Thai copy for ${key}`).toMatch(/[\u0e00-\u0e7f]/);
    }
  }
});
