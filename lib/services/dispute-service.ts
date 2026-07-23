/**
 * Dispute resolution domain layer — schemas, types, and pure helpers.
 * Persistence is handled by the tRPC dispute router + Prisma.
 */

import { z } from 'zod';

// ── Zod schemas (validation) ─────────────────────────────────────────────────

export const disputeCategorySchema = z.enum([
  'payment',
  'delivery',
  'quality',
  'communication',
  'other',
]);
export type DisputeCategory = z.infer<typeof disputeCategorySchema>;

export const disputeStatusSchema = z.enum([
  'filed',
  'evidence',
  'mediation',
  'community_vote',
  'resolved',
  'appealed',
  'closed',
]);
export type DisputeStatus = z.infer<typeof disputeStatusSchema>;

export const fileDisputeInputSchema = z.object({
  title: z.string().min(8, 'Title must be at least 8 characters').max(200),
  description: z
    .string()
    .min(40, 'Please describe the issue in at least 40 characters')
    .max(8000),
  category: disputeCategorySchema,
  relatedOrderId: z.string().min(1, 'Order or project reference is required').max(120),
  counterpartyId: z.string().min(1, 'Counterparty user id is required').max(120),
  counterpartyName: z.string().min(1).max(200).optional(),
  escrowAmountCents: z.number().int().min(0).max(1_000_000_000).default(0),
});
export type FileDisputeInput = z.infer<typeof fileDisputeInputSchema>;

/** Form: dollars as string; map to cents before calling the tRPC mutation. */
export const disputeFormInputSchema = fileDisputeInputSchema
  .omit({ escrowAmountCents: true })
  .extend({
    escrowDollars: z.string().optional().default(''),
  });
export type DisputeFormInput = z.infer<typeof disputeFormInputSchema>;

export function toFileDisputeInput(form: DisputeFormInput): FileDisputeInput {
  const raw = parseFloat(form.escrowDollars?.trim() || '0');
  const escrowAmountCents = Number.isFinite(raw)
    ? Math.min(1_000_000_000, Math.max(0, Math.round(raw * 100)))
    : 0;
  return fileDisputeInputSchema.parse({
    title: form.title,
    description: form.description,
    category: form.category,
    relatedOrderId: form.relatedOrderId,
    counterpartyId: form.counterpartyId,
    counterpartyName: form.counterpartyName,
    escrowAmountCents,
  });
}

export const evidenceMetadataSchema = z.object({
  fileName: z.string().min(1).max(500),
  mimeType: z.string().min(1).max(200),
  byteSize: z.number().int().min(1).max(25 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i, 'Invalid SHA-256 digest'),
  note: z.string().max(2000).optional(),
});
export type EvidenceMetadata = z.infer<typeof evidenceMetadataSchema>;

export const communityVoteSchema = z.object({
  userId: z.string().min(1),
  side: z.enum(['client', 'creator']),
});
export type CommunityVoteInput = z.infer<typeof communityVoteSchema>;

export const appealInputSchema = z.object({
  reason: z.string().min(20).max(4000),
});
export type AppealInput = z.infer<typeof appealInputSchema>;

// ── Types ────────────────────────────────────────────────────────────────────

export type UserRole = 'USER' | 'CLIENT' | 'CREATOR' | 'ADMIN';

export interface EvidenceItem extends EvidenceMetadata {
  id: string;
  submittedByUserId: string;
  submittedByLabel: string;
  submittedAt: string;
  caption?: string;
}

export type ResolutionOutcome =
  | 'favor_client'
  | 'favor_creator'
  | 'split'
  | 'dismissed';

export interface DisputeResolution {
  outcome: ResolutionOutcome;
  summary: string;
  templateId?: string;
  resolvedBy?: string;
  resolvedAt: string;
}

export interface DisputeAppeal {
  status: 'pending' | 'reviewed';
  reason: string;
  submittedAt: string;
  reviewedAt?: string;
  outcome?: 'upheld' | 'denied';
}

export interface DisputeRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  filedByUserId: string;
  filedByName: string;
  counterpartyId: string;
  counterpartyName: string;
  relatedOrderId: string;
  title: string;
  description: string;
  category: DisputeCategory;
  status: DisputeStatus;
  evidence: EvidenceItem[];
  mediationNotes: string[];
  assignedAdminId?: string;
  communityVotes: Array<{
    userId: string;
    side: 'client' | 'creator';
    castAt: string;
  }>;
  resolution?: DisputeResolution;
  appeal?: DisputeAppeal;
  escrow: {
    held: boolean;
    amountCents: number;
    holdStartedAt?: string;
    releasedAt?: string;
  };
  timeline: Array<{ at: string; message: string }>;
  preventionTags: string[];
}

export interface DisputeResolutionTemplate {
  id: string;
  label: string;
  outcome: ResolutionOutcome;
  body: string;
}

export const DISPUTE_RESOLUTION_TEMPLATES: DisputeResolutionTemplate[] = [
  {
    id: 'tpl_release_client',
    label: 'Release escrow to client (non-delivery)',
    outcome: 'favor_client',
    body: 'After review, deliverables were incomplete or not provided per agreement. Escrow is released to the client; the creator may appeal with additional evidence.',
  },
  {
    id: 'tpl_release_creator',
    label: 'Release escrow to creator (work accepted)',
    outcome: 'favor_creator',
    body: 'Deliverables met the agreed scope. Escrow is released to the creator. The client may appeal only with new material evidence.',
  },
  {
    id: 'tpl_split',
    label: 'Partial refund / split',
    outcome: 'split',
    body: 'Both parties contributed to the issue. A partial split of escrow is applied per platform policy. Details were communicated to both sides.',
  },
  {
    id: 'tpl_dismiss',
    label: 'Dismiss — no policy breach',
    outcome: 'dismissed',
    body: 'No breach of platform terms was found. Parties are encouraged to continue work or cancel per contract. Escrow handling follows the original milestone rules.',
  },
];

// ── Pure helpers (no side effects) ───────────────────────────────────────────

/** SHA-256 hex digest for evidence integrity (browser + Node test env). */
export async function hashEvidenceBytes(buf: ArrayBuffer): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('Web Crypto is not available');
  }
  const digest = await subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function parseFileDisputeInput(raw: unknown): FileDisputeInput {
  return fileDisputeInputSchema.parse(raw);
}

export function parseEvidenceMetadata(raw: unknown): EvidenceMetadata {
  return evidenceMetadataSchema.parse(raw);
}

export function verifyEvidenceDigest(
  meta: EvidenceMetadata,
  fileBytes: ArrayBuffer,
): Promise<boolean> {
  return hashEvidenceBytes(fileBytes).then(
    (h) => h.toLowerCase() === meta.sha256.toLowerCase(),
  );
}
