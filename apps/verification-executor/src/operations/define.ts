import type { z } from "zod";

/**
 * One operation definition feeds three surfaces: a CLI subcommand, a `POST /knowledge/<name>`
 * route, and an MCP tool. Input and output are Zod schemas; `run` is the only place with logic.
 */
export interface CliBinding {
  /** e.g. ["schema", "search"] → `knowledge schema search …` */
  readonly command: readonly [string, string];
  /** Positional argument names, in order; each becomes `input[name]`. */
  readonly positional?: readonly string[];
  /** Positional (or `--<name>`) values that are file paths whose JSON becomes `input[name]`. */
  readonly jsonFiles?: readonly string[];
}

export interface OperationDefinition<TInput extends z.ZodObject, TOutput extends z.ZodType, TContext> {
  readonly name: string;
  readonly title: string;
  /** ≤ 300 characters; shown verbatim as the MCP tool description. */
  readonly description: string;
  readonly input: TInput;
  readonly output: TOutput;
  readonly cli: CliBinding;
  /** Domain quality gate: return a reason to exit 1 even though the operation succeeded. */
  readonly gate?: (output: z.output<TOutput>) => string | undefined;
  readonly run: (input: z.output<TInput>, context: TContext) => Promise<z.output<TOutput>>;
}

export type AnyOperation<TContext> = OperationDefinition<z.ZodObject, z.ZodType, TContext>;

const MAX_DESCRIPTION = 300;

export function defineOperation<TInput extends z.ZodObject, TOutput extends z.ZodType, TContext>(
  definition: OperationDefinition<TInput, TOutput, TContext>,
): OperationDefinition<TInput, TOutput, TContext> {
  if (!/^[a-z][a-z0-9_]*$/.test(definition.name))
    throw new Error(`operation name must be snake_case: ${definition.name}`);
  if (definition.description.length > MAX_DESCRIPTION)
    throw new Error(`${definition.name}: description exceeds ${MAX_DESCRIPTION} characters`);
  return definition;
}

export class OperationRegistry<TContext> {
  readonly #byName = new Map<string, AnyOperation<TContext>>();

  constructor(operations: readonly AnyOperation<TContext>[]) {
    for (const operation of operations) {
      if (this.#byName.has(operation.name)) throw new Error(`duplicate operation ${operation.name}`);
      this.#byName.set(operation.name, operation);
    }
  }

  list(): readonly AnyOperation<TContext>[] {
    return [...this.#byName.values()];
  }
  get(name: string): AnyOperation<TContext> | undefined {
    return this.#byName.get(name);
  }

  byCommand(group: string, sub: string): AnyOperation<TContext> | undefined {
    return this.list().find((operation) => operation.cli.command[0] === group && operation.cli.command[1] === sub);
  }

  /** Validates input, runs, and validates output — the shared path for CLI, HTTP, and MCP. */
  async invoke(
    name: string,
    rawInput: unknown,
    context: TContext,
  ): Promise<{ operation: AnyOperation<TContext>; output: unknown }> {
    const operation = this.#byName.get(name);
    if (!operation)
      throw new UnknownOperationError(
        name,
        this.list().map((item) => item.name),
      );
    const input = operation.input.parse(rawInput ?? {});
    const output = operation.output.parse(await operation.run(input, context));
    return { operation, output };
  }
}

export class UnknownOperationError extends Error {
  override readonly name = "UnknownOperationError";
  constructor(
    readonly operation: string,
    readonly known: readonly string[],
  ) {
    super(`unknown operation ${operation}`);
  }
}
