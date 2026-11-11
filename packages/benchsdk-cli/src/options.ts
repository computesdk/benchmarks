/** Parsed subcommand options: strings, numbers, switches, and repeatable lists. */
export type SubcommandOptions = Record<string, string | number | boolean | string[]>;

export function optionString(options: SubcommandOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' ? value : undefined;
}

export function optionNumber(options: SubcommandOptions, key: string): number | undefined {
  const value = options[key];
  return typeof value === 'number' ? value : undefined;
}

export function optionFlag(options: SubcommandOptions, key: string): boolean {
  return options[key] === true;
}

export function optionList(options: SubcommandOptions, key: string): string[] | undefined {
  const value = options[key];
  return Array.isArray(value) ? value : undefined;
}

/** Validates a closed-set string option before anything touches the network. */
export function optionChoice<T extends string>(
  options: SubcommandOptions,
  key: string,
  choices: readonly T[],
): T | undefined {
  const value = optionString(options, key);
  if (value === undefined) return undefined;
  if (!(choices as readonly string[]).includes(value)) {
    throw new Error(`--${key} must be one of ${choices.join(', ')}`);
  }
  return value as T;
}

export function isJsonOutput(output: { json?: boolean; format?: string }): boolean {
  return !!output.json || output.format === 'json';
}
