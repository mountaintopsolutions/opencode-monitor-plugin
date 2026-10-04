// OpenCode v2 server-plugin surface.
//
// The v1 `server()` factory in ./index.ts is unchanged and remains the v1
// entrypoint. This module supplies the v2 half (`id` + `setup`) so one default
// export can satisfy both loaders:
//
//   export default { id, setup, server }
//
// Established by probing opencode 1.18.34 and 2.0.22, not from docs:
//   v1 requires the default export to be an object with server()
//   v2 requires an object with id + setup, reads plugin.id, calls setup, and
//   tolerates the extra `server` key
// Neither loader rejects the combined shape.
//
// v2 API differences handled here, with shapes taken from the installed
// @opencode/plugin@2 and @opencode/schema type definitions:
//
//   tools     tool({ args: zod })        -> ctx.tool.transform(editor.add)
//                                            Tool.Info = { name, input, description,
//                                            execute, options? }
//                                            Tool.Context = { sessionID, agent,
//                                            messageID, id, signal, progress }
//                                            Tool.Result = { content?: string | Content[] }
//   commands  mutate config.command      -> ctx.command.transform(editor.add)
//                                            CommandInvocation = { sessionID, prompt, delivery }
//                                            submitted with ctx.session.prompt
//   events    an `event` hook            -> ctx.event.subscribe() async iterable
//   delivery  client.session.promptAsync -> ctx.session.synthetic
//
// Parsers, registry, runner, monitor engine, idle queue and bridge are shared
// with v1 unchanged.
//
// Tool names are registered WITHOUT a namespace, using the same full
// opencode_monitor_* identifiers as v1. v2 would join a namespace and name with
// an underscore to produce the same string, but keeping the literal name means
// the identifiers the command templates hardcode cannot drift.

export const PLUGIN_ID = 'opencode-monitor';

type V1Factory = (input: any, options?: Record<string, unknown>) => Promise<any>;

export interface V2Ctx {
  location: { directory: string };
  options: Record<string, unknown>;
  session: {
    prompt(input: any): Promise<unknown>;
    synthetic(input: {
      sessionID: string;
      text: string;
      metadata?: Record<string, unknown>;
      agent?: string;
    }): Promise<unknown>;
  };
  tool: { transform(cb: (editor: any) => void): Promise<unknown> };
  command: { transform(cb: (editor: any) => void): Promise<unknown> };
  event: { subscribe(options?: { signal?: AbortSignal }): AsyncIterable<any> };
}

/** v2 Tool.Context, narrowed to what this plugin reads. */
interface V2ToolContext {
  sessionID: string;
  agent: string;
  messageID: string;
  id: string;
  signal: AbortSignal;
  progress(update: unknown): Promise<void>;
}

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

// Mirrors the six v1 tools, which declare arguments with zod. v2 takes a plain
// JSON Schema (Tool.ValueSchema accepts JsonSchema), so the shapes are restated.
const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'opencode_monitor_background',
    description: 'Start a shell command in the background. Returns immediately with the job ID; final output is delivered to the session when idle.',
    input: objectInput({ command: stringArg('Command to run via /bin/sh -c') }, ['command']),
  },
  {
    name: 'opencode_monitor_monitor',
    description: 'Start a monitored shell command. Raw args use /monitor syntax, including --regex and command after --.',
    input: objectInput({ raw: stringArg('Raw /monitor arguments') }, ['raw']),
  },
  {
    name: 'opencode_monitor_loop',
    description: 'Start a prompt loop. Raw args use /loop syntax: <interval> <prompt>.',
    input: objectInput({ raw: stringArg('Raw /loop syntax: <interval> <prompt>') }, ['raw']),
  },
  {
    name: 'opencode_monitor_schedule',
    description: 'Schedule one prompt. Raw args use /schedule syntax: in <duration> <prompt> or at <iso-date> <prompt>.',
    input: objectInput({ raw: stringArg('Raw /schedule arguments') }, ['raw']),
  },
  {
    name: 'opencode_monitor_jobs',
    description: 'List opencode-monitor jobs owned by the current session.',
    input: objectInput({}),
  },
  {
    name: 'opencode_monitor_cancel',
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

// v1 appended "$ARGUMENTS" to a template string. v2 hands the command body to
// `execute` as an already-substituted prompt, so the instruction and the user's
// arguments arrive separately and are joined here.
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
  const directory = ctx.location.directory;
  return server(
    {
      directory,
      worktree: directory,
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
    const directory = ctx.location.directory;

    await ctx.tool.transform((editor: any) => {
      for (const spec of TOOL_SPECS) {
        const v1Tool = instance.tool?.[spec.name];
        if (!v1Tool) continue;
        editor.add({
          name: spec.name,
          description: spec.description,
          input: spec.input,
          execute: async (input: any, context: V2ToolContext) => {
            // v1 tool executors expect { sessionID, agent, messageID, abort,
            // directory, worktree }. v2 renamed abort to signal and does not
            // carry the directories, so both are supplied here.
            const result = await v1Tool.execute(input ?? {}, {
              sessionID: context.sessionID,
              agent: context.agent,
              messageID: context.messageID,
              abort: context.signal,
              directory,
              worktree: directory,
            });
            // Tool.Result accepts `content` as a plain string. v1 tools return
            // strings such as "started bg_1".
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
          execute: async ({ sessionID, prompt, delivery }: any) => {
            // A user-invoked command is real input, not a synthetic message, so
            // it goes through session.prompt rather than session.synthetic.
            await ctx.session.prompt({
              ...prompt,
              sessionID,
              delivery,
              text: `${body}\n\n${prompt?.text ?? ''}`,
            });
          },
        });
      }
    });

    // v2 has no per-event hook; consume the stream and stop on cleanup.
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          await instance.event?.({ event });
        }
      } catch {
        // The stream ends when the signal aborts; a transport error during
        // shutdown must not surface as an unhandled rejection.
      }
    })();

    return async () => {
      controller.abort();
      await instance.dispose?.();
    };
  };
}
