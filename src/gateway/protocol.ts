export type GatewayClientMessage =
  | {
      type: 'input';
      text: string;
    }
  | {
      type: 'close';
    };

export type GatewayServerMessage =
  | {
      type: 'hello';
      sessionId: string;
    }
  | {
      type: 'output';
      lines: string[];
    }
  | {
      type: 'exit';
    }
  | {
      type: 'error';
      message: string;
    };
