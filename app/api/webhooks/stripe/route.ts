import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'

import {
  findEscrowByPaymentIntent,
  markFundedAuthorized,
} from '@/lib/payments/escrow-service'
import { getStripe, getStripeWebhookSecret } from '@/lib/payments/stripe'
import {
  redisDel,
  redisSet,
  redisSetIfAbsent,
  redisSlidingWindowRateLimit,
} from '@/lib/storage/redis'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const STRIPE_WEBHOOK_RATE_LIMIT = 10
const STRIPE_WEBHOOK_RATE_LIMIT_WINDOW_SECONDS = 1
const STRIPE_WEBHOOK_IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60
const STRIPE_WEBHOOK_LOCK_TTL_SECONDS = 60

function getClientIp(request: NextRequest): string {
  const forwardedFor = request.headers.get('x-forwarded-for')
  if (forwardedFor) {
    return forwardedFor.split(',')[0]?.trim() || 'unknown'
  }

  return request.headers.get('x-real-ip') || 'unknown'
}

function getStripeWebhookIdempotencyKey(event: Stripe.Event): string {
  const accountScope = event.account ?? 'platform'
  return `stripe:webhook:processed:${accountScope}:${event.id}`
}

function getStripeWebhookRateLimitKey(ip: string): string {
  return `stripe:webhook:rl:${ip}`
}

/**
 * Process a Stripe webhook event and update escrow state accordingly.
 *
 * On `payment_intent.amount_capturable_updated` we transition the
 * linked escrow to `funded_authorized` so the release flow can proceed.
 */
export async function processStripeWebhookEvent(
  event: Stripe.Event,
): Promise<void> {
  if (event.type !== 'payment_intent.amount_capturable_updated') {
    return
  }

  const pi = event.data.object as Stripe.PaymentIntent

  // Prefer explicit escrowId in metadata
  const escrowId = pi.metadata?.escrowId as string | undefined
  if (escrowId) {
    await markFundedAuthorized(escrowId)
    return
  }

  // Fallback: resolve escrow by payment intent ID
  const escrow = await findEscrowByPaymentIntent(pi.id)
  if (escrow) {
    await markFundedAuthorized(escrow.id)
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const clientIp = getClientIp(request)
  const rateLimit = await redisSlidingWindowRateLimit(
    getStripeWebhookRateLimitKey(clientIp),
    STRIPE_WEBHOOK_RATE_LIMIT,
    STRIPE_WEBHOOK_RATE_LIMIT_WINDOW_SECONDS,
  )

  if (rateLimit && !rateLimit.allowed) {
    console.warn('[stripe:webhook] rate limited', {
      ip: clientIp,
      count: rateLimit.count,
      limit: STRIPE_WEBHOOK_RATE_LIMIT,
    })
    return NextResponse.json(
      { error: 'Rate limit exceeded' },
      { status: 429 },
    )
  }

  const rawBody = await request.text()
  const signature = request.headers.get('stripe-signature')
  if (!signature) {
    return NextResponse.json(
      { error: 'Missing Stripe-Signature header' },
      { status: 401 },
    )
  }

  let webhookSecret: string
  try {
    webhookSecret = await getStripeWebhookSecret()
  } catch (error) {
    console.error('[stripe:webhook] missing webhook secret', error)
    return NextResponse.json(
      { error: 'Stripe webhook secret is not configured' },
      { status: 500 },
    )
  }

  let stripe: Stripe
  try {
    stripe = await getStripe()
  } catch (error) {
    console.error('[stripe:webhook] unable to create Stripe client', error)
    return NextResponse.json(
      { error: 'Stripe client is not configured' },
      { status: 500 },
    )
  }

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret)
  } catch (error) {
    console.warn('[stripe:webhook] invalid signature', {
      ip: clientIp,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    return NextResponse.json(
      { error: 'Invalid Stripe signature' },
      { status: 401 },
    )
  }

  const idempotencyKey = getStripeWebhookIdempotencyKey(event)
  const acquired = await redisSetIfAbsent(
    idempotencyKey,
    {
      status: 'processing',
      eventId: event.id,
      account: event.account ?? 'platform',
      receivedAt: new Date().toISOString(),
    },
    STRIPE_WEBHOOK_LOCK_TTL_SECONDS,
  )

  if (acquired === false) {
    console.info('[stripe:webhook] duplicate event ignored', {
      eventId: event.id,
      eventType: event.type,
      account: event.account ?? 'platform',
      ip: clientIp,
      outcome: 'duplicate',
    })
    return NextResponse.json({ received: true, duplicate: true })
  }

  console.info('[stripe:webhook] event received', {
    eventId: event.id,
    eventType: event.type,
    account: event.account ?? 'platform',
    ip: clientIp,
    outcome: 'verified',
  })

  try {
    await processStripeWebhookEvent(event)
    await redisSet(
      idempotencyKey,
      {
        status: 'processed',
        eventId: event.id,
        account: event.account ?? 'platform',
        receivedAt: new Date().toISOString(),
      },
      STRIPE_WEBHOOK_IDEMPOTENCY_TTL_SECONDS,
    )

    console.info('[stripe:webhook] event processed', {
      eventId: event.id,
      eventType: event.type,
      account: event.account ?? 'platform',
      ip: clientIp,
      outcome: 'processed',
    })

    return NextResponse.json({ received: true })
  } catch (error) {
    await redisDel(idempotencyKey)

    console.error('[stripe:webhook] processing failed', {
      eventId: event.id,
      eventType: event.type,
      account: event.account ?? 'platform',
      ip: clientIp,
      error: error instanceof Error ? error.message : 'Unknown error',
    })

    return NextResponse.json(
      { error: 'Failed to process Stripe webhook event' },
      { status: 500 },
    )
  }
}
