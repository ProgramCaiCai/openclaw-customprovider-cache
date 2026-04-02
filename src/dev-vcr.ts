import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const REDACTED = "[REDACTED]";
const SECRET_KEY_PATTERN =
  /^(authorization|proxy-authorization|x-api-key|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|secret|password|cookie|set-cookie)$/i;
const SECRET_VALUE_PATTERN = /Bearer\s+\S+|(?:^|[^a-z])(sk|rk|pk|ak)-[a-z0-9._-]{8,}/i;

export type DevVcrMode = "auto" | "record" | "replay";

type StoredDevVcrFixture<TFixture> = {
  version: 1;
  fixtureName: string;
  input: unknown;
  output: TFixture;
};

function sanitizeDevVcrValue(value: unknown, key?: string): unknown {
  if (key && SECRET_KEY_PATTERN.test(key)) {
    return REDACTED;
  }

  if (typeof value === "string") {
    return SECRET_VALUE_PATTERN.test(value) ? REDACTED : value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeDevVcrValue(entry));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeDevVcrValue(entryValue, entryKey),
      ]),
    );
  }

  return value;
}

function resolveFixturePath(fixtureRoot: string, fixtureName: string, input: unknown): string {
  const hash = createHash("sha1")
    .update(JSON.stringify(sanitizeDevVcrValue(input)))
    .digest("hex")
    .slice(0, 12);
  return join(fixtureRoot, `${fixtureName}-${hash}.json`);
}

export async function withDevVcrFixture<TFixture>(params: {
  fixtureRoot: string;
  fixtureName: string;
  input: unknown;
  mode?: DevVcrMode;
  build: () => Promise<TFixture>;
}): Promise<TFixture> {
  const mode = params.mode ?? "auto";
  const fixturePath = resolveFixturePath(params.fixtureRoot, params.fixtureName, params.input);

  try {
    const stored = JSON.parse(await readFile(fixturePath, "utf8")) as StoredDevVcrFixture<TFixture>;
    return stored.output;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  if (mode === "replay") {
    throw new Error(`Missing VCR fixture for replay: ${fixturePath}`);
  }

  const output = sanitizeDevVcrValue(await params.build()) as TFixture;
  const payload: StoredDevVcrFixture<TFixture> = {
    version: 1,
    fixtureName: params.fixtureName,
    input: sanitizeDevVcrValue(params.input),
    output,
  };
  await mkdir(dirname(fixturePath), { recursive: true });
  await writeFile(fixturePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return output;
}
