import { describe, expect, it, vi } from 'vitest';
import { InputController, type InputControllerPort } from '../../src/session/input-controller.js';

function createPort(overrides: Partial<InputControllerPort> = {}): InputControllerPort {
  return {
    appendUserInput: vi.fn(),
    hasPendingExecutorRegisterWizard: vi.fn().mockReturnValue(false),
    handlePendingExecutorRegisterWizard: vi.fn().mockResolvedValue(false),
    handleCommand: vi.fn().mockResolvedValue(false),
    handleNaturalLanguageInput: vi.fn().mockResolvedValue(undefined),
    waitForAsyncWork: vi.fn().mockResolvedValue(undefined),
    handleSubmitError: vi.fn(),
    ...overrides,
  };
}

describe('InputController', () => {
  it('ignores blank input without echoing or routing', async () => {
    const port = createPort();
    const controller = new InputController(port);

    const result = await controller.submit('   ');

    expect(result.exitRequested).toBe(false);
    expect(port.appendUserInput).not.toHaveBeenCalled();
    expect(port.handleCommand).not.toHaveBeenCalled();
    expect(port.handleNaturalLanguageInput).not.toHaveBeenCalled();
  });

  it('routes slash commands through the command handler and waits when requested', async () => {
    const port = createPort({
      handleCommand: vi.fn().mockResolvedValue(true),
    });
    const controller = new InputController(port);

    const result = await controller.submit('  /exit  ', { awaitAsyncWork: true });

    expect(port.appendUserInput).toHaveBeenCalledWith('/exit');
    expect(port.handleCommand).toHaveBeenCalledWith('/exit');
    expect(port.handleNaturalLanguageInput).not.toHaveBeenCalled();
    expect(port.waitForAsyncWork).toHaveBeenCalledTimes(1);
    expect(result.exitRequested).toBe(true);
  });

  it('routes non-command input to natural language handling', async () => {
    const port = createPort();
    const controller = new InputController(port);

    await controller.submit('继续刚才的任务');

    expect(port.appendUserInput).toHaveBeenCalledWith('继续刚才的任务');
    expect(port.handleNaturalLanguageInput).toHaveBeenCalledWith('继续刚才的任务');
    expect(port.handleCommand).not.toHaveBeenCalled();
  });

  it('lets a pending executor register wizard consume non-command input first', async () => {
    const port = createPort({
      hasPendingExecutorRegisterWizard: vi.fn().mockReturnValue(true),
    });
    const controller = new InputController(port);

    await controller.submit('research-bot');

    expect(port.handlePendingExecutorRegisterWizard).toHaveBeenCalledWith('research-bot');
    expect(port.handleCommand).not.toHaveBeenCalled();
    expect(port.handleNaturalLanguageInput).not.toHaveBeenCalled();
  });

  it('reports routing errors and still waits for async work when requested', async () => {
    const error = new Error('boom');
    const port = createPort({
      handleNaturalLanguageInput: vi.fn().mockRejectedValue(error),
    });
    const controller = new InputController(port);

    const result = await controller.submit('执行任务', { awaitAsyncWork: true });

    expect(port.handleSubmitError).toHaveBeenCalledWith(error);
    expect(port.waitForAsyncWork).toHaveBeenCalledTimes(1);
    expect(result.exitRequested).toBe(false);
  });
});
