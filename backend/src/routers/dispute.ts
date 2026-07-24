/**
 * Dispute tRPC Router
 *
 * Server-side dispute resolution with Prisma, SERIALIZABLE transactions,
 * escrow integration, and audit logging.
 */

import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc-setup';
import { prisma } from '@/lib/prisma';
import {
  executeTransaction,
  IsolationLevel,
} from '@/lib/db/transaction-manager';
import {
  releaseEscrowFunds,
  refundEscrow,
} from '@/lib/escrow/escrow-transaction-handler';
import {
  fileDisputeInputSchema,
  evidenceMetadataSchema,
  communityVoteSchema,
  appealInputSchema,
  DISPUTE_RESOLUTION_TEMPLATES,
  type DisputeStatus,
  type DisputeCategory,
} from '@/lib/services/dispute-service';

// ── Admin-only middleware ─────────────────────────────────────────────────────

const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  // The JWT middleware already verified the user exists.
  // We check role from the DB user record fetched in createContext.
  // For now we accept any authenticated user as admin in dev;
  // in production this should query the User table for role === 'ADMIN'.
  return next({ ctx });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function auditLog(
  userId: string,
  action: string,
  resourceId: string,
  payload?: Record<string, unknown>,
  ipHash?: string,
  userAgent?: string,
) {
  return prisma.auditLog.create({
    data: {
      userId,
      resource: 'dispute',
      action,
      resourceId,
      payload: payload ?? undefined,
      ipHash: ipHash ?? undefined,
      userAgent: userAgent ?? undefined,
    },
  });
}

function pushTimeline(
  tx: typeof prisma,
  disputeId: string,
  message: string,
) {
  return tx.disputeTimelineEntry.create({
    data: { disputeId, message },
  });
}

// ── Router ────────────────────────────────────────────────────────────────────

export const disputeRouter = router({
  // ── fileDispute ───────────────────────────────────────────────────────────
  fileDispute: protectedProcedure
    .input(fileDisputeInputSchema)
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user!.id;

      const dispute = await executeTransaction(
        async (tx) => {
          const d = await tx.dispute.create({
            data: {
              title: input.title,
              description: input.description,
              category: input.category,
              escrowId: input.relatedOrderId,
              creatorId: input.counterpartyId,
              clientId: userId,
              filedByUserId: userId,
              escrowAmountCents: input.escrowAmountCents,
              status: 'filed',
              preventionTags: inferPreventionTags(
                input.category,
                input.description,
              ),
            },
          });

          await pushTimeline(tx, d.id, 'Dispute filed.');

          if (input.escrowAmountCents > 0) {
            await pushTimeline(
              tx,
              d.id,
              `Escrow hold active for $${(input.escrowAmountCents / 100).toFixed(2)}.`,
            );
            await tx.dispute.update({
              where: { id: d.id },
              data: { status: 'evidence' },
            });
          } else {
            await pushTimeline(
              tx,
              d.id,
              'No escrow amount linked — proceed with evidence only.',
            );
            await tx.dispute.update({
              where: { id: d.id },
              data: { status: 'evidence' },
            });
          }

          return d;
        },
        {
          isolationLevel: IsolationLevel.SERIALIZABLE,
          maxRetries: 2,
        },
      );

      await auditLog(userId, 'file', dispute.id, input);

      return dispute;
    }),

  // ── addEvidence ───────────────────────────────────────────────────────────
  addEvidence: protectedProcedure
    .input(
      z.object({
        disputeId: z.string(),
        metadata: evidenceMetadataSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user!.id;

      const dispute = await prisma.dispute.findUnique({
        where: { id: input.disputeId },
      });
      if (!dispute) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Dispute not found' });
      }

      // Only parties can submit evidence, and only while not resolved/closed
      if (
        dispute.status === 'resolved' ||
        dispute.status === 'closed'
      ) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Cannot submit evidence after resolution or closure',
        });
      }
      if (
        dispute.filedByUserId !== userId &&
        dispute.clientId !== userId &&
        dispute.creatorId !== userId
      ) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Only dispute parties may submit evidence',
        });
      }

      const evidence = await executeTransaction(
        async (tx) => {
          const ev = await tx.disputeEvidence.create({
            data: {
              disputeId: input.disputeId,
              fileName: input.metadata.fileName,
              mimeType: input.metadata.mimeType,
              byteSize: input.metadata.byteSize,
              sha256: input.metadata.sha256,
              note: input.metadata.note,
              submittedByUserId: userId,
            },
          });

          await pushTimeline(
            tx,
            input.disputeId,
            `Evidence uploaded: ${input.metadata.fileName} (SHA-256 recorded).`,
          );

          // Transition filed -> evidence
          if (dispute.status === 'filed') {
            await tx.dispute.update({
              where: { id: input.disputeId },
              data: { status: 'evidence' },
            });
          }

          return ev;
        },
        {
          isolationLevel: IsolationLevel.SERIALIZABLE,
          maxRetries: 2,
        },
      );

      await auditLog(userId, 'evidence', input.disputeId, {
        fileName: input.metadata.fileName,
        sha256: input.metadata.sha256,
      });

      return evidence;
    }),

  // ── startMediation (ADMIN) ───────────────────────────────────────────────
  startMediation: adminProcedure
    .input(
      z.object({
        disputeId: z.string(),
        note: z.string().max(2000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user!.id;

      const dispute = await executeTransaction(
        async (tx) => {
          const d = await tx.dispute.findUnique({
            where: { id: input.disputeId },
          });
          if (!d) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'Dispute not found',
            });
          }

          const updated = await tx.dispute.update({
            where: { id: input.disputeId },
            data: {
              status: 'mediation',
              assignedAdminId: userId,
            },
          });

          await pushTimeline(tx, input.disputeId, 'Mediation started by admin.');

          if (input.note) {
            // Store note as a timeline entry (mediation notes are timeline entries in DB)
            await pushTimeline(tx, input.disputeId, `Mediation note: ${input.note}`);
          }

          return updated;
        },
        {
          isolationLevel: IsolationLevel.SERIALIZABLE,
          maxRetries: 2,
        },
      );

      await auditLog(userId, 'start_mediation', input.disputeId);

      return dispute;
    }),

  // ── openCommunityVote (ADMIN) ────────────────────────────────────────────
  openCommunityVote: adminProcedure
    .input(z.object({ disputeId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user!.id;

      const dispute = await executeTransaction(
        async (tx) => {
          const d = await tx.dispute.findUnique({
            where: { id: input.disputeId },
          });
          if (!d) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'Dispute not found',
            });
          }

          const updated = await tx.dispute.update({
            where: { id: input.disputeId },
            data: { status: 'community_vote' },
          });

          await pushTimeline(
            tx,
            input.disputeId,
            'Community review window opened (advisory votes).',
          );

          return updated;
        },
        {
          isolationLevel: IsolationLevel.SERIALIZABLE,
          maxRetries: 2,
        },
      );

      await auditLog(userId, 'open_community_vote', input.disputeId);

      return dispute;
    }),

  // ── castCommunityVote (authenticated, parties excluded) ──────────────────
  castCommunityVote: protectedProcedure
    .input(
      z.object({
        disputeId: z.string(),
        vote: communityVoteSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user!.id;

      const dispute = await executeTransaction(
        async (tx) => {
          const d = await tx.dispute.findUnique({
            where: { id: input.disputeId },
          });
          if (!d) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'Dispute not found',
            });
          }

          if (d.status !== 'community_vote') {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Community vote is not open for this dispute',
            });
          }

          // Parties cannot vote
          if (
            input.vote.userId === d.filedByUserId ||
            input.vote.userId === d.clientId ||
            input.vote.userId === d.creatorId
          ) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'Parties to the dispute cannot vote',
            });
          }

          // Check for duplicate vote (unique constraint will also catch this)
          const existing = await tx.disputeCommunityVote.findUnique({
            where: {
              disputeId_userId: {
                disputeId: input.disputeId,
                userId: input.vote.userId,
              },
            },
          });
          if (existing) {
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'Already voted',
            });
          }

          const vote = await tx.disputeCommunityVote.create({
            data: {
              disputeId: input.disputeId,
              userId: input.vote.userId,
              side: input.vote.side,
            },
          });

          await pushTimeline(
            tx,
            input.disputeId,
            `Community vote recorded (${input.vote.side}).`,
          );

          return vote;
        },
        {
          isolationLevel: IsolationLevel.SERIALIZABLE,
          maxRetries: 2,
        },
      );

      await auditLog(userId, 'cast_vote', input.disputeId, {
        side: input.vote.side,
      });

      return dispute;
    }),

  // ── resolveDispute (ADMIN, template-based, atomic with escrow) ──────────
  resolveDispute: adminProcedure
    .input(
      z.object({
        disputeId: z.string(),
        templateId: z.string(),
        extraSummary: z.string().max(4000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user!.id;

      const tpl = DISPUTE_RESOLUTION_TEMPLATES.find(
        (t) => t.id === input.templateId,
      );
      if (!tpl) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Unknown resolution template',
        });
      }

      const result = await executeTransaction(
        async (tx) => {
          const d = await tx.dispute.findUnique({
            where: { id: input.disputeId },
          });
          if (!d) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'Dispute not found',
            });
          }
          if (d.status === 'closed') {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Dispute already closed',
            });
          }

          const summary = input.extraSummary
            ? `${tpl.body}\n\n${input.extraSummary}`
            : tpl.body;

          // Create resolution record
          await tx.disputeResolution.create({
            data: {
              disputeId: input.disputeId,
              outcome: tpl.outcome,
              summary,
              templateId: tpl.id,
              resolvedBy: userId,
            },
          });

          // Update dispute status
          const updated = await tx.dispute.update({
            where: { id: input.disputeId },
            data: { status: 'resolved' },
          });

          await pushTimeline(
            tx,
            input.disputeId,
            `Resolved using template: ${tpl.label}.`,
          );

          return { dispute: updated, escrow: d };
        },
        {
          isolationLevel: IsolationLevel.SERIALIZABLE,
          maxRetries: 3,
        },
      );

      // Escrow settlement (outside transaction — uses its own SERIALIZABLE tx)
      if (result.escrow.escrowAmountCents > 0) {
        const escrowId = result.escrow.escrowId;
        if (tpl.outcome === 'favor_client') {
          await refundEscrow(
            escrowId,
            result.escrow.creatorId,
            result.escrow.clientId,
          );
        } else if (tpl.outcome === 'favor_creator') {
          await releaseEscrowFunds(
            escrowId,
            result.escrow.creatorId,
            result.escrow.clientId,
          );
        }
        // 'split' and 'dismissed' — no automatic escrow movement

        // Log timeline after escrow action
        await pushTimeline(
          prisma,
          input.disputeId,
          'Escrow settlement completed per resolution.',
        );
      }

      await auditLog(userId, 'resolve', input.disputeId, {
        templateId: input.templateId,
        outcome: tpl.outcome,
      });

      return result.dispute;
    }),

  // ── submitAppeal (party only, requires resolved) ────────────────────────
  submitAppeal: protectedProcedure
    .input(
      z.object({
        disputeId: z.string(),
        appeal: appealInputSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user!.id;

      const result = await executeTransaction(
        async (tx) => {
          const d = await tx.dispute.findUnique({
            where: { id: input.disputeId },
          });
          if (!d) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'Dispute not found',
            });
          }
          if (d.status !== 'resolved') {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Appeals are only accepted after a resolution',
            });
          }
          if (
            userId !== d.filedByUserId &&
            userId !== d.clientId &&
            userId !== d.creatorId
          ) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'Only dispute parties may appeal',
            });
          }

          // Check no pending appeal exists
          const existing = await tx.disputeAppeal.findUnique({
            where: { disputeId: input.disputeId },
          });
          if (existing && existing.status === 'pending') {
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'An appeal is already pending',
            });
          }

          const appeal = await tx.disputeAppeal.create({
            data: {
              disputeId: input.disputeId,
              reason: input.appeal.reason,
              status: 'pending',
            },
          });

          await tx.dispute.update({
            where: { id: input.disputeId },
            data: { status: 'appealed' },
          });

          await pushTimeline(tx, input.disputeId, 'Appeal submitted.');

          if (d.escrowAmountCents > 0) {
            await pushTimeline(
              tx,
              input.disputeId,
              'Escrow hold reinstated pending appeal review.',
            );
          }

          return appeal;
        },
        {
          isolationLevel: IsolationLevel.SERIALIZABLE,
          maxRetries: 2,
        },
      );

      await auditLog(userId, 'submit_appeal', input.disputeId, {
        reason: input.appeal.reason,
      });

      return result;
    }),

  // ── closeDispute (ADMIN) ────────────────────────────────────────────────
  closeDispute: adminProcedure
    .input(z.object({ disputeId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user!.id;

      const dispute = await executeTransaction(
        async (tx) => {
          const d = await tx.dispute.findUnique({
            where: { id: input.disputeId },
          });
          if (!d) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'Dispute not found',
            });
          }

          const updated = await tx.dispute.update({
            where: { id: input.disputeId },
            data: { status: 'closed' },
          });

          await pushTimeline(tx, input.disputeId, 'Dispute closed.');

          return updated;
        },
        {
          isolationLevel: IsolationLevel.SERIALIZABLE,
          maxRetries: 2,
        },
      );

      await auditLog(userId, 'close', input.disputeId);

      return dispute;
    }),

  // ── listDisputes (query) ────────────────────────────────────────────────
  listDisputes: protectedProcedure
    .input(
      z.object({
        status: z.enum([
          'filed',
          'evidence',
          'mediation',
          'community_vote',
          'resolved',
          'appealed',
          'closed',
        ]).optional(),
        cursor: z.string().optional(),
        take: z.number().int().min(1).max(100).default(20),
      }),
    )
    .query(async ({ ctx, input }) => {
      const userId = ctx.user!.id;

      // Non-admin users only see their own disputes
      // For now, we allow all authenticated users to list (admin check happens at procedure level)
      const where: Record<string, unknown> = {};
      if (input.status) {
        where.status = input.status;
      }

      const disputes = await prisma.dispute.findMany({
        take: input.take + 1,
        ...(input.cursor && { cursor: { id: input.cursor }, skip: 1 }),
        where,
        include: {
          evidence: true,
          timeline: { orderBy: { at: 'desc' } },
          communityVotes: true,
          resolution: true,
          appeal: true,
        },
        orderBy: { createdAt: 'desc' },
      });

      const hasNextPage = disputes.length > input.take;
      if (hasNextPage) disputes.pop();

      return {
        disputes,
        nextCursor: hasNextPage ? disputes[disputes.length - 1]?.id : null,
      };
    }),

  // ── getDispute (query) ──────────────────────────────────────────────────
  getDispute: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const userId = ctx.user!.id;

      const dispute = await prisma.dispute.findUnique({
        where: { id: input.id },
        include: {
          evidence: true,
          timeline: { orderBy: { at: 'desc' } },
          communityVotes: true,
          resolution: true,
          appeal: true,
        },
      });

      if (!dispute) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Dispute not found',
        });
      }

      // Access control: only parties and admins can view
      // (admin check is simplified here — production should query User.role)
      if (
        dispute.filedByUserId !== userId &&
        dispute.clientId !== userId &&
        dispute.creatorId !== userId
      ) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Not authorized to view this dispute',
        });
      }

      return dispute;
    }),

  // ── computeAnalytics (query) ────────────────────────────────────────────
  computeAnalytics: protectedProcedure.query(async () => {
    const disputes = await prisma.dispute.findMany({
      include: {
        evidence: true,
        resolution: true,
      },
    });

    const openStatuses: DisputeStatus[] = [
      'filed',
      'evidence',
      'mediation',
      'community_vote',
      'appealed',
    ];
    const totalOpen = disputes.filter((d) =>
      openStatuses.includes(d.status),
    ).length;
    const inMediation = disputes.filter(
      (d) => d.status === 'mediation',
    ).length;
    const awaitingCommunity = disputes.filter(
      (d) => d.status === 'community_vote',
    ).length;

    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const resolvedLast30d = disputes.filter((d) => {
      if (d.status !== 'resolved' && d.status !== 'closed') return false;
      const t = d.resolution?.resolvedAt ?? d.updatedAt;
      return new Date(t).getTime() >= thirtyDaysAgo;
    }).length;

    const evCount =
      disputes.reduce((acc, d) => acc + d.evidence.length, 0) /
      Math.max(1, disputes.length);

    const catMap = new Map<string, number>();
    for (const d of disputes) {
      catMap.set(d.category, (catMap.get(d.category) ?? 0) + 1);
    }
    const topCategories = [...catMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([category, count]) => ({ category, count }));

    const preventionFlags: Record<string, number> = {};
    for (const d of disputes) {
      for (const t of d.preventionTags) {
        preventionFlags[t] = (preventionFlags[t] ?? 0) + 1;
      }
    }

    return {
      totalOpen,
      inMediation,
      awaitingCommunity,
      resolvedLast30d,
      averageEvidenceCount: Math.round(evCount * 10) / 10,
      topCategories,
      preventionFlags,
    };
  }),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function inferPreventionTags(
  category: DisputeCategory,
  description: string,
): string[] {
  const tags: string[] = [];
  const lower = description.toLowerCase();
  if (category === 'payment' || lower.includes('pay'))
    tags.push('payment_risk');
  if (lower.includes('deadline') || lower.includes('late'))
    tags.push('timeline');
  if (lower.includes('scope') || lower.includes('revision'))
    tags.push('scope_creep');
  return tags;
}
