/**
 * Base error class for the kaos package.
 */
export class KaosError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KaosError';
  }
}

/**
 * Equivalent to Python's ValueError — indicates an invalid argument was passed.
 */
export class KaosValueError extends KaosError {
  constructor(message: string) {
    super(message);
    this.name = 'KaosValueError';
  }
}

/**
 * Equivalent to Python's FileExistsError — indicates a file or directory already exists.
 */
export class KaosFileExistsError extends KaosError {
  constructor(message: string) {
    super(message);
    this.name = 'KaosFileExistsError';
  }
}
