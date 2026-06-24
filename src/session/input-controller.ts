export interface InputControllerSubmitOptions {
  awaitAsyncWork?: boolean;
}

export interface InputControllerSubmitResult {
  exitRequested: boolean;
}

export interface InputControllerPort {
  appendUserInput(input: string): void;
  hasPendingExecutorRegisterWizard(): boolean;
  handlePendingExecutorRegisterWizard(input: string): Promise<boolean>;
  handleCommand(input: string): Promise<boolean>;
  handleNaturalLanguageInput(input: string): Promise<void>;
  waitForAsyncWork(): Promise<void>;
  handleSubmitError(error: unknown): void;
}

export class InputController {
  constructor(private readonly port: InputControllerPort) {}

  async submit(
    rawInput: string,
    options: InputControllerSubmitOptions = {},
  ): Promise<InputControllerSubmitResult> {
    const userInput = rawInput.trim();
    if (!userInput) {
      return { exitRequested: false };
    }

    this.port.appendUserInput(userInput);

    try {
      if (this.port.hasPendingExecutorRegisterWizard() && !userInput.startsWith('/')) {
        await this.port.handlePendingExecutorRegisterWizard(userInput);
        return { exitRequested: false };
      }

      if (userInput.startsWith('/')) {
        const exitRequested = await this.port.handleCommand(userInput);
        if (options.awaitAsyncWork) {
          await this.port.waitForAsyncWork();
        }
        return { exitRequested };
      }

      await this.port.handleNaturalLanguageInput(userInput);
      if (options.awaitAsyncWork) {
        await this.port.waitForAsyncWork();
      }
      return { exitRequested: false };
    } catch (error) {
      this.port.handleSubmitError(error);
      if (options.awaitAsyncWork) {
        await this.port.waitForAsyncWork();
      }
      return { exitRequested: false };
    }
  }
}
