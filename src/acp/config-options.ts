import type { SessionConfigOption, SessionConfigSelectOption } from "@agentclientprotocol/sdk";

/** A value to send for one config option, and the text the member asked for. */
export type OptionRequest = { configId: string; requested: string; value: string };

/** What the agent reports after it set an option: its current value and that value's display name. */
export type OptionChoice = OptionRequest & { name: string };

export function selectValues(option: SessionConfigOption): SessionConfigSelectOption[] {
  if (option.type !== "select") {
    return [];
  }
  return option.options.flatMap((entry) => ("group" in entry ? entry.options : [entry]));
}

export function describeValues(option: SessionConfigOption): string {
  return selectValues(option)
    .map((value) => `${value.value} (${value.name})`)
    .join(", ");
}

/**
 * The value to send: an offered value as is, the value of an offered display name, or else the requested text
 * itself, which the agent may resolve, such as a full model ID that the agent lists under an alias.
 */
function toRequest(option: SessionConfigOption, requested: string): OptionRequest {
  const lower = requested.toLowerCase();
  const byName = selectValues(option).find((value) => value.name.toLowerCase() === lower);
  const offered = selectValues(option).some((value) => value.value === requested);
  return { configId: option.id, requested, value: offered || byName === undefined ? requested : byName.value };
}

export function findModelOption(options: SessionConfigOption[]): SessionConfigOption | undefined {
  const models = options.filter(
    (option) => option.type === "select" && (option.category === "model" || option.id === "model"),
  );
  return models.find((option) => option.id === "model") ?? models[0];
}

/** Turns a member's model and options into the config option values to send to the agent. */
export function planOptions(
  options: SessionConfigOption[],
  model: string | undefined,
  wanted: Record<string, string>,
): OptionRequest[] {
  const requests: OptionRequest[] = [];
  if (model !== undefined) {
    const modelOption = findModelOption(options);
    if (modelOption === undefined) {
      throw new Error(`the agent has no model option, so it cannot select ${model}`);
    }
    requests.push(toRequest(modelOption, model));
  }
  for (const [configId, value] of Object.entries(wanted)) {
    const option = options.find((candidate) => candidate.id === configId);
    if (option === undefined) {
      throw new Error(`the agent has no config option ${configId}; it has: ${options.map((o) => o.id).join(", ")}`);
    }
    requests.push(toRequest(option, value));
  }
  return requests;
}

/** Reads back what the agent set for a request, from the config options it returned. */
export function appliedChoice(request: OptionRequest, options: SessionConfigOption[]): OptionChoice {
  const option = options.find((candidate) => candidate.id === request.configId);
  const current = option?.type === "select" ? option.currentValue : request.value;
  const name =
    option === undefined ? current : (selectValues(option).find((v) => v.value === current)?.name ?? current);
  return { ...request, value: current, name };
}
