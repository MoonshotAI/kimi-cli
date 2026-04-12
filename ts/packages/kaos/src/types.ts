/**
 * KAOS stat result, mirroring Python's os.stat_result fields.
 */
export interface StatResult {
  stMode: number;
  stIno: number;
  stDev: number;
  stNlink: number;
  stUid: number;
  stGid: number;
  stSize: number;
  stAtime: number;
  stMtime: number;
  stCtime: number;
}
