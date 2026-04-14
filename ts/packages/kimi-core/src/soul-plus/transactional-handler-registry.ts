/**
 * TransactionalHandlerRegistry — placeholder for Slice 5 (v2 §5.2 prose).
 *
 * Slice 5 will populate this with real transactional wire-method handlers
 * (`setModel` / `getUsage` / `rename` / `getHistory` / ...). Slice 3 only
 * needs the class to exist so SoulPlus can hold an instance; `register`
 * and `get` already behave as a minimal Map-backed registry so Slice 5
 * can start wiring real handlers without another stub round.
 */

export type TransactionalHandler = (req: unknown) => unknown;

export class TransactionalHandlerRegistry {
  private readonly handlers = new Map<string, TransactionalHandler>();

  register(method: string, handler: TransactionalHandler): void {
    this.handlers.set(method, handler);
  }

  get(method: string): TransactionalHandler | undefined {
    return this.handlers.get(method);
  }
}
