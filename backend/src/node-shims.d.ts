declare module 'node:crypto' {
  export function createHash(algorithm: string): {
    update(input: string): { digest(format: 'hex'): string };
  };
}

declare module 'node:fs' {
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string, encoding: string): string;
}

declare module 'node:http' {
  export type IncomingMessage = {
    method?: string;
    url?: string;
    headers: Record<string, string | string[] | undefined>;
    socket: { remoteAddress?: string };
    destroy(): void;
    on(event: string, handler: (...args: any[]) => void): void;
  };

  export type ServerResponse = {
    writeHead(statusCode: number, headers?: Record<string, string>): void;
    end(chunk?: string): void;
  };

  export function createServer(
    handler: (
      req: IncomingMessage,
      res: ServerResponse,
    ) => void | Promise<void>,
  ): {
    requestTimeout: number;
    keepAliveTimeout: number;
    headersTimeout: number;
    listen(port: number, callback?: () => void): void;
  };
}

declare module 'node:path' {
  export function dirname(path: string): string;
  export function resolve(...paths: string[]): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: string): string;
}

declare const process: {
  env: Record<string, string | undefined>;
  cwd(): string;
};

declare const Buffer: {
  isBuffer(value: unknown): value is BufferLike;
  from(value: string): BufferLike;
  concat(chunks: BufferLike[]): {
    toString(encoding: string): string;
  };
};

type BufferLike = {
  length: number;
  toString(encoding?: string): string;
};
