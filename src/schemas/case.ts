import { z } from "zod";

export const CaseRequestSchema = z.object({
  case_id: z.string().min(1),
  invoice_reference: z.string().min(1),
  vendor_id: z.string().min(1),
  amount: z.number().positive(),
  currency: z.string().length(3),
  // Optional: a PO-backed invoice supplies this; a non-PO invoice
  // (statutory charge, emergency purchase, etc. — see FIN-POL-012)
  // legitimately omits it. Never inferred from notes/attachment text.
  po_reference: z.string().min(1).optional(),
  notes: z.string().optional(),
  attachments: z
    .array(
      z.object({
        filename: z.string().min(1),
        content: z.string(),
      }),
    )
    .optional(),
});

export type CaseRequest = z.infer<typeof CaseRequestSchema>;
