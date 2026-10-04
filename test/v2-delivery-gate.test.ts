import { describe, expect, it, vi } from 'vitest';
import { createSetup } from '../src/v2.js';

// The v2 adapter must not push a job notification into a session that is still
// busy: on 2.0.22 that wedges the agent turn and blanks the TUI. It waits on
// the host's own idle signal instead, and skips the injection when the host
// has none.
describe('v2 delivery idle gate', () => {
  const serverInput = {
    directory: '/tmp/project',
    worktree: '/tmp/project',
    client: { session: { promptAsync: vi.fn() } },
  };

  it('waits for the session to be idle before submitting a synthetic prompt', async () => {
    const calls: string[] = [];
    const ctx = {
      location: { directory: '/tmp/project' },
      options: {},
      session: {
        prompt: vi.fn(),
        synthetic: async ({ sessionID }: { sessionID: string }) => { calls.push(sessionID); },
        wait: async ({ sessionID }: { sessionID: string }) => { calls.push(`wait:${sessionID}`); },
      },
      tool: { transform: vi.fn() },
      command: { transform: vi.fn() },
    } as any;

    const setup = createSetup(async (input: any) => {
      await input.client.session.promptAsync({
        path: { id: 'ses_1' },
        body: { parts: [{ type: 'text', text: 'job done' }] },
      });
      return { dispose: vi.fn() };
    });
    await setup(ctx);

    expect(calls).toEqual(['wait:ses_1', 'ses_1']);
    await setup(ctx).then((dispose) => dispose());
  });

  it('does not submit when the host exposes no idle signal', async () => {
    const ctx = {
      location: { directory: '/tmp/project' },
      options: {},
      session: { prompt: vi.fn(), synthetic: vi.fn() },
      tool: { transform: vi.fn() },
      command: { transform: vi.fn() },
    } as any;

    const setup = createSetup(async (input: any) => {
      await input.client.session.promptAsync({ path: { id: 'ses_1' }, body: { parts: [] } });
      return { dispose: vi.fn() };
    });
    await setup(ctx);

    expect(ctx.session.synthetic).not.toHaveBeenCalled();
  });

  it('does not submit when the idle wait fails', async () => {
    const synthetic = vi.fn();
    const ctx = {
      location: { directory: '/tmp/project' },
      options: {},
      session: {
        prompt: vi.fn(),
        synthetic,
        wait: async () => { throw new Error('404 session not found'); },
      },
      tool: { transform: vi.fn() },
      command: { transform: vi.fn() },
    } as any;

    const setup = createSetup(async (input: any) => {
      await input.client.session.promptAsync({ path: { id: 'ses_1' }, body: { parts: [] } });
      return { dispose: vi.fn() };
    });
    await setup(ctx);

    expect(synthetic).not.toHaveBeenCalled();
  });

  it('still forwards directory and worktree to the v1 server factory', async () => {
    const ctx = {
      location: { directory: '/tmp/project' },
      options: {},
      session: { prompt: vi.fn(), synthetic: vi.fn(), wait: vi.fn() },
      tool: { transform: vi.fn() },
      command: { transform: vi.fn() },
    } as any;
    const factory = vi.fn(async () => ({ dispose: vi.fn() }));

    await createSetup(factory)(ctx);

    expect(factory.mock.calls[0][0]).toMatchObject({ directory: '/tmp/project', worktree: '/tmp/project' });
    expect(serverInput.client.session.promptAsync).not.toHaveBeenCalled();
  });
});