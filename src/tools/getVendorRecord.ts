import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  GetVendorRecordInputSchema,
  GetVendorRecordOutputSchema,
  type GetVendorRecordOutput,
} from "../schemas/tools.js";

export class VendorNotFoundError extends Error {
  constructor(public readonly vendorId: string) {
    super(`Vendor record not found: ${vendorId}`);
    this.name = "VendorNotFoundError";
  }
}

export async function getVendorRecord(rawInput: unknown): Promise<GetVendorRecordOutput> {
  const input = GetVendorRecordInputSchema.parse(rawInput);
  const fixturePath = path.resolve(
    process.cwd(),
    "fixtures",
    "vendors",
    `${input.vendor_id}.json`,
  );

  let raw: string;
  try {
    raw = await readFile(fixturePath, "utf-8");
  } catch (err: any) {
    if (err.code === "ENOENT") throw new VendorNotFoundError(input.vendor_id);
    throw err;
  }

  return GetVendorRecordOutputSchema.parse(JSON.parse(raw));
}
