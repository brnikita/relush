import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { COMMANDS, isCommand, runCommand } from "./commands.ts";
import { Session } from "./session.ts";

/**
 * Slash commands, exercised against a real session and a real index.
 *
 * No model calls: every command here is answered locally, which is the
 * property being asserted as much as the output itself.
 */

let session: Session;
let telemetryPath: string;

beforeAll(async () => {
  const cwd = mkdtempSync(join(tmpdir(), "nodrel-cmd-"));
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(
    join(cwd, "src", "money.js"),
    "/** Formats money. */\nexport function formatMoney(v, cur) { return cur + v; }\n",
    "utf8",
  );
  writeFileSync(
    join(cwd, "src", "cart.js"),
    'import { formatMoney } from "./money.js";\nexport function renderCart(i) { return formatMoney(i, "$"); }\n',
    "utf8",
  );

  telemetryPath = join(cwd, "telemetry.jsonl");
  session = new Session({ cwd, apiKey: "unused-no-model-calls", graph: true, telemetryPath });
  await session.index();
});

const run = (line: string) => runCommand(line, { session, telemetryPath, lastPrompt: "money" });

describe("isCommand", () => {
  it.each([
    ["/help", true],
    ["  /cost", true],
    ["fix the bug", false],
    ["what about a/b testing", false],
  ])("classifies %s", (line, expected) => {
    expect(isCommand(line)).toBe(expected);
  });
});

describe("command dispatch", () => {
  it("suggests /help for an unknown command rather than failing", async () => {
    expect((await run("/nonsense")).output).toMatch(/unknown command/);
  });

  it("is case-insensitive", async () => {
    expect((await run("/HELP")).output).toBe((await run("/help")).output);
  });

  it("lists every command in /help", async () => {
    const output = (await run("/help")).output;

    for (const command of COMMANDS) expect(output).toContain(command.usage);
  });

  it("signals exit only for /exit", async () => {
    expect((await run("/exit")).exit).toBe(true);
    expect((await run("/help")).exit).toBeUndefined();
  });
});

describe("/graph", () => {
  it("looks a symbol up from a bare name", async () => {
    const output = (await run("/graph formatMoney")).output;

    expect(output).toContain("formatMoney");
    expect(output).toContain("Formats money.");
  });

  it("strips the closing delimiter from a one-line doc comment", async () => {
    // It would otherwise leak into every signature the model sees.
    expect((await run("/graph formatMoney")).output).not.toContain("*/");
  });

  it("answers 'who calls this' across files", async () => {
    expect((await run("/graph references formatMoney")).output).toContain("renderCart");
  });

  it("counts only symbols in impact, not the files containing them", async () => {
    // The router escalates on this number, so an inflated count changes routing.
    expect((await run("/graph impact formatMoney")).output).toMatch(/1 symbols across 1 files/);
  });

  it("reports what the answer cost", async () => {
    expect((await run("/graph formatMoney")).output).toMatch(/\(\d+ tokens\)/);
  });

  it("explains its usage when given nothing", async () => {
    expect((await run("/graph")).output).toMatch(/usage:/);
  });
});

describe("/model, /fast, /strong", () => {
  it("reports the current layer", async () => {
    expect((await run("/model")).output).toMatch(/layer: flash/);
  });

  it("pins a layer", async () => {
    await run("/model escalation");

    expect((await run("/model")).output).toMatch(/pinned: escalation/);
    await run("/model auto");
  });

  it("rejects an unknown layer without changing anything", async () => {
    const before = (await run("/model")).output;
    expect((await run("/model nonsense")).output).toMatch(/unknown layer/);

    expect((await run("/model")).output).toBe(before);
  });

  it("/fast pins the cheap layer and /strong the expensive one", async () => {
    await run("/fast");
    expect((await run("/model")).output).toMatch(/pinned: flash/);

    await run("/strong");
    expect((await run("/model")).output).toMatch(/pinned: escalation/);

    await run("/model auto");
  });
});

describe("/cost", () => {
  it("reports the escalation invariant, not just a number", async () => {
    const output = (await run("/cost")).output;

    expect(output).toMatch(/escalation\s+[\d.]+% of tokens/);
    expect(output).toMatch(/15% limit/);
  });
});

describe("/reindex and /map", () => {
  it("reindexes and reports what it found", async () => {
    expect((await run("/reindex")).output).toMatch(/\d+ symbols, \d+ edges/);
  });

  it("builds a task map from the last prompt", async () => {
    expect((await run("/map")).output).toContain("# Repository map");
  });

  it("builds a task map from an explicit prompt", async () => {
    expect((await run("/map formatMoney")).output).toContain("formatMoney");
  });
});

describe("/expand", () => {
  it("explains its usage when given nothing", async () => {
    expect((await run("/expand")).output).toMatch(/usage:/);
  });

  it("says so plainly when nothing has been compacted", async () => {
    expect((await run("/expand deadbeef")).output).toMatch(/nothing has been compacted|no cached/);
  });
});
