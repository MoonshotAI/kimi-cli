/**
 * DenwaRenji — corresponds to Python soul/denwarenji.py
 * Manages D-Mail (time-leap mail) sending and checkpoint-based context reversal.
 */

export interface DMail {
	/** The message to send. */
	readonly message: string;
	/** The checkpoint to send the message back to. Must be >= 0. */
	readonly checkpointId: number;
}

export class DenwaRenjiError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DenwaRenjiError";
	}
}

export class DenwaRenji {
	private _pendingDmail: DMail | undefined = undefined;
	private _nCheckpoints: number = 0;

	/** Send a D-Mail. Intended to be called by the SendDMail tool. */
	sendDmail(dmail: DMail): void {
		if (this._pendingDmail !== undefined) {
			throw new DenwaRenjiError("Only one D-Mail can be sent at a time");
		}
		if (dmail.checkpointId < 0) {
			throw new DenwaRenjiError("The checkpoint ID can not be negative");
		}
		if (dmail.checkpointId >= this._nCheckpoints) {
			throw new DenwaRenjiError("There is no checkpoint with the given ID");
		}
		this._pendingDmail = dmail;
	}

	/** Set the number of checkpoints. Intended to be called by the soul. */
	setNCheckpoints(nCheckpoints: number): void {
		this._nCheckpoints = nCheckpoints;
	}

	/** Fetch a pending D-Mail. Intended to be called by the soul. */
	fetchPendingDmail(): DMail | undefined {
		const pending = this._pendingDmail;
		this._pendingDmail = undefined;
		return pending;
	}
}
