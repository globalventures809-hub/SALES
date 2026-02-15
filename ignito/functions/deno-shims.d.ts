// Deno + std/http shims for editor TypeScript (only for local type-checking in VS Code)
declare module "https://deno.land/std@0.201.0/http/server.ts" {
  export function serve(handler: (req: Request) => Response | Promise<Response>): void;
}

declare const Deno: {
  env: {
    get(key: string): string | undefined;
  };
};
