import { expect, test } from "bun:test";
import { ensureChatGptPersonalizedConnectorAccess } from "../src/adapters/chatgpt-web/browser-worker";

function visibleLocator(count: () => number, overrides: Record<string, unknown> = {}) {
  const locator = {
    filter: () => locator,
    count: async () => count(),
    ...overrides,
  };
  return locator;
}

test("an already Personalized Temporary Chat is a connector preflight no-op", async () => {
  const diagnostics: string[] = [];
  const personalized = visibleLocator(() => 1);
  const unpersonalized = visibleLocator(() => 0);
  const page = {
    getByRole: (_role: string, options: { name: string }) => (
      options.name === "Personalized" ? personalized : unpersonalized
    ),
  } as any;

  expect(await ensureChatGptPersonalizedConnectorAccess(
    page,
    async checkpoint => { diagnostics.push(checkpoint); },
  )).toBe("already-personalized");
  expect(diagnostics).toEqual(["personalization-already-enabled"]);
});

test("a missing personalization control fails closed before connector selection", async () => {
  const diagnostics: string[] = [];
  const absent = visibleLocator(() => 0);
  const page = { getByRole: () => absent } as any;

  await expect(ensureChatGptPersonalizedConnectorAccess(
    page,
    async checkpoint => { diagnostics.push(checkpoint); },
  )).rejects.toMatchObject({
    status: 424,
    code: "connector_not_found",
    retryable: false,
  });
  expect(diagnostics).toEqual(["personalization-control-missing"]);
});

test("an Unpersonalized Temporary Chat is switched through its owned radio menu and re-proved", async () => {
  let enabled = false;
  let menuOpen = false;
  const events: string[] = [];
  const diagnostics: string[] = [];
  const personalized = visibleLocator(() => enabled ? 1 : 0, {
    waitFor: async ({ state }: { state: string }) => {
      expect(state).toBe("visible");
      expect(enabled).toBeTrue();
      events.push("personalized-visible");
    },
  });
  const unpersonalized = visibleLocator(() => enabled ? 0 : 1, {
    click: async () => { menuOpen = true; events.push("control-clicked"); },
    getAttribute: async (name: string) => {
      expect(name).toBe("aria-controls");
      expect(menuOpen).toBeTrue();
      return "personalization-menu";
    },
    waitFor: async ({ state }: { state: string }) => {
      expect(state).toBe("hidden");
      expect(enabled).toBeTrue();
      events.push("unpersonalized-hidden");
    },
  });
  const choice = {
    count: async () => 1,
    click: async () => { enabled = true; events.push("choice-clicked"); },
  };
  const menu = {
    waitFor: async ({ state }: { state: string }) => {
      expect(state).toBe("visible");
      expect(menuOpen).toBeTrue();
      events.push("menu-visible");
    },
    locator: (selector: string) => {
      expect(selector).toBe('[role="menuitemradio"], [role="radio"]');
      return {
        filter: ({ hasText }: { hasText: RegExp }) => {
          expect(hasText.test("PersonalizedThis chat can reference plugins")).toBeTrue();
          return choice;
        },
      };
    },
  };
  const page = {
    getByRole: (_role: string, options: { name: string }) => (
      options.name === "Personalized" ? personalized : unpersonalized
    ),
    locator: (selector: string) => {
      expect(selector).toBe('[id="personalization-menu"]');
      return menu;
    },
  } as any;

  expect(await ensureChatGptPersonalizedConnectorAccess(
    page,
    async checkpoint => { diagnostics.push(checkpoint); },
  )).toBe("enabled");
  expect(diagnostics).toEqual(["personalization-unpersonalized", "personalization-enabled"]);
  expect(events).toEqual([
    "control-clicked",
    "menu-visible",
    "choice-clicked",
    "personalized-visible",
    "unpersonalized-hidden",
  ]);
});

test("a localized already-Personalized Temporary Chat is proved by connector catalog access without clicking UI", async () => {
  const diagnostics: string[] = [];
  const absent = visibleLocator(() => 0);
  const page = { getByRole: () => absent } as any;

  expect(await ensureChatGptPersonalizedConnectorAccess(
    page,
    async checkpoint => { diagnostics.push(checkpoint); },
    async () => true,
  )).toBe("already-personalized");
  expect(diagnostics).toEqual(["personalization-already-enabled"]);
});

test("a localized Unpersonalized Temporary Chat toggles the structural state and proves connector access", async () => {
  let connectorCatalogAvailable = false;
  let menuOpen = false;
  let personalized = false;
  const diagnostics: string[] = [];
  const absent = visibleLocator(() => 0);
  const choices = {
    filter: () => choices,
    count: async () => 2,
    nth: (index: number) => ({
      getAttribute: async (name: string) => {
        if (name === "aria-checked") return String(index === (personalized ? 1 : 0));
        if (name === "data-state") return index === (personalized ? 1 : 0) ? "checked" : "unchecked";
        return null;
      },
      click: async () => {
        expect(index).toBe(1);
        personalized = true;
        connectorCatalogAvailable = true;
        menuOpen = false;
      },
    }),
  };
  const menu = {
    waitFor: async ({ state }: { state: string }) => {
      expect(state).toBe("visible");
      expect(menuOpen).toBeTrue();
    },
    locator: (selector: string) => {
      expect(selector).toBe('[role="menuitemradio"], [role="radio"]');
      return choices;
    },
  };
  const control = {
    getAttribute: async (name: string) => {
      expect(name).toBe("aria-controls");
      return "localized-personalization-menu";
    },
    click: async () => { menuOpen = true; },
  };
  const controls = {
    filter: () => controls,
    count: async () => 1,
    first: () => control,
  };
  const page = {
    getByRole: () => absent,
    locator: (selector: string) => {
      if (selector.includes('button[aria-haspopup="menu"]')) return controls;
      expect(selector).toBe('[id="localized-personalization-menu"]');
      return menu;
    },
    keyboard: { press: async () => {} },
  } as any;

  expect(await ensureChatGptPersonalizedConnectorAccess(
    page,
    async checkpoint => { diagnostics.push(checkpoint); },
    async () => connectorCatalogAvailable,
  )).toBe("enabled");
  expect(diagnostics).toEqual(["personalization-unpersonalized", "personalization-enabled"]);
  expect(personalized).toBeTrue();
});

test("ambiguous personalization controls fail before connector selection", async () => {
  const visible = visibleLocator(() => 1);
  const page = { getByRole: () => visible } as any;

  await expect(ensureChatGptPersonalizedConnectorAccess(page)).rejects.toMatchObject({
    status: 424,
    code: "connector_not_found",
    retryable: false,
  });
});
