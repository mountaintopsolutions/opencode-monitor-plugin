// OpenCode v2 plugin surface.
//
// The v1 `server()` factory in ./index.ts is unchanged and remains the v1
// entrypoint. This module supplies the v2 half (`id` + `setup`) so one default
// export can satisfy both loaders:
//
//   export default { id, setup, server }
//
// Verified against the real loaders: v1 requires an object with `server()` and
// ignores the extra keys; v2 requires `id` + `setup`, tolerates `server`, and
// calls `setup`. Neither loader rejects the combined shape.
//
// v2 differences handled here:
//   tools    : tool({ args: zodSchema })       -> ctx.tool.transform, raw JSON Schema
//   commands : mutate config.command           -> ctx.command.transform
//   events   : an `event` hook                 -> ctx.event.subscribe() async iterable
//   delivery : client.session.promptAsync      -> ctx.session.synthetic
//
// Parsers, registry, runner, monitor engine, idle queue and bridge are shared
// with v1 unchanged.

export const PLUGIN_ID = 'opencode-monitor';

type V2Session = {
  synthetic(input: {
    sessionID: string;
    text: string;
    metadata?: Record<string, unknown>;
    agent?: string;
    delivery?: string;
  }): Promise<unknown>;
};

export interface V2Ctx {
  location: { directory: string };
  options: Record<string, unknown>;
  session: V2Session;
  tool: { transform(cb: (editor: any) => void): Promise<unknown> };
  command: { transform(cb: (editor: any) => void): Promise<unknown> };
  event: { subscribe(options?: { signal?: AbortSignal }): AsyncIterable<any> };
}

type V1Factory = (input: any, options?: Record<string, unknown>) => Promise<any>;

const stringArg = (description: string) => ({ type: 'string', description });
const objectInput = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

interface ToolSpec {
  name: string;
  description: string;
  input: Record<string, unknown>;
}

// Mirrors the six v1 tools, which declare their arguments with zod. v2 takes a
// plain JSON Schema object, so the shapes are restated here rather than derived.
const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'background',
    description: 'Start a shell command in the background. Returns immediately with the job ID; final output is delivered to the session when idle.',
    input: objectInput({ command: stringArg('Command to run via /bin/sh -c') }, ['command']),
  },
  {
    name: 'monitor',
    description: 'Start a monitored shell command. Raw args use /monitor syntax, including --regex and command after --.',
    input: objectInput({ raw: stringArg('Raw /monitor arguments') }, ['raw']),
  },
  {
    name: 'loop',
    description: 'Start a prompt loop. Raw args use /loop syntax: <interval> <prompt>.',
    input: objectInput({ raw: stringArg('Raw /loop syntax: <interval> <prompt>') }, ['raw']),
  },
  {
    name: 'schedule',
    description: 'Schedule one prompt. Raw args use /schedule syntax: in <duration> <prompt> or at <iso-date> <prompt>.',
    input: objectInput({ raw: stringArg('Raw /schedule arguments') }, ['raw']),
  },
  {
    name: 'jobs',
    description: 'List opencode-monitor jobs owned by the current session.',
    input: objectInput({}),
  },
  {
    name: 'cancel',
    description: 'Cancel an opencode-monitor job owned by the current session.',
    input: objectInput({ jobID: stringArg('Job ID to cancel') }, ['jobID']),
  },
];

const COMMAND_DESCRIPTIONS: Record<string, string> = {
  background: 'Run a shell command in the background and report when it exits.',
  monitor: 'Run a shell command and report matching output windows.',
  loop: 'Repeatedly submit a prompt on an interval.',
  schedule: 'Submit a prompt once in the future.',
  jobs: 'List opencode-monitor jobs for this session.',
  cancel: 'Cancel an opencode-monitor job for this session.',
};

// v2 hands the command body to `execute` as an already-substituted prompt
// rather than a template string, so v1's "$ARGUMENTS" suffix becomes prompt.text.
const COMMAND_BODIES: Record<string, string> = {
  background: 'Use the `opencode_monitor_background` tool with command exactly as written below. Return the tool result.',
  monitor: 'Use the `opencode_monitor_monitor` tool. Pass the raw monitor arguments exactly as written below. Return the tool result.',
  loop: 'Use the `opencode_monitor_loop` tool. Pass the raw loop arguments exactly as written below. Return the tool result.',
  schedule: 'Use the `opencode_monitor_schedule` tool. Pass the raw schedule arguments exactly as written below. Return the tool result.',
  jobs: 'Use the `opencode_monitor_jobs` tool and return the tool result.',
  cancel: 'Use the `opencode_monitor_cancel` tool with the job ID exactly as written below. Return the tool result.',
};

/**
 * Instantiate the v1 plugin with delivery routed through v2's synthetic prompt
 * API instead of the v1 client.
 *
 * v2's session.synthetic accepted `metadata`, `agent` and `delivery` alongside
 * sessionID and text when probed against a running 2.0.22 server, so the job
 * correlation metadata the status store and delivery formatter depend on
 * carries over unchanged. That was the open question gating this port.
 */
async function createForV2(ctx: V2Ctx, server: V1Factory) {
  return server(
    {
      directory: ctx.location.directory,
      worktree: ctx.location.directory,
      client: {
        session: {
          promptAsync: async (options: any) => {
            const part = options?.body?.parts?.[0];
            await ctx.session.synthetic({
              sessionID: options?.path?.id,
              text: part?.text ?? '',
              metadata: { ...(part?.metadata ?? {}) },
              ...(options?.body?.agent ? { agent: options.body.agent } : {}),
            });
            return {};
          },
        },
      },
    },
    ctx.options,
  );
}

/**
 * Build the v2 `setup` entrypoint around the v1 `server` factory.
 *
 * `server` is injected rather than imported so this module never imports
 * ./index.js, which imports this module for the combined default export.
 */
export function createSetup(server: V1Factory) {
  return async function setup(ctx: V2Ctx): Promise<() => Promise<void>> {
    const instance = await createForV2(ctx, server);

    await ctx.tool.transform((editor: any) => {
      for (const spec of TOOL_SPECS) {
        const v1Tool = instance.tool?.[`opencode_monitor_${spec.name}`];
        if (!v1Tool) continue;
        editor.add({
          name: spec.name,
          namespace: 'opencode_monitor',
          description: spec.description,
          input: spec.input,
          execute: async (input: any, context: any) => {
            const result = await v1Tool.execute(input ?? {}, context ?? {});
            return typeof result === 'string' ? { content: result } : result;
          },
        });
      }
    });

    await ctx.command.transform((editor: any) => {
      for (const [name, description] of Object.entries(COMMAND_DESCRIPTIONS)) {
        const body = COMMAND_BODIES[name] ?? '';
        editor.add({
          name,
          description,
          execute: async ({ sessionID, prompt }: any) => {
            await ctx.session.synthetic({ sessionID, text: `${body}\n\n${prompt?.text ?? ''}` });
          },
        });
      }
    });

    // v2 has no per-event hook; consume the stream and stop on cleanup.
    const controller = new AbortController();
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        await instance.event?.({ event });
      }
    })();

    return async () => {
      controller.abort();
      await instance.dispose?.();
    };
  };
}
