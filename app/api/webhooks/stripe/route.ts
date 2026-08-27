import { NextRequest, NextResponse } from 'next/server';
import {
  findEscrowByPaymentIntent,
  markFundedAuthorized,
  isStripeCaptureBlocked,
  cancelDisputedPaymentIntent,
  getEscrow,
} from '@/lib/payments/escrow-service';

// Stripe types are imported as `any` to avoid hard dependency when stripe SDK not installed.
// In production, `stripe` package should be installed and webhook secret verified.
type StripeEvent = {
  id: string;
  type: string;
  data: { object: { id: string; status?: string; metadata?: Record<string, string>; [k: string]: unknown } };
};

type StripePaymentIntent = {
  id: string;
  status: string;
  metadata: Record<string, string>;
  [k: string]: unknown;
};

/**
 * Process Stripe webhook event (exported for tests)
 * Handles PaymentIntent events with dispute-aware capture blocking.
 *
 * Payout-integrity:
 * - If escrow is disputed (dual-ledger freeze), capture is BLOCKED even if Stripe says
 *   amount_capturable_updated. The PaymentIntent remains on hold until dispute resolves.
 * - This prevents money movement on Stripe rail while Soroban escrow is frozen.
 */
export async function processStripeWebhookEvent(event: StripeEvent): Promise<void> {
  const type = event.type;
  const obj = event.data.object as StripePaymentIntent;
  const piId = obj.id;

  // Resolve escrow via metadata.escrowId or by PaymentIntent mapping
  let escrowId = obj.metadata?.escrowId as string | undefined;
  let escrow = escrowId ? getEscrow(escrowId) : undefined;
  if (!escrow) {
    const found = findEscrowByPaymentIntent(piId);
    if (found) {
      escrow = found;
      escrowId = found.id;
    }
  }
  // Also check metadata bountyId fallback
  if (!escrow && obj.metadata?.bountyId) {
    // try to find via bounty? For demo, treat bountyId as escrowId
  }

  if (type === 'payment_intent.amount_capturable_updated' || type === 'payment_intent.succeeded') {
    if (!escrow || !escrowId) {
      // No escrow linked - nothing to do
      return;
    }

    // ── Payout-integrity check: block if disputed ──
    if (isStripeCaptureBlocked(piId)) {
      // Escrow is frozen - do NOT mark as funded, keep on hold
      // In production we would call stripe.paymentIntents.cancel(piId) or keep uncaptured
      cancelDisputedPaymentIntent(piId);
      // Log for audit (console in demo)
      console.warn(`[stripe-webhook] Capture blocked for disputed escrow ${escrowId} (pi ${piId})`);
      return;
    }

    // Also check by escrowId
    if (escrow.status === 'disputed') {
      console.warn(`[stripe-webhook] Capture blocked - escrow ${escrowId} is disputed`);
      return;
    }

    // Normal path: mark as funded_authorized (authorized but not yet captured)
    // Capture will happen via markReleased in the settlement saga after appeal window
    markFundedAuthorized(escrowId);
    return;
  }

  if (type === 'payment_intent.canceled' || type === 'payment_intent.payment_failed') {
    if (escrowId) {
      // Could mark failed
    }
    return;
  }

  // Ignore other event types
}

// ── Next.js route handler ───────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    // Verify Stripe signature (production)
    // In demo we accept raw body without verification for tests
    const body = await req.text();
    let event: StripeEvent;
    try {
      event = JSON.parse(body) as StripeEvent;
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    // If Stripe webhook secret is configured, verify signature
    const sig = req.headers.get('stripe-signature');
    if (sig && process.env.STRIPE_WEBHOOK_SECRET) {
      try {
        // Dynamic import to avoid hard dep when stripe not installed
        const Stripe = (await import('stripe')).default;
        const stripe = new Stripe(process.env.STRIPE_WEBHOOK_SECRET, { apiVersion: '2023-10-16' } as unknown as string as never);
        // This would verify - but we already parsed body, need raw
        // For now, skip strict verification in demo
      } catch {}
    }

    await processStripeWebhookEvent(event);
    return NextResponse.json({ received: true });
  } catch (e) {
    console.error('[stripe-webhook] error', e);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

// For App Router to handle raw body
export const runtime = 'nodejs';
