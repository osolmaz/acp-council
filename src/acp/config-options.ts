import type { SessionConfigOption, SessionConfigSelectOption } from "@agentclientprotocol/sdk";

export type OptionChoice = { configId: string; value: string; name: string };

export function selectValues(option: SessionConfigOption): SessionConfigSelectOption[] {
  if (option.type !== "select") {
    return [];
  }
  return option.options.flatMap((entry) => ("group" in entry ? entry.options : [entry]));
}

function matchValue(option: SessionConfigOption, wanted: string): SessionConfigSelectOption | undefined {
  const values = selectValues(option);
  const lower = wanted.toLowerCase();
  return values.find((value) => value.value === wanted) ?? values.find((value) => value.name.toLowerCase() === lower);
}

function describe(option: SessionConfigOption): string {
  return selectValues(option)
    .map((value) => `${value.value} (${value.name})`)
    .join(", ");
}

function choose(option: SessionConfigOption, wanted: string): OptionChoice {
  const match = matchValue(option, wanted);
  if (match === undefined) {
    throw new Error(`the agent does not offer ${wanted} for ${option.id}; it offers: ${describe(option)}`);
  }
  return { configId: option.id, value: match.value, name: match.name };
}

export function findModelOption(options: SessionConfigOption[]): SessionConfigOption | undefined {
  const models = options.filter(
    (option) => option.type === "select" && (option.category === "model" || option.id === "model"),
  );
  return models.find((option) => option.id === "model") ?? models[0];
}

/**
 * Turns a member's model and options into config option values that the agent offers.
 * A value can be given as the option's value or as its display name.
 */
export function planOptions(
  options: SessionConfigOption[],
  model: string | undefined,
  wanted: Record<string, string>,
): OptionChoice[] {
  const choices: OptionChoice[] = [];
  if (model !== undefined) {
    const modelOption = findModelOption(options);
    if (modelOption === undefined) {
      throw new Error(`the agent has no model option, so it cannot select ${model}`);
    }
    choices.push(choose(modelOption, model));
  }
  for (const [configId, value] of Object.entries(wanted)) {
    const option = options.find((candidate) => candidate.id === configId);
    if (option === undefined) {
      throw new Error(`the agent has no config option ${configId}; it has: ${options.map((o) => o.id).join(", ")}`);
    }
    choices.push(choose(option, value));
  }
  return choices;
}
