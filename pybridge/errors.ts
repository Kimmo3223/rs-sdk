/** An error the bridge reports to Python with a machine-readable code. */
export class BridgeError extends Error {
    constructor(message: string, readonly code: string) {
        super(message);
        this.name = 'BridgeError';
    }
}
