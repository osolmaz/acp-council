const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * A member's environment variables with each `${NAME}` replaced by that variable of acp-council's own environment.
 * A name that is not set fails the launch, because an agent without its key or address would fail later and less
 * clearly.
 */
export function memberEnv(
  values: Record<string, string> | undefined,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(values ?? {})) {
    env[name] = value.replace(REFERENCE, (_match, reference: string) => {
      const resolved = source[reference];
      if (resolved === undefined) {
        throw new Error(`the member's ${name} names \${${reference}}, which is not set in acp-council's environment`);
      }
      return resolved;
    });
  }
  return env;
}
