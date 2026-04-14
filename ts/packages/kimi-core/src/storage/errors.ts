export class IncompatibleVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IncompatibleVersionError';
  }
}

export class UnknownRecordTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnknownRecordTypeError';
  }
}

export class JsonParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JsonParseError';
  }
}

export class WireJournalCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WireJournalCorruptError';
  }
}

/** Lifecycle states under which `JournalWriter.append` is rejected (§5.8.2). */
export type LifecycleGatedState = 'compacting' | 'completing';

export class JournalGatedError extends Error {
  readonly state: LifecycleGatedState;
  readonly recordType: string;

  constructor(state: LifecycleGatedState, recordType: string, message?: string) {
    super(
      message ??
        `wire.jsonl write rejected: lifecycle state is "${state}" (record type: ${recordType})`,
    );
    this.name = 'JournalGatedError';
    this.state = state;
    this.recordType = recordType;
  }
}
